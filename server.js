"use strict";

// ============================================================================
// UniGestao — Core de identidade e acesso
// ----------------------------------------------------------------------------
// Este servico NAO tem regra de negocio. Ele faz tres coisas:
//   1. autentica a pessoa (login unico, com 2FA)
//   2. diz a cada modulo quem esta logado e com que papel naquele modulo
//   3. serve o Admin Geral, onde se define quem acessa o que
//
// Os sistemas (modulos) continuam independentes, cada um com seu banco e suas
// regras. Eles nunca leem este banco: perguntam pela API /api/interno/sessao.
// ============================================================================

const express = require("express");
const path = require("path");
const crypto = require("crypto");
const QRCode = require("qrcode");

const db = require("./core/db");
const auth = require("./core/auth");
const modulos = require("./core/modulos");
const correio = require("./core/email");
const perfil = require("./core/perfil");

const app = express();
app.set("trust proxy", 1);
// 2mb cobre a foto em base64 com folga: o limite real da imagem e 400 KB
// (core/perfil.js), que em base64 da ~545 KB. O resto das rotas manda JSON
// pequeno, entao o teto so existe por causa da foto.
app.use(express.json({ limit: "2mb" }));

const PORT = process.env.PORT || 3000;

// ---------------------------------------------------------------------------
// Middlewares de sessao
// ---------------------------------------------------------------------------

async function comSessao(req, res, next) {
  try {
    req.usuario = await auth.lerSessao(auth.lerToken(req));
    next();
  } catch (e) {
    next(e);
  }
}

function exigeLogin(req, res, next) {
  if (!req.usuario) return res.status(401).json({ erro: "Sessão expirada" });
  next();
}

function exigeSuperAdmin(req, res, next) {
  if (!req.usuario) return res.status(401).json({ erro: "Sessão expirada" });
  if (!req.usuario.super_admin) return res.status(403).json({ erro: "Sem permissão" });
  next();
}

app.use(comSessao);

// ---------------------------------------------------------------------------
// Paginas
// ---------------------------------------------------------------------------

const PUBLIC = path.join(__dirname, "public");

app.get("/", (req, res) => {
  res.sendFile(path.join(PUBLIC, req.usuario ? "inicio.html" : "login.html"));
});

app.get("/agenda", (req, res) => {
  if (!req.usuario) return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "agenda.html"));
});

app.get("/perfil", (req, res) => {
  if (!req.usuario) return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "perfil.html"));
});

app.get("/admin", (req, res) => {
  if (!req.usuario) return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "admin.html"));
});

app.use(express.static(PUBLIC, { index: false }));

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

app.post("/api/login", async (req, res, next) => {
  try {
    const ip = auth.ipDe(req);
    const bloqueado = await auth.ipBloqueado(ip);
    if (bloqueado) {
      return res.status(429).json({
        erro: "Muitas tentativas. Tente novamente em alguns minutos.",
      });
    }

    const email = String(req.body.email || "").toLowerCase().trim();
    const senha = String(req.body.senha || "");
    if (!email || !senha) return res.status(400).json({ erro: "Informe e-mail e senha" });

    const r = await db.query(
      "SELECT * FROM usuarios WHERE LOWER(email) = $1 AND ativo = TRUE",
      [email]
    );
    const u = r.rows[0];

    const conferiu = u ? await auth.verificarSenha(senha, u.senha) : { ok: false };

    if (!u || !conferiu.ok) {
      await auth.registrarFalha(ip);
      await auth.auditar(req, "login_falhou", { email, detalhe: { motivo: u ? "senha" : "email" } });
      // Senha em formato legado inseguro (Gestao de Eventos): orienta a redefinir
      if (conferiu.legadoInseguro) {
        return res.status(401).json({
          erro: "Sua senha precisa ser redefinida. Procure o administrador.",
          precisaRedefinir: true,
        });
      }
      return res.status(401).json({ erro: "E-mail ou senha inválidos" });
    }

    await auth.limparFalhas(ip);

    // Regrava a senha no formato novo quando veio de um sistema antigo
    if (conferiu.precisaRegravar) {
      await db.query("UPDATE usuarios SET senha = $1 WHERE id = $2", [auth.gerarHash(senha), u.id]);
      await auth.auditar(req, "senha_migrada", { usuarioId: u.id, email: u.email });
    }

    // 2FA: obrigatorio para super admin, opcional para os demais
    if (u.totp_ativo && u.totp_secret) {
      return res.json({ requer2FA: true, tempToken: await auth.criarPendencia2FA(u.id) });
    }
    if (u.super_admin && !u.totp_ativo) {
      // Admin sem 2FA configurado: obriga a cadastrar antes de entrar
      return res.json({ configurar2FA: true, tempToken: await auth.criarPendencia2FA(u.id) });
    }

    await concluirLogin(req, res, u);
  } catch (e) {
    next(e);
  }
});

app.post("/api/login/2fa", async (req, res, next) => {
  try {
    const tempToken = String(req.body.tempToken || "");
    // Le SEM destruir: errar o codigo nao pode obrigar a refazer o login todo.
    const pend = await auth.lerPendencia2FA(tempToken);
    if (!pend) return res.status(401).json({ erro: "Sessão de login expirada. Entre novamente.", recomecar: true });

    const r = await db.query("SELECT * FROM usuarios WHERE id = $1 AND ativo = TRUE", [pend.usuarioId]);
    const u = r.rows[0];
    if (!u) return res.status(401).json({ erro: "Usuário indisponível", recomecar: true });

    if (!auth.verificarTOTP(u.totp_secret, req.body.codigo)) {
      const restam = await auth.registrarTentativa2FA(tempToken);
      await auth.registrarFalha(auth.ipDe(req));
      await auth.auditar(req, "login_2fa_falhou", { usuarioId: u.id, email: u.email });
      return res.status(401).json({ erro: mensagemCodigoInvalido(restam), recomecar: restam === 0 });
    }

    // So agora a pendencia e destruida.
    await auth.consumirPendencia2FA(tempToken);
    await concluirLogin(req, res, u);
  } catch (e) {
    next(e);
  }
});

function mensagemCodigoInvalido(restam) {
  if (restam === 0) return "Código inválido. Entre novamente com e-mail e senha.";
  if (restam === 1) return "Código inválido. Resta 1 tentativa. Confira o horário do celular.";
  return `Código inválido. Restam ${restam} tentativas.`;
}

// Cadastro do 2FA — usado no primeiro acesso de um super admin
app.post("/api/login/2fa/iniciar", async (req, res, next) => {
  try {
    const usuarioId = await auth.consumirPendencia2FA(String(req.body.tempToken || ""));
    if (!usuarioId) return res.status(401).json({ erro: "Sessão de login expirada", recomecar: true });

    const r = await db.query("SELECT id, email FROM usuarios WHERE id = $1", [usuarioId]);
    const u = r.rows[0];
    if (!u) return res.status(401).json({ erro: "Usuário indisponível" });

    const segredo = auth.gerarSegredoTOTP();
    await db.query("UPDATE usuarios SET totp_secret = $1, totp_ativo = FALSE WHERE id = $2", [
      segredo, u.id,
    ]);
    const otpauth = auth.urlQRCode(u.email, segredo);
    // Devolve um novo tempToken para a etapa de confirmacao
    res.json({
      segredo,
      qr: await QRCode.toDataURL(otpauth, { margin: 1, width: 220 }),
      tempToken: await auth.criarPendencia2FA(u.id),
    });
  } catch (e) {
    next(e);
  }
});

app.post("/api/login/2fa/confirmar", async (req, res, next) => {
  try {
    const tempToken = String(req.body.tempToken || "");
    const pend = await auth.lerPendencia2FA(tempToken);
    if (!pend) return res.status(401).json({ erro: "Sessão de login expirada", recomecar: true });

    const r = await db.query("SELECT * FROM usuarios WHERE id = $1", [pend.usuarioId]);
    const u = r.rows[0];
    if (!u || !u.totp_secret) return res.status(400).json({ erro: "2FA não iniciado", recomecar: true });

    // Aqui tambem: errar o codigo nao descarta o cadastro em andamento, senao
    // a pessoa teria que ler o QR Code de novo a cada digito errado.
    if (!auth.verificarTOTP(u.totp_secret, req.body.codigo)) {
      const restam = await auth.registrarTentativa2FA(tempToken);
      return res.status(401).json({
        erro: restam === 0
          ? "Código inválido. Entre novamente com e-mail e senha."
          : `Código inválido. Confira o horário do celular. ${restam === 1 ? "Resta 1 tentativa." : "Restam " + restam + " tentativas."}`,
        recomecar: restam === 0,
      });
    }

    await auth.consumirPendencia2FA(tempToken);
    await db.query("UPDATE usuarios SET totp_ativo = TRUE WHERE id = $1", [u.id]);
    await auth.auditar(req, "2fa_ativado", { usuarioId: u.id, email: u.email });
    await concluirLogin(req, res, u);
  } catch (e) {
    next(e);
  }
});

async function concluirLogin(req, res, u) {
  const token = await auth.criarSessao(u.id, auth.ipDe(req));
  await db.query("UPDATE usuarios SET ultimo_login = NOW() WHERE id = $1", [u.id]);
  auth.definirCookie(res, token);
  await auth.auditar(req, "login", { usuarioId: u.id, email: u.email });
  res.json({ ok: true, senhaTemp: u.senha_temp });
}

app.post("/api/logout", async (req, res, next) => {
  try {
    const token = auth.lerToken(req);
    if (req.usuario) await auth.auditar(req, "logout");
    await auth.encerrarSessao(token);
    auth.limparCookie(res);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Sessao atual + modulos liberados (usado pela casca e pelo menu lateral)
// ---------------------------------------------------------------------------

app.get("/api/eu", exigeLogin, async (req, res, next) => {
  try {
    const p = await db.query(
      `SELECT telefone, ramal, departamento, cargo,
              EXISTS (SELECT 1 FROM usuario_foto f WHERE f.usuario_id = u.id) AS tem_foto
         FROM usuarios u WHERE u.id = $1`,
      [req.usuario.id]
    );
    const dados = p.rows[0] || {};
    res.json({
      usuario: {
        id: req.usuario.id,
        nome: req.usuario.nome,
        email: req.usuario.email,
        superAdmin: req.usuario.super_admin,
        senhaTemp: req.usuario.senha_temp,
        telefone: dados.telefone || "",
        ramal: dados.ramal || "",
        departamento: dados.departamento || "",
        cargo: dados.cargo || "",
        temFoto: Boolean(dados.tem_foto),
        perfilCompleto: perfil.completo(dados),
        // A tela so barra quando as duas coisas valem: a exigencia esta ligada
        // E falta dado. Assim o mesmo codigo serve para antes e depois de a
        // regra entrar em vigor, sem if espalhado pela interface.
        exigirPerfil: perfil.exigindoPerfil() && !perfil.completo(dados),
      },
      modulos: await modulosDoUsuario(req.usuario),
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// PERFIL — cada pessoa mantem o proprio
// ---------------------------------------------------------------------------

app.post("/api/perfil", exigeLogin, async (req, res, next) => {
  try {
    const r = perfil.validar(req.body || {});
    if (!r.ok) return res.status(400).json({ erro: r.erros[0], erros: r.erros });
    const v = r.valores;
    await db.query(
      `UPDATE usuarios
          SET telefone = $1, ramal = $2, departamento = $3, cargo = $4, perfil_em = NOW()
        WHERE id = $5`,
      [v.telefone || null, v.ramal || null, v.departamento, v.cargo, req.usuario.id]
    );
    await auth.auditar(req, "perfil_atualizado", {
      usuarioId: req.usuario.id, email: req.usuario.email,
      detalhe: { departamento: v.departamento, cargo: v.cargo },
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// A foto chega em base64 no corpo, nao como multipart.
//
// Evita uma dependencia de upload so para isto, e a tela ja reduz a imagem
// antes de enviar (canvas no navegador), entao o que chega aqui e pequeno.
// A checagem de tamanho e de tipo e refeita no servidor porque a validacao da
// tela protege o usuario distraido, nao quem chama a API direto.
app.post("/api/perfil/foto", exigeLogin, async (req, res, next) => {
  try {
    const { tipo, base64 } = req.body || {};
    if (!perfil.FOTO_TIPOS.includes(tipo)) {
      return res.status(400).json({ erro: "Formato não aceito. Use JPG, PNG ou WebP." });
    }
    const bytes = Buffer.from(String(base64 || ""), "base64");
    if (!bytes.length) return res.status(400).json({ erro: "Imagem vazia." });
    if (bytes.length > perfil.FOTO_MAX_BYTES) {
      return res.status(413).json({ erro: "Imagem muito grande." });
    }
    await db.query(
      `INSERT INTO usuario_foto (usuario_id, tipo, bytes) VALUES ($1,$2,$3)
       ON CONFLICT (usuario_id) DO UPDATE SET tipo = EXCLUDED.tipo,
         bytes = EXCLUDED.bytes, enviada_em = NOW()`,
      [req.usuario.id, tipo, bytes]
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.delete("/api/perfil/foto", exigeLogin, async (req, res, next) => {
  try {
    await db.query("DELETE FROM usuario_foto WHERE usuario_id = $1", [req.usuario.id]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// AGENDA — todo mundo do grupo pode consultar
// ---------------------------------------------------------------------------

app.get("/api/agenda", exigeLogin, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT u.id, u.nome, u.email, u.telefone, u.ramal, u.departamento, u.cargo,
              EXISTS (SELECT 1 FROM usuario_foto f WHERE f.usuario_id = u.id) AS tem_foto
         FROM usuarios u
        WHERE u.ativo = TRUE
        ORDER BY u.nome`
    );
    res.json({
      pessoas: r.rows.map((p) => ({
        id: p.id,
        nome: p.nome,
        email: p.email,
        telefone: p.telefone || "",
        telefoneFormatado: perfil.formatarTelefone(p.telefone),
        ramal: p.ramal || "",
        departamento: p.departamento || "",
        cargo: p.cargo || "",
        temFoto: p.tem_foto,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// Departamentos ja cadastrados, para a tela sugerir enquanto a pessoa digita.
// E o que evita "Comercial", "comercial" e "Com." convivendo na mesma agenda.
app.get("/api/agenda/departamentos", exigeLogin, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT departamento, count(*)::int AS quantos
         FROM usuarios
        WHERE ativo = TRUE AND departamento IS NOT NULL AND departamento <> ''
        GROUP BY departamento`
    );
    // Junta a lista de partida com o que ja esta em uso. Um departamento
    // digitado por alguem vira opcao para quem preencher depois — e por isso
    // a lista se organiza sozinha sem precisar de manutencao.
    const emUso = new Map(r.rows.map((x) => [x.departamento, x.quantos]));
    const nomes = new Set([...perfil.DEPARTAMENTOS, ...emUso.keys()]);
    const lista = [...nomes]
      .map((nome) => ({ departamento: nome, quantos: emUso.get(nome) || 0 }))
      .sort((a, b) => a.departamento.localeCompare(b.departamento, "pt-BR"));
    res.json({ departamentos: lista });
  } catch (e) {
    next(e);
  }
});

app.get("/api/foto/:id", exigeLogin, async (req, res, next) => {
  try {
    const r = await db.query(
      "SELECT tipo, bytes FROM usuario_foto WHERE usuario_id = $1", [req.params.id]
    );
    if (!r.rows[0]) return res.status(404).end();
    res.set("Content-Type", r.rows[0].tipo);
    // Cache curto: a foto muda pouco, mas quando muda a pessoa quer ver a nova
    // no mesmo dia, nao na semana que vem.
    res.set("Cache-Control", "private, max-age=600");
    res.send(r.rows[0].bytes);
  } catch (e) {
    next(e);
  }
});

async function modulosDoUsuario(usuario) {
  const disponiveis = modulos.listar();
  // Super admin enxerga todos os modulos ativos, sempre como 'admin'
  if (usuario.super_admin) {
    return disponiveis.map((m) => ({
      id: m.id, nome: m.nome, descricao: m.descricao, base: m.base, icone: m.icone,
      papel: modulos.papelDeAdmin(m.id),
      papelRotulo: modulos.rotuloDoPapel(m.id, modulos.papelDeAdmin(m.id)),
    }));
  }
  const r = await db.query("SELECT modulo, papel FROM usuario_modulos WHERE usuario_id = $1", [
    usuario.id,
  ]);
  const papeis = new Map(r.rows.map((x) => [x.modulo, x.papel]));
  return disponiveis
    .filter((m) => papeis.has(m.id))
    .map((m) => ({
      id: m.id, nome: m.nome, descricao: m.descricao, base: m.base, icone: m.icone,
      papel: papeis.get(m.id),
      papelRotulo: modulos.rotuloDoPapel(m.id, papeis.get(m.id)),
    }));
}

// Troca da propria senha
app.post("/api/senha", exigeLogin, async (req, res, next) => {
  try {
    const atual = String(req.body.atual || "");
    const nova = String(req.body.nova || "");
    if (nova.length < 8) return res.status(400).json({ erro: "A nova senha precisa ter ao menos 8 caracteres" });

    const r = await db.query("SELECT senha FROM usuarios WHERE id = $1", [req.usuario.id]);
    const conferiu = await auth.verificarSenha(atual, r.rows[0].senha);
    if (!conferiu.ok) return res.status(401).json({ erro: "Senha atual incorreta" });

    await db.query("UPDATE usuarios SET senha = $1, senha_temp = FALSE WHERE id = $2", [
      auth.gerarHash(nova), req.usuario.id,
    ]);
    await auth.auditar(req, "senha_alterada");
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// API INTERNA — e por aqui que cada modulo pergunta "quem e essa pessoa aqui?"
// So a Fachada e os modulos chamam, pela rede privada do Railway.
// ---------------------------------------------------------------------------

app.get("/api/interno/sessao", async (req, res, next) => {
  try {
    const chave = process.env.CORE_INTERNAL_KEY;
    if (chave && req.headers["x-core-key"] !== chave) {
      return res.status(401).json({ erro: "Chave interna inválida" });
    }

    const usuario = await auth.lerSessao(
      String(req.headers["x-unigestao-token"] || req.query.token || "")
    );
    if (!usuario) return res.status(401).json({ erro: "Sessão inválida" });

    // Senha provisoria nao abre modulo. A Fachada trata 401 como "volte ao
    // inicio", e la a tela obriga a definir uma senha antes de seguir.
    if (usuario.senha_temp) {
      return res.status(401).json({ erro: "Defina uma senha antes de acessar os módulos", senhaTemp: true });
    }

    // Cadastro incompleto, com a exigencia ligada, tambem nao abre modulo.
    //
    // A tela ja desvia para /perfil, mas a tela e so conveniencia: sem esta
    // conferencia bastaria digitar /crm/ na barra de endereco para pular o
    // formulario. Quem decide e o servidor; a interface apenas obedece.
    if (perfil.exigindoPerfil()) {
      const p = await db.query(
        "SELECT telefone, ramal, departamento, cargo FROM usuarios WHERE id = $1",
        [usuario.id]
      );
      if (!perfil.completo(p.rows[0])) {
        return res.status(401).json({
          erro: "Complete seu cadastro antes de acessar os módulos",
          perfilIncompleto: true,
        });
      }
    }

    const moduloId = String(req.query.modulo || "");
    if (!moduloId) {
      return res.json({ id: usuario.id, nome: usuario.nome, email: usuario.email });
    }
    if (!modulos.existe(moduloId)) return res.status(404).json({ erro: "Módulo desconhecido" });

    // A lista do que a pessoa alcanca acompanha a resposta para a Fachada
    // montar o menu de troca de modulo na barra. Sem isso ela so sabe onde a
    // pessoa esta, e trocar de sistema exigiria voltar ao inicio a cada vez.
    const alcance = usuario.super_admin
      ? modulos.listar().map((m) => ({ id: m.id, nome: m.nome, base: m.base }))
      : (await db.query(
          "SELECT modulo FROM usuario_modulos WHERE usuario_id = $1", [usuario.id]
        )).rows
          .filter((x) => modulos.existe(x.modulo))
          .map((x) => {
            const m = modulos.get(x.modulo);
            return { id: x.modulo, nome: m.nome, base: m.base };
          })
          .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

    if (usuario.super_admin) {
      // Cada modulo batiza o proprio papel de administrador. Mandar "admin"
      // para todos fazia o CRM — que chama de "administrador" — recusar o
      // administrador geral na propria tela de usuarios.
      return res.json({
        id: usuario.id, nome: usuario.nome, email: usuario.email,
        papel: modulos.papelDeAdmin(moduloId), superAdmin: true,
        modulos: alcance,
      });
    }

    const r = await db.query(
      "SELECT papel FROM usuario_modulos WHERE usuario_id = $1 AND modulo = $2",
      [usuario.id, moduloId]
    );
    if (!r.rows[0]) return res.status(403).json({ erro: "Sem acesso a este módulo" });

    res.json({
      id: usuario.id, nome: usuario.nome, email: usuario.email,
      papel: r.rows[0].papel, superAdmin: false,
      modulos: alcance,
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// ADMIN GERAL — pessoas x modulos x papel
// ---------------------------------------------------------------------------

app.get("/api/admin/modulos", exigeSuperAdmin, (req, res) => {
  res.json(
    modulos.listar().map((m) => ({
      id: m.id, nome: m.nome, descricao: m.descricao, icone: m.icone,
      // `valor` e o que o modulo entende e o que sera gravado; `rotulo` e so o
      // que a pessoa le. Nao trocar um pelo outro.
      papeis: m.papeis.map((p) => ({ valor: p, rotulo: modulos.rotuloDoPapel(m.id, p) })),
    }))
  );
});

app.get("/api/admin/usuarios", exigeSuperAdmin, async (req, res, next) => {
  try {
    const busca = String(req.query.busca || "").trim().toLowerCase();
    const params = [];
    let filtro = "";
    if (busca) {
      params.push(`%${busca}%`);
      filtro = "WHERE LOWER(u.nome) LIKE $1 OR LOWER(u.email) LIKE $1";
    }
    const r = await db.query(
      `SELECT u.id, u.nome, u.email, u.ativo, u.super_admin, u.totp_ativo,
              u.senha_temp, u.ultimo_login,
              COALESCE(json_agg(json_build_object('modulo', m.modulo, 'papel', m.papel))
                       FILTER (WHERE m.modulo IS NOT NULL), '[]') AS modulos
         FROM usuarios u
         LEFT JOIN usuario_modulos m ON m.usuario_id = u.id
         ${filtro}
        GROUP BY u.id
        ORDER BY u.nome
        LIMIT 500`,
      params
    );
    res.json(r.rows);
  } catch (e) {
    next(e);
  }
});

app.post("/api/admin/usuarios", exigeSuperAdmin, async (req, res, next) => {
  try {
    const nome = String(req.body.nome || "").trim();
    const email = String(req.body.email || "").toLowerCase().trim();
    const senha = String(req.body.senha || "");
    if (!nome || !email) return res.status(400).json({ erro: "Informe nome e e-mail" });
    if (senha.length < 8) return res.status(400).json({ erro: "A senha precisa ter ao menos 8 caracteres" });

    const id = "u" + crypto.randomBytes(9).toString("hex");
    await db.query(
      `INSERT INTO usuarios (id, nome, email, senha, senha_temp, super_admin)
       VALUES ($1,$2,$3,$4,TRUE,$5)`,
      [id, nome, email, auth.gerarHash(senha), Boolean(req.body.superAdmin)]
    );
    await salvarModulos(id, req.body.modulos);
    await auth.auditar(req, "usuario_criado", { alvo: id, detalhe: { email, nome } });

    // Padrao: quem cria um acesso avisa a pessoa. Sem isso o administrador
    // tem que copiar senha e link a mao para cada um, que era como se fazia.
    const aviso = await avisarSeMarcado(req, () =>
      correio.avisarContaNova({ nome, email, senha, modulos: paraEmail(req.body.modulos) })
    );
    res.json({ ok: true, id, email: aviso });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ erro: "Já existe usuário com esse e-mail" });
    next(e);
  }
});

app.patch("/api/admin/usuarios/:id", exigeSuperAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;
    const campos = [];
    const params = [];
    const set = (col, val) => {
      params.push(val);
      campos.push(`${col} = $${params.length}`);
    };

    if (req.body.nome !== undefined) set("nome", String(req.body.nome).trim());
    if (req.body.email !== undefined) set("email", String(req.body.email).toLowerCase().trim());
    if (req.body.ativo !== undefined) set("ativo", Boolean(req.body.ativo));
    if (req.body.superAdmin !== undefined) set("super_admin", Boolean(req.body.superAdmin));
    if (req.body.senha) {
      if (String(req.body.senha).length < 8)
        return res.status(400).json({ erro: "A senha precisa ter ao menos 8 caracteres" });
      set("senha", auth.gerarHash(String(req.body.senha)));
      set("senha_temp", true);
    }

    // Nao permitir que o admin se desative ou perca o proprio super admin
    if (id === req.usuario.id) {
      if (req.body.ativo === false) return res.status(400).json({ erro: "Você não pode desativar a si mesmo" });
      if (req.body.superAdmin === false)
        return res.status(400).json({ erro: "Você não pode remover seu próprio acesso de administrador" });
    }

    if (campos.length) {
      params.push(id);
      await db.query(`UPDATE usuarios SET ${campos.join(", ")} WHERE id = $${params.length}`, params);
    }
    // Quais modulos sao NOVOS para essa pessoa. Calculado antes de gravar —
    // depois do salvarModulos a lista anterior ja foi substituida e nao da
    // mais para saber o que mudou.
    let novos = [];
    if (req.body.modulos !== undefined) {
      const antes = await db.query(
        "SELECT modulo FROM usuario_modulos WHERE usuario_id = $1", [id]
      );
      const tinha = new Set(antes.rows.map((r) => r.modulo));
      novos = (req.body.modulos || []).filter((m) => m && !tinha.has(m.modulo));
      await salvarModulos(id, req.body.modulos);
    }

    // Mudou senha ou desativou: derruba as sessoes abertas dessa pessoa
    if (req.body.senha || req.body.ativo === false) await auth.encerrarSessoesDoUsuario(id);

    await auth.auditar(req, "usuario_alterado", { alvo: id, detalhe: camposAlterados(req.body) });

    // Senha nova tem prioridade sobre modulo novo: quem acabou de ter a senha
    // trocada precisa saber disso antes de qualquer outra novidade — e dois
    // e-mails no mesmo minuto so confundem.
    const dono = (await db.query("SELECT nome, email FROM usuarios WHERE id = $1", [id])).rows[0] || {};
    let aviso = { ignorado: true, motivo: "nada a avisar" };
    if (req.body.senha) {
      aviso = await avisarSeMarcado(req, () =>
        correio.avisarSenhaNova({ nome: dono.nome, email: dono.email, senha: String(req.body.senha) })
      );
    } else if (novos.length) {
      aviso = await avisarSeMarcado(req, () =>
        correio.avisarModuloNovo({ nome: dono.nome, email: dono.email, modulos: paraEmail(novos) })
      );
    }
    res.json({ ok: true, email: aviso });
  } catch (e) {
    if (e.code === "23505") return res.status(409).json({ erro: "Já existe usuário com esse e-mail" });
    next(e);
  }
});

app.post("/api/admin/usuarios/:id/2fa/resetar", exigeSuperAdmin, async (req, res, next) => {
  try {
    await db.query(
      "UPDATE usuarios SET totp_secret = NULL, totp_ativo = FALSE WHERE id = $1",
      [req.params.id]
    );
    await auth.encerrarSessoesDoUsuario(req.params.id);
    await auth.auditar(req, "2fa_resetado", { alvo: req.params.id });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Em que modo o envio de e-mail esta. A tela usa isso para avisar o
// administrador quando o e-mail nao vai sair, e os testes usam como trava:
// so mexem em cadastro depois de confirmar que estao em "rascunho".
app.get("/api/admin/email", exigeSuperAdmin, (req, res) => {
  res.json({
    configurado: correio.configurado(),
    modo: correio.modo(),
    remetente: correio.REMETENTE_ENDERECO,
  });
});

app.get("/api/admin/auditoria", exigeSuperAdmin, async (req, res, next) => {
  try {
    const r = await db.query(
      "SELECT at, email, acao, alvo, detalhe, ip FROM auditoria ORDER BY at DESC LIMIT 200"
    );
    res.json(r.rows);
  } catch (e) {
    next(e);
  }
});

// Traduz [{modulo, papel}] para o que a pessoa le no e-mail: o nome do
// sistema e o papel em portugues, nunca o valor cru gravado no banco
// ("comercial_interno", "MANAGER").
function paraEmail(lista) {
  return (Array.isArray(lista) ? lista : [])
    .filter((i) => i && modulos.existe(i.modulo))
    .map((i) => ({
      nome: modulos.get(i.modulo).nome,
      papelRotulo: modulos.rotuloDoPapel(i.modulo, i.papel),
    }));
}

// Avisar por e-mail e o padrao — o administrador desmarca na tela quando nao
// quer (cadastro adiantado de quem ainda nao comecou, conta de teste).
//
// Nunca lanca: a conta ja foi criada ou alterada quando chegamos aqui, e
// falha no envio nao pode desfazer isso nem virar erro na tela. O resultado
// vai na resposta para o Admin Geral mostrar se saiu ou nao.
async function avisarSeMarcado(req, envio) {
  if (req.body.avisar === false) return { ignorado: true, motivo: "não solicitado" };
  if (req.body.ativo === false) return { ignorado: true, motivo: "usuário desativado" };
  if (!correio.configurado()) return { ignorado: true, motivo: "envio de e-mail não configurado" };
  try {
    return await envio();
  } catch (e) {
    return { ok: false, erro: e.message };
  }
}

// Grava a lista de modulos de uma pessoa: [{modulo, papel}, ...]
async function salvarModulos(usuarioId, lista) {
  const itens = Array.isArray(lista) ? lista : [];
  const validos = itens.filter(
    (i) => i && modulos.existe(i.modulo) && modulos.papelValido(i.modulo, i.papel)
  );
  await db.transaction(async (c) => {
    await c.query("DELETE FROM usuario_modulos WHERE usuario_id = $1", [usuarioId]);
    for (const i of validos) {
      await c.query(
        "INSERT INTO usuario_modulos (usuario_id, modulo, papel) VALUES ($1,$2,$3)",
        [usuarioId, i.modulo, i.papel]
      );
    }
  });
}

function camposAlterados(body) {
  const out = {};
  for (const k of ["nome", "email", "ativo", "superAdmin", "modulos"]) {
    if (body[k] !== undefined) out[k] = k === "senha" ? "***" : body[k];
  }
  if (body.senha) out.senha = "alterada";
  return out;
}

// ---------------------------------------------------------------------------
// Erros
// ---------------------------------------------------------------------------

app.use((err, req, res, _next) => {
  console.error("[erro]", err);
  res.status(500).json({ erro: "Erro interno" });
});

// ---------------------------------------------------------------------------
// Bootstrap: cria o primeiro super admin se o banco estiver vazio
// ---------------------------------------------------------------------------

async function bootstrap() {
  const r = await db.query("SELECT COUNT(*)::int AS n FROM usuarios");
  if (r.rows[0].n > 0) return;

  const email = (process.env.BOOTSTRAP_EMAIL || "rodrigo.moraes@uniseter.com").toLowerCase();
  const senha = process.env.BOOTSTRAP_SENHA || crypto.randomBytes(9).toString("base64url");
  const id = "u" + crypto.randomBytes(9).toString("hex");

  await db.query(
    `INSERT INTO usuarios (id, nome, email, senha, senha_temp, super_admin)
     VALUES ($1,$2,$3,$4,TRUE,TRUE)`,
    [id, process.env.BOOTSTRAP_NOME || "Rodrigo Moraes", email, auth.gerarHash(senha)]
  );

  console.log("========================================================");
  console.log(" PRIMEIRO ACESSO CRIADO");
  console.log(" e-mail: " + email);
  if (!process.env.BOOTSTRAP_SENHA) console.log(" senha .: " + senha + "   (anote — nao sera exibida de novo)");
  console.log(" O 2FA sera exigido no primeiro login (super admin).");
  console.log("========================================================");
}

(async () => {
  try {
    await db.init();
    await bootstrap();
    // Escuta em "::" (IPv6, com IPv4 mapeado): e o que a rede privada do
    // Railway exige para um servico sem dominio publico ser alcancavel.
    app.listen(PORT, "::", () => console.log(`[core] UniGestao ouvindo na porta ${PORT}`));
  } catch (e) {
    console.error("[core] falha ao iniciar:", e);
    process.exit(1);
  }
})();
