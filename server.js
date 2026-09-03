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
const mural = require("./core/mural");
const checklists = require("./core/checklists");
const chat = require("./core/chat");

const app = express();

// Em quem acreditar ao ler o X-Forwarded-For — a lista esta em core/auth.js,
// junto de quem a usa para decidir bloqueio e auditoria.
//
// Consequencia pratica: se algum dia o Core for exposto direto na internet, a
// requisicao de fora chega com o vizinho publico, o cabecalho e IGNORADO e vale
// o endereco da conexao de verdade. Ninguem consegue dizer de onde esta vindo.
app.set("trust proxy", auth.PROXY_CONFIAVEL);
// 3mb cobre a maior imagem aceita em base64 com folga: o teto real e 900 KB
// para a imagem do mural (core/mural.js), que em base64 da ~1,2 MB. O resto
// das rotas manda JSON pequeno — este limite existe so por causa de imagem.
app.use(express.json({ limit: "3mb" }));

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

app.get("/mural", (req, res) => {
  if (!req.usuario) return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "mural.html"));
});

app.get("/admin", (req, res) => {
  if (!req.usuario) return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "admin.html"));
});

// Painel de checklists. Duas portas: precisa estar logado E ter a marcacao.
// Quem nao tem volta para a tela inicial em vez de ver um 403 — a pessoa nao
// fez nada errado, so nao tem esse acesso.
app.get("/checklists", (req, res) => {
  if (!req.usuario) return res.redirect("/");
  if (!checklists.podeVer(req.usuario)) return res.redirect("/");
  res.sendFile(path.join(PUBLIC, "checklists.html"));
});

// Pagina do link que chega por e-mail. Nao exige login — quem chega aqui e
// justamente quem nao consegue entrar. O que protege e o token, conferido no
// POST abaixo; a pagina em si nao mostra nada de ninguem.
app.get("/redefinir", (req, res) => {
  res.sendFile(path.join(PUBLIC, "redefinir.html"));
});

app.use(express.static(PUBLIC, { index: false }));

// ---------------------------------------------------------------------------
// Login
// ---------------------------------------------------------------------------

app.post("/api/login", async (req, res, next) => {
  try {
    const ip = auth.ipDe(req);
    const email = String(req.body.email || "").toLowerCase().trim();
    const senha = String(req.body.senha || "");
    if (!email || !senha) return res.status(400).json({ erro: "Informe e-mail e senha" });

    // A conferencia do bloqueio vem DEPOIS de ler o e-mail, porque agora ela
    // pergunta pela conta e nao so pelo endereco de rede. A mensagem diz de
    // qual dos dois se trata: "sua conta" e algo que a pessoa resolve sozinha
    // esperando; "deste local" e o teto do escritorio, que quase nunca aparece
    // e, se aparecer, e sinal de que algo esta tentando adivinhar senhas.
    const trava = await auth.bloqueado(ip, email);
    if (trava) {
      return res.status(429).json({
        erro: trava.motivo === "conta"
          ? "Muitas tentativas nesta conta. Tente novamente em alguns minutos, ou use “Esqueci minha senha”."
          : "Muitas tentativas a partir deste local. Tente novamente em alguns minutos.",
      });
    }

    const r = await db.query(
      "SELECT * FROM usuarios WHERE LOWER(email) = $1 AND ativo = TRUE",
      [email]
    );
    const u = r.rows[0];

    const conferiu = u ? await auth.verificarSenha(senha, u.senha) : { ok: false };

    if (!u || !conferiu.ok) {
      await auth.registrarFalha(ip, email);
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

    await auth.limparFalhas(ip, email);

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
      await auth.registrarFalha(auth.ipDe(req), u.email);
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
// ESQUECI MINHA SENHA
// ---------------------------------------------------------------------------
// Antes disto, quem perdia a senha dependia de achar um administrador. Agora o
// caminho de volta passa pelo proprio e-mail corporativo da pessoa.
//
// Tres decisoes que valem ser explicadas:
//
// 1. A resposta e SEMPRE a mesma, exista o e-mail ou nao. Responder "esse
//    e-mail nao esta cadastrado" entregaria a estranhos a lista de quem
//    trabalha aqui, um e-mail por vez.
//
// 2. Guarda-se o hash do token, nunca o token. Ver core/schema.sql.
//
// 3. Ha um intervalo minimo entre pedidos. Nao e paranoia: a cota do SendGrid
//    e de 100 e-mails por dia para o grupo TODO, e ja bateu em 95. Sem trava,
//    um script apertando o botao esgota o dia e derruba junto os avisos de
//    acesso novo e as notificacoes do Tarefas.

const RESET_VALIDADE_MIN = 60;   // quanto tempo o link vale
const RESET_INTERVALO_MIN = 15;  // minimo entre dois pedidos da mesma pessoa

const hashDoToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

app.post("/api/senha/esqueci", async (req, res, next) => {
  // Mensagem unica, dita antes de qualquer consulta, para nao haver caminho de
  // codigo que responda diferente por engano.
  const resposta = {
    ok: true,
    mensagem: "Se esse e-mail estiver cadastrado, você vai receber as instruções em alguns minutos.",
  };
  try {
    const ip = auth.ipDe(req);
    if (await auth.ipBloqueado(ip)) {
      return res.status(429).json({ erro: "Muitas tentativas. Tente novamente em alguns minutos." });
    }
    const email = String(req.body.email || "").toLowerCase().trim();
    if (!email) return res.status(400).json({ erro: "Informe o e-mail" });

    const r = await db.query(
      "SELECT id, nome, email FROM usuarios WHERE LOWER(email) = $1 AND ativo = TRUE",
      [email]
    );
    const u = r.rows[0];
    if (!u) {
      // Conta inexistente ou desativada: nada acontece, e a resposta e a mesma.
      await auth.auditar(req, "senha_esqueci_desconhecido", { email });
      return res.json(resposta);
    }

    const recente = await db.query(
      `SELECT 1 FROM senha_reset
        WHERE usuario_id = $1 AND criado_em > NOW() - ($2 || ' minutes')::interval
        LIMIT 1`,
      [u.id, String(RESET_INTERVALO_MIN)]
    );
    if (recente.rows[0]) {
      // Ja mandamos ha pouco. Continua respondendo igual: quem pediu duas vezes
      // seguidas so precisa olhar a caixa de entrada.
      await auth.auditar(req, "senha_esqueci_repetido", { usuarioId: u.id, email: u.email });
      return res.json(resposta);
    }

    const token = crypto.randomBytes(32).toString("hex");
    await db.query(
      `INSERT INTO senha_reset (token_hash, usuario_id, expira_em, ip)
       VALUES ($1, $2, NOW() + ($3 || ' minutes')::interval, $4)`,
      [hashDoToken(token), u.id, String(RESET_VALIDADE_MIN), ip]
    );

    const link = `${correio.URL_PORTAL}/redefinir?token=${token}`;
    const envio = await correio.avisarRecuperarSenha({
      nome: u.nome, email: u.email, link, minutos: RESET_VALIDADE_MIN,
    });
    await auth.auditar(req, "senha_esqueci_enviado", {
      usuarioId: u.id, email: u.email, detalhe: { enviado: Boolean(envio && envio.ok) },
    });
    res.json(resposta);
  } catch (e) {
    next(e);
  }
});

// A tela do link chama isto antes de mostrar o formulario, so para dizer se o
// link ainda vale. Nao devolve nome nem e-mail: quem esta com o link pode nao
// ser o dono dele, e ate a senha ser trocada nao ha por que confirmar de quem
// e a conta.
app.get("/api/senha/redefinir/confere", async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT 1 FROM senha_reset
        WHERE token_hash = $1 AND usado_em IS NULL AND expira_em > NOW()`,
      [hashDoToken(req.query.token || "")]
    );
    res.json({ valido: Boolean(r.rows[0]) });
  } catch (e) {
    next(e);
  }
});

app.post("/api/senha/redefinir", async (req, res, next) => {
  try {
    const nova = String(req.body.nova || "");
    if (nova.length < 8) {
      return res.status(400).json({ erro: "A nova senha precisa ter ao menos 8 caracteres" });
    }

    // O UPDATE ... RETURNING marca o token como usado e devolve de quem ele era
    // no MESMO comando. Ler e depois marcar deixaria uma fresta entre as duas
    // consultas em que o mesmo link funcionaria duas vezes.
    const r = await db.query(
      `UPDATE senha_reset SET usado_em = NOW()
        WHERE token_hash = $1 AND usado_em IS NULL AND expira_em > NOW()
        RETURNING usuario_id`,
      [hashDoToken(req.body.token || "")]
    );
    const linha = r.rows[0];
    if (!linha) {
      return res.status(400).json({
        erro: "Este link não vale mais. Peça um novo em “Esqueci minha senha”.",
      });
    }

    await db.query(
      "UPDATE usuarios SET senha = $1, senha_temp = FALSE WHERE id = $2",
      [auth.gerarHash(nova), linha.usuario_id]
    );
    // Qualquer outro link pendente da mesma pessoa morre junto.
    await db.query(
      "UPDATE senha_reset SET usado_em = NOW() WHERE usuario_id = $1 AND usado_em IS NULL",
      [linha.usuario_id]
    );
    // E as sessoes abertas caem. Se a senha foi trocada porque alguem entrou na
    // conta, deixar a sessao dessa pessoa de pe tornaria a troca inutil.
    await auth.encerrarSessoesDoUsuario(linha.usuario_id);

    await auth.auditar(req, "senha_redefinida_pelo_link", { usuarioId: linha.usuario_id });
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
      `SELECT telefone, ramal, departamento, departamentos, cargo, modulos_ordem,
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
        departamentos: perfil.departamentosDe(dados),
        cargo: dados.cargo || "",
        temFoto: Boolean(dados.tem_foto),
        perfilCompleto: perfil.completo(dados),
        podePublicarMural: mural.podePublicar(req.usuario),
        podeVerChecklists: checklists.podeVer(req.usuario),
        // A ordem em que a pessoa arrastou os cartoes. Lista vazia = ordem
        // padrao; a tela nao precisa saber a diferenca.
        ordemModulos: dados.modulos_ordem || [],
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

// A ordem dos cartoes na tela inicial, arrastada pela propria pessoa.
//
// Guarda CHAVES, nao posicoes. A lista e uma PREFERENCIA e nunca um filtro:
// quem desenha a tela usa isto so para ordenar o que a pessoa realmente
// alcanca. Modulo concedido depois nao esta na lista e mesmo assim aparece, no
// fim — se fosse filtro, o cartao novo sumiria e ninguem entenderia por que.
//
// Nao ha validacao contra a lista de modulos de proposito: chave desconhecida
// aqui e inofensiva (a tela ignora), e validar obrigaria esta rota a conhecer
// tambem as telas do proprio portal (mural, agenda, checklists), que nao sao
// modulos. O teto de tamanho existe so para o campo nao virar deposito.
app.post("/api/eu/ordem-modulos", exigeLogin, async (req, res, next) => {
  try {
    const bruta = Array.isArray(req.body.ordem) ? req.body.ordem : [];
    const vistas = new Set();
    const ordem = [];
    for (const item of bruta) {
      const chave = String(item || "").trim().slice(0, 60);
      if (!chave || vistas.has(chave)) continue;
      vistas.add(chave);
      ordem.push(chave);
      if (ordem.length >= 60) break;
    }
    await db.query("UPDATE usuarios SET modulos_ordem = $1::text[] WHERE id = $2",
                   [ordem, req.usuario.id]);
    res.json({ ok: true, ordem });
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
          SET telefone = $1, ramal = $2, departamentos = $3::text[], cargo = $4,
              departamento = NULL, perfil_em = NOW()
        WHERE id = $5`,
      [v.telefone || null, v.ramal || null, v.departamentos, v.cargo, req.usuario.id]
    );
    await auth.auditar(req, "perfil_atualizado", {
      usuarioId: req.usuario.id, email: req.usuario.email,
      detalhe: { departamentos: v.departamentos, cargo: v.cargo },
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
// PAINEL DE CHECKLISTS DA OPERACAO
// ---------------------------------------------------------------------------
// A leitura do Nexti acontece AQUI, no pedido da tela, e nao numa rotina de
// fundo. Foi decisao do Rodrigo, e a razao e boa: sem limite de chamadas
// documentado pelo fornecedor, gastar chamada quando ninguem esta olhando e
// risco sem retorno. Como o cache guarda por dia, a segunda pessoa a abrir a
// tela nos 15 minutos seguintes nao gera chamada nenhuma.

function exigeVerChecklists(req, res, next) {
  if (!req.usuario) return res.status(401).json({ erro: "Faça login" });
  if (!checklists.podeVer(req.usuario)) {
    return res.status(403).json({ erro: "Você não tem acesso ao painel de checklists" });
  }
  next();
}

// Intervalo pedido pela tela, com limite. 92 dias cobre um trimestre; mais que
// isso, numa primeira carga, seriam mais de cem chamadas seguidas ao Nexti.
function intervaloPedido(req) {
  const hoje = new Date();
  const lerDia = (v) => {
    const m = String(v || "").match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return isNaN(d.getTime()) ? null : d;
  };
  let ate = lerDia(req.query.ate) || hoje;
  let de = lerDia(req.query.de) || ate;
  if (de > ate) { const t = de; de = ate; ate = t; }
  const maximo = 92;
  const dias = Math.round((ate - de) / 86400000);
  if (dias > maximo) de = new Date(ate.getTime() - maximo * 86400000);
  if (ate > hoje) ate = hoje;
  return { de, ate };
}

app.get("/api/checklists/painel", exigeVerChecklists, async (req, res, next) => {
  try {
    const { de, ate } = intervaloPedido(req);
    // `atualizar=1` so vem do botao. Abrir a tela nao forca busca: o cache
    // decide sozinho o que esta velho.
    let sincronia = null;
    if (req.query.atualizar === "1") {
      sincronia = await checklists.sincronizar(de, ate);
    }
    const [dados, estado, costume] = await Promise.all([
      checklists.painel(de, ate),
      checklists.frescor(de, ate),
      checklists.costumeDeHoje(),
    ]);
    res.json({ ...dados, estado, costume, sincronia });
  } catch (e) {
    next(e);
  }
});

// As linhas por tras de um numero do painel.
//
// Todo total da tela tem um caminho ate as visitas que o formaram: clicar no
// numero abre a lista. Painel em que nao da para conferir de onde veio o numero
// e painel em que nao se confia.
app.get("/api/checklists/visitas", exigeVerChecklists, async (req, res, next) => {
  try {
    const { de, ate } = intervaloPedido(req);
    const dados = await checklists.visitas(de, ate, {
      supervisorId: req.query.supervisor ? Number(req.query.supervisor) : null,
      cliente: req.query.cliente || null,
      dia: /^\d{4}-\d{2}-\d{2}$/.test(req.query.dia || "") ? req.query.dia : null,
    });
    res.json(dados);
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
      `SELECT u.id, u.nome, u.email, u.telefone, u.ramal,
              u.departamento, u.departamentos, u.cargo,
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
        departamentos: perfil.departamentosDe(p),
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
      `SELECT departamento, count(*)::int AS quantos FROM (
          SELECT unnest(departamentos) AS departamento FROM usuarios
           WHERE ativo = TRUE AND cardinality(departamentos) > 0
          UNION ALL
          -- Quem ainda nao reabriu o cadastro depois da mudanca so tem o campo
          -- antigo. Continua contando, senao a area sumiria das sugestoes.
          SELECT departamento FROM usuarios
           WHERE ativo = TRUE AND cardinality(departamentos) = 0
             AND departamento IS NOT NULL AND departamento <> ''
       ) t GROUP BY departamento`
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


// ---------------------------------------------------------------------------
// MURAL — comunicados da empresa
// ---------------------------------------------------------------------------
// Publicacao continua: nada expira, tudo fica para consulta no modulo Mural.
// Quem publica: administrador geral e quem for marcado como autor.
//
// Nao dispara e-mail. Comunicado por e-mail some na caixa de entrada e gasta a
// cota diaria do SendGrid; aqui a pessoa ve quando entra no portal.

function exigeAutorMural(req, res, next) {
  if (!req.usuario) return res.status(401).json({ erro: "Sessão expirada" });
  if (!mural.podePublicar(req.usuario)) {
    return res.status(403).json({ erro: "Você não tem permissão para publicar no mural." });
  }
  next();
}

// Monta a lista com curtidas, comentarios e o que ESTA pessoa ja fez.
// Uma consulta so, com subselects: com N publicacoes na tela, buscar curtida e
// comentario de cada uma daria 2N idas ao banco a cada carregamento.
async function listarPublicacoes(usuarioId, { limite = 20, offset = 0 } = {}) {
  const r = await db.query(
    `SELECT a.id, a.titulo, a.texto, a.tipo, a.fixado, a.criado_em, a.editado_em,
            a.popup_ate, a.autor_id, u.nome AS autor, u.cargo AS autor_cargo,
            EXISTS (SELECT 1 FROM aviso_imagem i WHERE i.aviso_id = a.id) AS tem_imagem,
            (SELECT count(*)::int FROM aviso_curtida c WHERE c.aviso_id = a.id) AS curtidas,
            (SELECT count(*)::int FROM aviso_comentario m WHERE m.aviso_id = a.id) AS comentarios,
            EXISTS (SELECT 1 FROM aviso_curtida c WHERE c.aviso_id = a.id AND c.usuario_id = $1) AS curti,
            EXISTS (SELECT 1 FROM aviso_leitura l WHERE l.aviso_id = a.id AND l.usuario_id = $1) AS li,
            (SELECT count(*)::int FROM aviso_edicao e WHERE e.aviso_id = a.id) AS edicoes
       FROM avisos a LEFT JOIN usuarios u ON u.id = a.autor_id
      WHERE a.arquivado = FALSE
      ORDER BY a.fixado DESC, a.criado_em DESC
      LIMIT $2 OFFSET $3`,
    [usuarioId, limite, offset]
  );
  return r.rows;
}

app.get("/api/mural", exigeLogin, async (req, res, next) => {
  try {
    const limite = Math.min(50, Math.max(1, parseInt(req.query.limite, 10) || 20));
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    const total = await db.query("SELECT count(*)::int n FROM avisos WHERE arquivado = FALSE");
    res.json({
      publicacoes: await listarPublicacoes(req.usuario.id, { limite, offset }),
      total: total.rows[0].n,
      podePublicar: mural.podePublicar(req.usuario),
    });
  } catch (e) {
    next(e);
  }
});

// O pop-up que ainda nao foi mostrado para ESTA pessoa.
//
// Devolve no maximo um: dois pop-ups seguidos viram uma sequencia de janelas
// para fechar, e a pessoa fecha as duas sem ler nenhuma.
app.get("/api/mural/popup", exigeLogin, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT a.id, a.titulo, a.texto, a.tipo, u.nome AS autor,
              EXISTS (SELECT 1 FROM aviso_imagem i WHERE i.aviso_id = a.id) AS tem_imagem
         FROM avisos a LEFT JOIN usuarios u ON u.id = a.autor_id
        WHERE a.arquivado = FALSE AND a.popup_ate IS NOT NULL AND a.popup_ate > NOW()
          AND NOT EXISTS (
            SELECT 1 FROM aviso_leitura l
             WHERE l.aviso_id = a.id AND l.usuario_id = $1 AND l.popup_em IS NOT NULL)
        ORDER BY a.criado_em
        LIMIT 1`,
    [req.usuario.id]);
    res.json({ publicacao: r.rows[0] || null });
  } catch (e) {
    next(e);
  }
});

// Marca como lido. `popup` = true quando a pessoa fechou a janela — e o que
// impede o mesmo pop-up de aparecer de novo no proximo acesso.
app.post("/api/mural/:id/lido", exigeLogin, async (req, res, next) => {
  try {
    const popup = Boolean(req.body && req.body.popup);
    await db.query(
      `INSERT INTO aviso_leitura (aviso_id, usuario_id, popup_em)
       VALUES ($1,$2,${popup ? "NOW()" : "NULL"})
       ON CONFLICT (aviso_id, usuario_id) DO UPDATE
         SET lido_em = NOW(),
             popup_em = COALESCE(aviso_leitura.popup_em, EXCLUDED.popup_em)`,
      [req.params.id, req.usuario.id]
    );
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mural/:id/curtir", exigeLogin, async (req, res, next) => {
  try {
    // Um clique liga, outro desliga — e o que as pessoas ja esperam de um
    // botao de curtir, sem precisar de duas rotas.
    const existe = await db.query(
      "DELETE FROM aviso_curtida WHERE aviso_id=$1 AND usuario_id=$2 RETURNING 1",
      [req.params.id, req.usuario.id]
    );
    if (!existe.rowCount) {
      await db.query(
        "INSERT INTO aviso_curtida (aviso_id, usuario_id) VALUES ($1,$2) ON CONFLICT DO NOTHING",
        [req.params.id, req.usuario.id]
      );
    }
    const n = await db.query(
      "SELECT count(*)::int n FROM aviso_curtida WHERE aviso_id=$1", [req.params.id]);
    res.json({ ok: true, curti: !existe.rowCount, curtidas: n.rows[0].n });
  } catch (e) {
    next(e);
  }
});

app.get("/api/mural/:id/comentarios", exigeLogin, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT c.id, c.texto, c.criado_em, c.usuario_id, u.nome AS autor,
              EXISTS (SELECT 1 FROM usuario_foto f WHERE f.usuario_id = c.usuario_id) AS tem_foto
         FROM aviso_comentario c LEFT JOIN usuarios u ON u.id = c.usuario_id
        WHERE c.aviso_id = $1 ORDER BY c.criado_em`,
      [req.params.id]
    );
    const aviso = await db.query("SELECT autor_id FROM avisos WHERE id=$1", [req.params.id]);
    res.json({
      comentarios: r.rows.map((c) => ({
        ...c,
        podeApagar: mural.podeApagarComentario(req.usuario, c, aviso.rows[0]),
      })),
    });
  } catch (e) {
    next(e);
  }
});

app.post("/api/mural/:id/comentarios", exigeLogin, async (req, res, next) => {
  try {
    const v = mural.validarComentario(req.body && req.body.texto);
    if (!v.ok) return res.status(400).json({ erro: "Escreva alguma coisa." });
    const r = await db.query(
      "INSERT INTO aviso_comentario (aviso_id, usuario_id, texto) VALUES ($1,$2,$3) RETURNING id",
      [req.params.id, req.usuario.id, v.texto]
    );
    res.json({ ok: true, id: r.rows[0].id });
  } catch (e) {
    next(e);
  }
});

app.delete("/api/mural/comentarios/:id", exigeLogin, async (req, res, next) => {
  try {
    const c = await db.query(
      `SELECT c.id, c.usuario_id, a.autor_id
         FROM aviso_comentario c JOIN avisos a ON a.id = c.aviso_id
        WHERE c.id = $1`, [req.params.id]);
    if (!c.rows[0]) return res.status(404).json({ erro: "Comentário não encontrado" });
    if (!mural.podeApagarComentario(req.usuario, c.rows[0], c.rows[0])) {
      return res.status(403).json({ erro: "Sem permissão para apagar este comentário." });
    }
    await db.query("DELETE FROM aviso_comentario WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

app.get("/api/mural/:id/imagem", exigeLogin, async (req, res, next) => {
  try {
    const r = await db.query("SELECT tipo, bytes FROM aviso_imagem WHERE aviso_id=$1", [req.params.id]);
    if (!r.rows[0]) return res.status(404).end();
    res.set("Content-Type", r.rows[0].tipo);
    res.set("Cache-Control", "private, max-age=3600");
    res.send(r.rows[0].bytes);
  } catch (e) {
    next(e);
  }
});

// Historico de edicao — aberto a todos, de proposito.
//
// O objetivo e nao gerar transtorno: quem leu o comunicado antes precisa poder
// conferir o que mudou, sem depender de alguem com acesso de administrador.
app.get("/api/mural/:id/edicoes", exigeLogin, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT e.editado_em, e.titulo_antes, e.texto_antes, u.nome AS editor
         FROM aviso_edicao e LEFT JOIN usuarios u ON u.id = e.editor_id
        WHERE e.aviso_id = $1 ORDER BY e.editado_em DESC`,
      [req.params.id]
    );
    res.json({ edicoes: r.rows });
  } catch (e) {
    next(e);
  }
});

// --- publicar, editar, apagar ---

app.post("/api/mural", exigeAutorMural, async (req, res, next) => {
  try {
    const v = mural.validarPublicacao(req.body || {});
    if (!v.ok) return res.status(400).json({ erro: v.erros[0] });
    const d = v.valores;
    const r = await db.query(
      `INSERT INTO avisos (titulo, texto, tipo, fixado, popup_ate, autor_id)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
      [d.titulo, d.texto, d.tipo, Boolean(req.body.fixado), d.popupAte, req.usuario.id]
    );
    const id = r.rows[0].id;

    if (req.body.imagem && req.body.imagemTipo) {
      const bytes = Buffer.from(String(req.body.imagem), "base64");
      if (!mural.IMAGEM_TIPOS.includes(req.body.imagemTipo)) {
        return res.status(400).json({ erro: "Formato de imagem não aceito." });
      }
      if (bytes.length > mural.IMAGEM_MAX_BYTES) {
        return res.status(413).json({ erro: "Imagem muito grande." });
      }
      await db.query(
        "INSERT INTO aviso_imagem (aviso_id, tipo, bytes) VALUES ($1,$2,$3)",
        [id, req.body.imagemTipo, bytes]
      );
    }

    await auth.auditar(req, "mural_publicado", {
      usuarioId: req.usuario.id, email: req.usuario.email,
      alvo: String(id), detalhe: { titulo: d.titulo, tipo: d.tipo, popup: Boolean(d.popupAte) },
    });
    res.json({ ok: true, id });
  } catch (e) {
    next(e);
  }
});

app.patch("/api/mural/:id", exigeLogin, async (req, res, next) => {
  try {
    const atual = await db.query("SELECT * FROM avisos WHERE id=$1", [req.params.id]);
    if (!atual.rows[0]) return res.status(404).json({ erro: "Publicação não encontrada" });
    if (!mural.podeEditar(req.usuario, atual.rows[0])) {
      return res.status(403).json({ erro: "Sem permissão para editar esta publicação." });
    }
    const v = mural.validarPublicacao(req.body || {});
    if (!v.ok) return res.status(400).json({ erro: v.erros[0] });
    const d = v.valores;

    // Guarda o texto ANTES na mesma transacao da alteracao. Publicacao que
    // muda sem deixar rastro gera discussao sobre o que estava escrito — e num
    // comunicado de empresa essa discussao custa caro.
    await db.transaction(async (c) => {
      await c.query(
        `INSERT INTO aviso_edicao (aviso_id, editor_id, titulo_antes, texto_antes)
         VALUES ($1,$2,$3,$4)`,
        [req.params.id, req.usuario.id, atual.rows[0].titulo, atual.rows[0].texto]
      );
      await c.query(
        `UPDATE avisos SET titulo=$1, texto=$2, tipo=$3, fixado=$4, editado_em=NOW()
          WHERE id=$5`,
        [d.titulo, d.texto, d.tipo, Boolean(req.body.fixado), req.params.id]
      );
    });

    await auth.auditar(req, "mural_editado", {
      usuarioId: req.usuario.id, email: req.usuario.email, alvo: String(req.params.id),
    });
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Arquivar, e nao apagar: o mural e historico, e curtida e comentario das
// pessoas somem junto com a publicacao. Some da tela, continua no banco.
app.delete("/api/mural/:id", exigeLogin, async (req, res, next) => {
  try {
    const atual = await db.query("SELECT autor_id FROM avisos WHERE id=$1", [req.params.id]);
    if (!atual.rows[0]) return res.status(404).json({ erro: "Publicação não encontrada" });
    if (!mural.podeEditar(req.usuario, atual.rows[0])) {
      return res.status(403).json({ erro: "Sem permissão para remover esta publicação." });
    }
    await db.query("UPDATE avisos SET arquivado = TRUE WHERE id = $1", [req.params.id]);
    await auth.auditar(req, "mural_arquivado", {
      usuarioId: req.usuario.id, email: req.usuario.email, alvo: String(req.params.id),
    });
    res.json({ ok: true });
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
      id: m.id, nome: m.nome, descricao: m.descricao, base: m.base,
      externo: m.externo || null, icone: m.icone,
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
      id: m.id, nome: m.nome, descricao: m.descricao, base: m.base,
      externo: m.externo || null, icone: m.icone,
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
// COMUNICADOR INTERNO
// ----------------------------------------------------------------------------
// Conversa direta entre logins do UniGestao. Mora no Core, e nao num modulo,
// porque quem sabe quem e cada pessoa e o Core — e assim a conversa acompanha
// quem trocar de sistema: comeca no CRM, continua nas Tarefas, e a mesma.
//
// As regras (o que vale como mensagem, quem apaga, o que e "online") estao em
// core/chat.js. Aqui embaixo e so encanamento.
// ---------------------------------------------------------------------------

// A trava de liberacao (ver core/chat.js). Quem nao esta liberado recebe 403 e
// a tela simplesmente nao monta o chat — sem mensagem de erro, porque para
// essa pessoa o recurso ainda nao existe.
function exigeChat(req, res, next) {
  if (!req.usuario) return res.status(401).json({ erro: "Sessão expirada" });
  if (!chat.podeUsar(req.usuario)) return res.status(403).json({ erro: "Comunicador não liberado" });
  next();
}

// Acha a conversa da dupla, ou cria.
//
// O `ON CONFLICT` com nova leitura nao e preciosismo: se as duas pessoas
// clicarem uma na outra no mesmo segundo, os dois INSERTs correm juntos e um
// perde. Quem perde le a conversa que o outro acabou de criar, em vez de
// estourar um erro na cara de quem so queria mandar um "bom dia".
async function conversaDaDupla(euId, outroId) {
  const par = chat.parDe(euId, outroId);
  if (!par) return null;

  const achada = await db.query("SELECT id FROM conversas WHERE a_id=$1 AND b_id=$2", par);
  if (achada.rows[0]) return achada.rows[0].id;

  const nova = await db.query(
    `INSERT INTO conversas (a_id, b_id) VALUES ($1,$2)
     ON CONFLICT (a_id, b_id) DO NOTHING RETURNING id`, par
  );
  if (nova.rows[0]) return nova.rows[0].id;

  const doOutro = await db.query("SELECT id FROM conversas WHERE a_id=$1 AND b_id=$2", par);
  return doOutro.rows[0] ? doOutro.rows[0].id : null;
}

// Confere que a pessoa participa da conversa.
//
// Roda em TODA leitura, e nao so na abertura. Sem isto, trocar o numero no
// endereco (/api/chat/conversa/42/...) leria a conversa dos outros — o tipo de
// falha que ninguem percebe porque a tela nunca oferece esse caminho.
async function souDaConversa(conversaId, usuarioId) {
  const r = await db.query(
    "SELECT id, a_id, b_id FROM conversas WHERE id=$1 AND (a_id=$2 OR b_id=$2)",
    [conversaId, usuarioId]
  );
  return r.rows[0] || null;
}

// A lista da esquerda: todo mundo do sistema, quem esta online, o que cada um
// mandou por ultimo e quantas mensagens novas ha.
//
// Sai tudo numa consulta so. Em N consultas (uma por pessoa) seriam 45 idas ao
// banco a cada vez que alguem abre o chat — e o chat abre em toda pagina.
app.get("/api/chat/pessoas", exigeChat, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT u.id, u.nome, u.email, u.departamento_principal AS departamento, u.cargo,
              (u.visto_em > NOW() - ($2 || ' seconds')::interval) AS online,
              (f.usuario_id IS NOT NULL) AS tem_foto,
              c.id AS conversa_id,
              COALESCE((SELECT COUNT(*) FROM mensagens m
                         WHERE m.conversa_id = c.id
                           AND m.autor_id <> $1
                           AND m.apagada_em IS NULL
                           AND m.id > COALESCE(l.lido_ate, 0)), 0) AS nao_lidas,
              ult.texto, ult.criada_em, ult.tem_imagem, ult.apagada_em,
              (ult.autor_id = $1) AS minha
         FROM usuarios u
         LEFT JOIN usuario_foto f ON f.usuario_id = u.id
         LEFT JOIN conversas c
                ON c.a_id = LEAST(u.id, $1) AND c.b_id = GREATEST(u.id, $1)
         LEFT JOIN conversa_leitura l
                ON l.conversa_id = c.id AND l.usuario_id = $1
         LEFT JOIN LATERAL (
                SELECT texto, criada_em, tem_imagem, apagada_em, autor_id
                  FROM mensagens m2 WHERE m2.conversa_id = c.id
                 ORDER BY m2.id DESC LIMIT 1
              ) ult ON TRUE
        WHERE u.ativo AND u.id <> $1
        ORDER BY ult.criada_em DESC NULLS LAST, u.nome`,
      [req.usuario.id, String(chat.ONLINE_SEGUNDOS)]
    );

    // A lista so mostra quem tambem esta liberado a usar o chat. Sem esta
    // metade, alguem apareceria na lista e receberia mensagem que nunca vai ler.
    const liberados = chat.liberados();
    const visiveis = liberados.length
      ? r.rows.filter((p) => liberados.includes(String(p.email || "").toLowerCase()))
      : r.rows;

    res.json({
      pessoas: visiveis.map((p) => ({
        id: p.id,
        nome: p.nome,
        departamento: p.departamento || "",
        cargo: p.cargo || "",
        online: Boolean(p.online),
        // Quem tem foto. Sem isto a tela pede a foto de todo mundo e leva 404
        // de quem nao tem — 40 erros no console a cada vez que a lista desenha,
        // que e exatamente o barulho que faz ninguem mais olhar para o console.
        temFoto: Boolean(p.tem_foto),
        naoLidas: Number(p.nao_lidas || 0),
        ultima: p.criada_em
          ? {
              texto: p.apagada_em ? "" : (p.texto || ""),
              apagada: Boolean(p.apagada_em),
              temImagem: Boolean(p.tem_imagem),
              em: p.criada_em,
              minha: Boolean(p.minha),
            }
          : null,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// Abrir a conversa com alguem. Cria na hora se for a primeira vez.
app.get("/api/chat/com/:outroId", exigeChat, async (req, res, next) => {
  try {
    const outro = await db.query(
      "SELECT id, nome, departamento_principal AS departamento, cargo FROM usuarios WHERE id=$1 AND ativo",
      [req.params.outroId]
    );
    if (!outro.rows[0]) return res.status(404).json({ erro: "Pessoa não encontrada" });

    const conversaId = await conversaDaDupla(req.usuario.id, req.params.outroId);
    if (!conversaId) return res.status(400).json({ erro: "Conversa inválida" });

    const msgs = await db.query(
      `SELECT id, autor_id, texto, tem_imagem, sobre, link, criada_em, apagada_em
         FROM mensagens WHERE conversa_id=$1 ORDER BY id DESC LIMIT 60`,
      [conversaId]
    );

    // Abrir a conversa e ler. Marcar aqui — e nao numa chamada a parte — evita
    // o caso de a tela abrir, a pessoa ler e o contador continuar vermelho.
    await marcarLido(conversaId, req.usuario.id);

    res.json({
      conversaId,
      outro: outro.rows[0],
      mensagens: msgs.rows.reverse().map((m) => formatarMensagem(m, req.usuario.id)),
    });
  } catch (e) {
    next(e);
  }
});

function formatarMensagem(m, euId) {
  return {
    id: Number(m.id),
    minha: m.autor_id === euId,
    texto: m.apagada_em ? "" : (m.texto || ""),
    apagada: Boolean(m.apagada_em),
    temImagem: Boolean(m.tem_imagem) && !m.apagada_em,
    sobre: m.apagada_em ? null : (m.sobre || null),
    link: m.apagada_em ? null : (m.link || null),
    em: m.criada_em,
  };
}

async function marcarLido(conversaId, usuarioId, ate) {
  await db.query(
    `INSERT INTO conversa_leitura (conversa_id, usuario_id, lido_ate)
     VALUES ($1, $2, COALESCE($3, (SELECT COALESCE(MAX(id),0) FROM mensagens WHERE conversa_id=$1)))
     ON CONFLICT (conversa_id, usuario_id)
     DO UPDATE SET lido_ate = GREATEST(conversa_leitura.lido_ate, EXCLUDED.lido_ate)`,
    [conversaId, usuarioId, ate == null ? null : Number(ate)]
  );
}

app.post("/api/chat/conversa/:id/lido", exigeChat, async (req, res, next) => {
  try {
    const conversa = await souDaConversa(req.params.id, req.usuario.id);
    if (!conversa) return res.status(404).json({ erro: "Conversa não encontrada" });
    await marcarLido(conversa.id, req.usuario.id, req.body.ate);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// Mandar mensagem.
app.post("/api/chat/com/:outroId", exigeChat, async (req, res, next) => {
  try {
    const v = chat.validarMensagem(req.body || {});
    if (!v.ok) return res.status(400).json({ erro: v.erro });

    const destino = await db.query("SELECT id FROM usuarios WHERE id=$1 AND ativo", [
      req.params.outroId,
    ]);
    if (!destino.rows[0]) return res.status(404).json({ erro: "Pessoa não encontrada" });

    const conversaId = await conversaDaDupla(req.usuario.id, req.params.outroId);
    if (!conversaId) return res.status(400).json({ erro: "Conversa inválida" });

    let bytes = null;
    if (req.body.imagem) {
      bytes = Buffer.from(String(req.body.imagem), "base64");
      if (bytes.length > chat.IMAGEM_MAX_BYTES) {
        return res.status(413).json({ erro: "Print muito grande — reduza a imagem." });
      }
    }

    const r = await db.query(
      `INSERT INTO mensagens (conversa_id, autor_id, texto, tem_imagem, sobre, link)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING id, autor_id, texto, tem_imagem, sobre, link, criada_em, apagada_em`,
      [conversaId, req.usuario.id, v.valores.texto, Boolean(bytes), v.valores.sobre, v.valores.link]
    );
    const msg = r.rows[0];

    if (bytes) {
      await db.query(
        "INSERT INTO mensagem_imagem (mensagem_id, tipo, bytes) VALUES ($1,$2,$3)",
        [msg.id, req.body.imagemTipo, bytes]
      );
    }

    // Quem escreveu ja leu o que escreveu.
    await marcarLido(conversaId, req.usuario.id, msg.id);

    res.json({ ok: true, conversaId, mensagem: formatarMensagem(msg, req.usuario.id) });
  } catch (e) {
    next(e);
  }
});

// O print. So quem participa da conversa ve.
app.get("/api/chat/mensagem/:id/imagem", exigeChat, async (req, res, next) => {
  try {
    const r = await db.query(
      `SELECT i.tipo, i.bytes
         FROM mensagem_imagem i
         JOIN mensagens m ON m.id = i.mensagem_id
         JOIN conversas c ON c.id = m.conversa_id
        WHERE i.mensagem_id = $1
          AND m.apagada_em IS NULL
          AND (c.a_id = $2 OR c.b_id = $2)`,
      [req.params.id, req.usuario.id]
    );
    if (!r.rows[0]) return res.status(404).end();
    res.set("Content-Type", r.rows[0].tipo);
    res.set("Cache-Control", "private, max-age=3600");
    res.send(r.rows[0].bytes);
  } catch (e) {
    next(e);
  }
});

// A foto de quem esta na conversa.
//
// Existe separada de /api/foto/:id por causa do caminho: dentro de um modulo o
// chat vive sob /<modulo>/__ug/chat/..., e uma imagem apontando para a raiz do
// dominio nao chegaria aqui. Mesma consulta, endereco que funciona nos dois
// lugares.
app.get("/api/chat/foto/:id", exigeChat, async (req, res, next) => {
  try {
    const r = await db.query("SELECT tipo, bytes FROM usuario_foto WHERE usuario_id=$1", [
      req.params.id,
    ]);
    if (!r.rows[0]) return res.status(404).end();
    res.set("Content-Type", r.rows[0].tipo);
    res.set("Cache-Control", "private, max-age=600");
    res.send(r.rows[0].bytes);
  } catch (e) {
    next(e);
  }
});

// Apagar: esconde para os dois, mas a linha FICA no banco.
//
// E o que sustenta a promessa do resgate: se apagar sumisse de verdade, "a
// diretoria pode pedir a conversa" seria uma promessa que o sistema nao
// cumpre justamente no caso em que ela importa.
app.delete("/api/chat/mensagem/:id", exigeChat, async (req, res, next) => {
  try {
    const r = await db.query("SELECT id, autor_id, conversa_id FROM mensagens WHERE id=$1", [
      req.params.id,
    ]);
    const msg = r.rows[0];
    if (!msg) return res.status(404).json({ erro: "Mensagem não encontrada" });
    if (!chat.podeApagar(req.usuario, msg)) {
      return res.status(403).json({ erro: "Só quem escreveu pode apagar" });
    }
    await db.query("UPDATE mensagens SET apagada_em = NOW() WHERE id=$1 AND apagada_em IS NULL", [
      msg.id,
    ]);
    res.json({ ok: true });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Tempo real (SSE)
// ----------------------------------------------------------------------------
// O navegador abre esta conexao e deixa aberta; o servidor escreve nela quando
// chega mensagem. E HTTP comum — passa pela Fachada e por qualquer proxy sem
// configuracao, ao contrario de WebSocket.
//
// A checagem e uma consulta ao BANCO a cada 2 segundos, e nao um registro de
// conexoes na memoria do processo. Parece menos elegante e e mais correto: se
// um dia o Core rodar em duas instancias no Railway, a mensagem que a instancia
// A recebeu tem que chegar em quem esta pendurado na instancia B. Guardando as
// conexoes na memoria, isso falharia em silencio — metade das mensagens
// simplesmente nao apareceria, e so na tela de algumas pessoas.
//
// Custo: ~45 pessoas x uma consulta indexada a cada 2s. Se um dia pesar, o
// caminho e LISTEN/NOTIFY do proprio Postgres — sem trocar nada do lado da tela.
// ---------------------------------------------------------------------------
app.get("/api/chat/stream", exigeChat, async (req, res, next) => {
  try {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      // Proxy que junta pedacos antes de repassar mataria o tempo real: a
      // mensagem so chegaria quando o buffer enchesse. Isto pede para nao.
      "X-Accel-Buffering": "no",
    });
    res.write("retry: 5000\n\n");

    const euId = req.usuario.id;
    const inicio = await db.query("SELECT COALESCE(MAX(id),0) AS ultimo FROM mensagens");
    let ultimo = Number(req.query.desde || inicio.rows[0].ultimo);

    await db.query("UPDATE usuarios SET visto_em = NOW() WHERE id=$1", [euId]);

    let ocupado = false;
    async function olhar() {
      if (ocupado || res.writableEnded) return;
      ocupado = true;
      try {
        const r = await db.query(
          `SELECT m.id, m.conversa_id, m.autor_id, m.texto, m.tem_imagem, m.sobre, m.link,
                  m.criada_em, m.apagada_em, u.nome AS autor_nome,
                  CASE WHEN c.a_id = $1 THEN c.b_id ELSE c.a_id END AS outro_id
             FROM mensagens m
             JOIN conversas c ON c.id = m.conversa_id
             JOIN usuarios  u ON u.id = m.autor_id
            WHERE (c.a_id = $1 OR c.b_id = $1) AND m.id > $2 AND m.apagada_em IS NULL
            ORDER BY m.id LIMIT 50`,
          [euId, ultimo]
        );
        for (const m of r.rows) {
          ultimo = Number(m.id);
          const dado = {
            conversaId: Number(m.conversa_id),
            outroId: m.outro_id,
            autorNome: m.autor_nome,
            mensagem: formatarMensagem(m, euId),
          };
          res.write("event: mensagem\ndata: " + JSON.stringify(dado) + "\n\n");
        }
      } catch (e) {
        console.error("[chat] falha ao olhar mensagens novas:", e.message);
      } finally {
        ocupado = false;
      }
    }

    const olho = setInterval(olhar, 2000);

    // A batida do coracao faz duas coisas: mantem a conexao viva atravessando
    // proxy com tempo limite, e e ela que marca a pessoa como online. Por isso
    // "online" quer dizer "esta com o sistema aberto agora", e nao "abriu uma
    // tela alguma hora hoje".
    const batida = setInterval(async () => {
      if (res.writableEnded) return;
      res.write(": batida\n\n");
      try {
        await db.query("UPDATE usuarios SET visto_em = NOW() WHERE id=$1", [euId]);
      } catch (e) {
        console.error("[chat] falha ao marcar presenca:", e.message);
      }
    }, 25000);

    req.on("close", () => {
      clearInterval(olho);
      clearInterval(batida);
      res.end();
    });
  } catch (e) {
    next(e);
  }
});

// ---------------------------------------------------------------------------
// Resgate de conversa — administrador geral, com motivo registrado
// ----------------------------------------------------------------------------
// Ninguem le a conversa dos outros no dia a dia: nao existe tela, nao existe
// atalho, e o administrador geral tambem nao ve. O que existe e ISTO — um
// caminho unico, deliberado e que deixa rastro, para quando a diretoria pedir.
//
// O motivo escrito nao e burocracia. Ele e o que, seis meses depois, separa um
// resgate legitimo de bisbilhotice — inclusive para proteger quem resgatou de
// boa-fe e precisa explicar o que foi ver e a pedido de quem.
// ---------------------------------------------------------------------------
app.post("/api/admin/chat/resgate", exigeSuperAdmin, async (req, res, next) => {
  try {
    const v = chat.validarResgate(req.body || {});
    if (!v.ok) return res.status(400).json({ erro: v.erro });

    const par = chat.parDe(req.body.aId, req.body.bId);
    if (!par) return res.status(400).json({ erro: "Escolha duas pessoas diferentes." });

    const gente = await db.query("SELECT id, nome, email FROM usuarios WHERE id = ANY($1)", [par]);
    if (gente.rows.length !== 2) return res.status(404).json({ erro: "Pessoa não encontrada" });

    const conversa = await db.query("SELECT id FROM conversas WHERE a_id=$1 AND b_id=$2", par);
    const conversaId = conversa.rows[0] ? conversa.rows[0].id : null;

    const msgs = conversaId
      ? (await db.query(
          `SELECT m.id, m.texto, m.tem_imagem, m.sobre, m.link, m.criada_em, m.apagada_em,
                  u.nome AS autor
             FROM mensagens m JOIN usuarios u ON u.id = m.autor_id
            WHERE m.conversa_id = $1 ORDER BY m.id`,
          [conversaId]
        )).rows
      : [];

    // O registro vai ANTES da resposta, de proposito: se gravar a auditoria
    // falhar, ninguem le nada. Resgate sem rastro nao pode acontecer.
    await auth.auditar(req, "chat_resgatado", {
      usuarioId: req.usuario.id,
      email: req.usuario.email,
      alvo: par.join(" + "),
      detalhe: {
        motivo: v.motivo,
        pessoas: gente.rows.map((g) => g.nome),
        mensagens: msgs.length,
      },
    });

    res.json({
      pessoas: gente.rows,
      conversaId,
      mensagens: msgs.map((m) => ({
        id: Number(m.id),
        autor: m.autor,
        texto: m.texto || "",
        apagada: Boolean(m.apagada_em),
        temImagem: Boolean(m.tem_imagem),
        sobre: m.sobre || null,
        em: m.criada_em,
      })),
    });
  } catch (e) {
    next(e);
  }
});

// A imagem dentro de um resgate. Mesmo caminho deliberado: so administrador
// geral, e ja registrado pelo resgate que a listou.
app.get("/api/admin/chat/mensagem/:id/imagem", exigeSuperAdmin, async (req, res, next) => {
  try {
    const r = await db.query("SELECT tipo, bytes FROM mensagem_imagem WHERE mensagem_id=$1", [
      req.params.id,
    ]);
    if (!r.rows[0]) return res.status(404).end();
    res.set("Content-Type", r.rows[0].tipo);
    res.send(r.rows[0].bytes);
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
        "SELECT telefone, ramal, departamento, departamentos, cargo FROM usuarios WHERE id = $1",
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

    // Sistema de terceiro nao recebe identidade: nao ha modulo nosso do outro
    // lado para confiar nela. Se algum dia isto passar, sera porque alguem
    // apontou a Fachada para um endereco de fora — e a chave interna estaria
    // viajando para fora da rede privada. Melhor recusar aqui, de uma vez.
    if (modulos.ehExterno(moduloId)) {
      return res.status(400).json({ erro: "Este sistema não é acessado pelo portal" });
    }

    // A lista do que a pessoa alcanca acompanha a resposta para a Fachada
    // montar o menu de troca de modulo na barra. Sem isso ela so sabe onde a
    // pessoa esta, e trocar de sistema exigiria voltar ao inicio a cada vez.
    const alcance = usuario.super_admin
      ? modulos.listar().map((m) => ({ id: m.id, nome: m.nome, base: m.base,
                                       externo: m.externo || null }))
      : (await db.query(
          "SELECT modulo FROM usuario_modulos WHERE usuario_id = $1", [usuario.id]
        )).rows
          .filter((x) => modulos.existe(x.modulo))
          .map((x) => {
            const m = modulos.get(x.modulo);
            return { id: x.modulo, nome: m.nome, base: m.base, externo: m.externo || null };
          })
          .sort((a, b) => a.nome.localeCompare(b.nome, "pt-BR"));

    if (usuario.super_admin) {
      // Cada modulo batiza o proprio papel de administrador. Mandar "admin"
      // para todos fazia o CRM — que chama de "administrador" — recusar o
      // administrador geral na propria tela de usuarios.
      return res.json({
        id: usuario.id, nome: usuario.nome, email: usuario.email,
        // Onde a pessoa esta lotada. A Gestao de Tarefas usa isto para pos-la
        // na equipe certa; os outros modulos ignoram.
        departamento: usuario.departamento_principal || "",
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
      departamento: usuario.departamento_principal || "",
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
      externo: m.externo || null,
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
              u.departamento_principal,
              u.senha_temp, u.ultimo_login, u.mural_autor, u.checklists_ver,
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
    // O departamento principal e onde a pessoa esta lotada — e o que vira equipe
    // na Gestao de Tarefas. Ele tambem entra na lista `departamentos`, que
    // alimenta a Agenda de Contatos: assim a agenda ja nasce util, e a pessoa
    // ajusta depois no perfil se responder por mais de uma area.
    const departamento = String(req.body.departamentoPrincipal || "").trim();
    await db.query(
      `INSERT INTO usuarios (id, nome, email, senha, senha_temp, super_admin, mural_autor,
                             checklists_ver, departamento_principal, departamentos)
       VALUES ($1,$2,$3,$4,TRUE,$5,$6,$7,$8,$9::text[])`,
      [id, nome, email, auth.gerarHash(senha), Boolean(req.body.superAdmin),
       Boolean(req.body.muralAutor), Boolean(req.body.checklistsVer),
       // Lista VAZIA, nunca null: `departamentos` e NOT NULL. Mandar null aqui
       // derrubava a criacao de acesso inteira sempre que o administrador nao
       // escolhia departamento — e nao escolher e o caso comum.
       departamento || null, departamento ? [departamento] : []]
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

// Reenviar o convite: a pessoa nao recebeu o e-mail (caixa de spam, endereco
// digitado errado e depois corrigido, filtro da empresa) e precisa entrar hoje.
//
// GERA UMA SENHA NOVA, e nao reenvia a antiga: o Core guarda so o hash, entao a
// senha original nao existe mais em lugar nenhum para ser reenviada. Como efeito
// colateral util, quem tiver visto a senha velha em algum lugar perde o acesso.
//
// A senha nova volta na resposta de proposito — o administrador consegue passar
// por WhatsApp se o e-mail falhar de novo, que e justamente o caso em que este
// botao e usado. Ela some da tela ao fechar; nao fica gravada em lugar nenhum.
app.post("/api/admin/usuarios/:id/reenviar-convite", exigeSuperAdmin, async (req, res, next) => {
  try {
    const id = req.params.id;
    const r = await db.query(
      `SELECT u.id, u.nome, u.email, u.ativo,
              COALESCE(json_agg(json_build_object('modulo', m.modulo, 'papel', m.papel))
                       FILTER (WHERE m.modulo IS NOT NULL), '[]') AS modulos
         FROM usuarios u
         LEFT JOIN usuario_modulos m ON m.usuario_id = u.id
        WHERE u.id = $1
        GROUP BY u.id`,
      [id]
    );
    const dono = r.rows[0];
    if (!dono) return res.status(404).json({ erro: "Usuário não encontrado" });
    if (!dono.ativo) {
      return res.status(400).json({ erro: "Usuário está inativo. Ative antes de reenviar o convite." });
    }

    const senha = auth.senhaProvisoria();
    await db.query(
      "UPDATE usuarios SET senha = $2, senha_temp = TRUE WHERE id = $1",
      [id, auth.gerarHash(senha)]
    );
    // Sessoes abertas com a senha velha caem: o convite reenviado e um recomeco,
    // e deixar sessao antiga viva contradiria a senha nova.
    await auth.encerrarSessoesDoUsuario(id);
    await auth.auditar(req, "convite_reenviado", { alvo: id, detalhe: { email: dono.email } });

    const aviso = await avisarSeMarcado(req, () =>
      correio.avisarContaNova({
        nome: dono.nome, email: dono.email, senha, modulos: paraEmail(dono.modulos),
      })
    );
    res.json({ ok: true, senha, email: aviso });
  } catch (e) {
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
    // Trocar o departamento aqui move a pessoa de equipe na Gestao de Tarefas —
    // ver a sincronizacao em unigestao.js, do lado de la.
    if (req.body.departamentoPrincipal !== undefined) {
      set("departamento_principal", String(req.body.departamentoPrincipal).trim() || null);
    }
    if (req.body.email !== undefined) set("email", String(req.body.email).toLowerCase().trim());
    if (req.body.ativo !== undefined) set("ativo", Boolean(req.body.ativo));
    if (req.body.superAdmin !== undefined) set("super_admin", Boolean(req.body.superAdmin));
    if (req.body.muralAutor !== undefined) set("mural_autor", Boolean(req.body.muralAutor));
    if (req.body.checklistsVer !== undefined) set("checklists_ver", Boolean(req.body.checklistsVer));
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
