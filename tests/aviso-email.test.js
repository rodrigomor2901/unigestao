// Testa o aviso por e-mail que o Admin Geral manda ao criar ou alterar um
// acesso.
//
// Nada e enviado de verdade: o Core roda com EMAIL_ARQUIVO apontando para um
// arquivo (ver dev-local.js), entao cada mensagem vira uma linha la em vez de
// ir para o SendGrid. O teste le esse arquivo. Isso tambem garante que rodar a
// suite nunca alcance uma pessoa de verdade.
//
// O que precisa valer:
//   - criar acesso -> e-mail com a senha e a lista de modulos
//   - liberar modulo depois -> e-mail SEM senha, so com o modulo novo
//   - trocar a senha -> e-mail de senha redefinida
//   - mexer no nome ou no papel de um modulo que ja tinha -> e-mail nenhum
//   - desmarcar "avisar", ou pessoa desativada -> e-mail nenhum
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");
const correio = require("../core/email.js");

const CORE = "http://localhost:3000";
const CAIXA = path.join(__dirname, "..", ".emails-dev.jsonl");

let falhas = 0;
function ok(c, m) { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; }

// Le o que o Core gravou desde a ultima limpeza.
function saiuDaCaixa() {
  if (!fs.existsSync(CAIXA)) return [];
  return fs.readFileSync(CAIXA, "utf8").split("\n").filter(Boolean).map(JSON.parse);
}
function limparCaixa() {
  fs.writeFileSync(CAIXA, "", "utf8");
}

(async () => {
  const pool = new Pool({ connectionString: "postgres://postgres:teste@localhost:55987/unigestao" });
  // Bloqueio por IP e estado global entre os arquivos de teste — ver permissao.test.js
  await pool.query("DELETE FROM login_attempts");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'aviso.%@uniseter.com'");

  const idAdm = "u" + crypto.randomBytes(9).toString("hex");
  await pool.query(
    `INSERT INTO usuarios (id,nome,email,senha,super_admin,senha_temp) VALUES ($1,$2,$3,$4,TRUE,FALSE)`,
    [idAdm, "Aviso Admin", "aviso.adm@uniseter.com", auth.gerarHash("SenhaTeste@123")]
  );
  // Sessao gravada direto no banco, como em papel-admin.test.js: o login de
  // administrador geral obriga a cadastrar 2FA, e o assunto aqui e outro.
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1,$2,NOW() + INTERVAL '1 hour')",
    [token, idAdm]
  );
  const cookie = "unigestao_sessao=" + token;
  const chamar = (url, metodo, corpo) => fetch(CORE + url, {
    method: metodo, headers: { "Content-Type": "application/json", cookie },
    body: JSON.stringify(corpo),
  }).then((r) => r.json());

  // TRAVA DE SEGURANCA — antes de criar qualquer cadastro.
  // Se este arquivo rodasse contra um Core em modo de envio real, os cadastros
  // de teste abaixo mandariam e-mail para enderecos @uniseter.com que existem
  // no dominio da empresa. Melhor parar aqui do que descobrir depois.
  const estado = await fetch(CORE + "/api/admin/email", { headers: { cookie } }).then((r) => r.json());
  if (estado.modo !== "rascunho") {
    console.log("  FALHA  o Core esta em modo '" + estado.modo + "', nao 'rascunho'.");
    console.log("         Este teste so roda com EMAIL_ARQUIVO definido — use: npm run dev");
    await pool.query("DELETE FROM usuarios WHERE email LIKE 'aviso.%@uniseter.com'");
    await pool.end();
    process.exit(1);
  }
  console.log("\n=== TRAVA ===");
  ok(true, "o Core esta em modo rascunho — nada sai para o mundo");

  console.log("\n=== CRIAR ACESSO ===");
  limparCaixa();
  const criado = await chamar("/api/admin/usuarios", "POST", {
    nome: "Fulano de Tal", email: "aviso.novo@uniseter.com", senha: "SenhaTeste@123",
    modulos: [{ modulo: "eventos", papel: "gestao" }, { modulo: "crm", papel: "vendedor" }],
  });
  let caixa = saiuDaCaixa();
  ok(criado.ok === true, "acesso criado");
  ok(caixa.length === 1, "saiu exatamente um e-mail");
  ok(caixa[0] && caixa[0].para === "aviso.novo@uniseter.com", "foi para o endereco certo");
  ok(caixa[0] && /acesso ao UniGest/i.test(caixa[0].assunto), "assunto e o de acesso novo");
  ok(caixa[0] && caixa[0].html.includes("SenhaTeste@123"), "a senha vai no e-mail");
  ok(caixa[0] && caixa[0].html.includes("Gestão de Eventos") && caixa[0].html.includes("CRM Comercial"),
     "aparece o nome do sistema, nao o identificador");
  ok(caixa[0] && caixa[0].html.includes("Vendedor"), "o papel aparece em portugues, nao 'vendedor' cru");
  ok(caixa[0] && caixa[0].html.includes(correio.URL_PORTAL), "o endereco do portal aparece");
  ok(criado.email && criado.email.ok === true, "a resposta conta que o e-mail saiu");

  console.log("\n=== LIBERAR UM MODULO DEPOIS ===");
  limparCaixa();
  await chamar("/api/admin/usuarios/" + criado.id, "PATCH", {
    modulos: [{ modulo: "eventos", papel: "gestao" }, { modulo: "crm", papel: "vendedor" },
              { modulo: "documentos", papel: "consulta" }],
  });
  caixa = saiuDaCaixa();
  ok(caixa.length === 1, "saiu um e-mail");
  ok(caixa[0] && /Novo m.dulo/i.test(caixa[0].assunto), "assunto e o de modulo novo");
  ok(caixa[0] && !/senha provis/i.test(caixa[0].html), "esse e-mail NAO fala em senha provisoria");
  ok(caixa[0] && caixa[0].html.includes("Controle de Documentos"), "cita o modulo novo");
  ok(caixa[0] && !caixa[0].html.includes("CRM Comercial"),
     "nao repete os modulos que a pessoa ja tinha");

  console.log("\n=== ALTERACAO QUE NAO MERECE E-MAIL ===");
  limparCaixa();
  await chamar("/api/admin/usuarios/" + criado.id, "PATCH", { nome: "Fulano de Tal e Silva" });
  ok(saiuDaCaixa().length === 0, "trocar o nome nao dispara e-mail");

  limparCaixa();
  await chamar("/api/admin/usuarios/" + criado.id, "PATCH", {
    modulos: [{ modulo: "eventos", papel: "admin" }, { modulo: "crm", papel: "vendedor" },
              { modulo: "documentos", papel: "consulta" }],
  });
  ok(saiuDaCaixa().length === 0, "mudar o papel de um modulo que ja tinha nao dispara e-mail");

  console.log("\n=== SENHA REDEFINIDA ===");
  limparCaixa();
  await chamar("/api/admin/usuarios/" + criado.id, "PATCH", { senha: "OutraSenha@456" });
  caixa = saiuDaCaixa();
  ok(caixa.length === 1 && /redefinida/i.test(caixa[0].assunto), "saiu o e-mail de senha redefinida");
  ok(caixa[0] && caixa[0].html.includes("OutraSenha@456"), "com a senha nova");
  ok(caixa[0] && !/conta j. est. criada/i.test(caixa[0].html),
     "nao usa o texto de conta nova para quem ja tinha conta");

  console.log("\n=== QUANDO NAO DEVE SAIR ===");
  limparCaixa();
  const semAviso = await chamar("/api/admin/usuarios", "POST", {
    nome: "Sem Aviso", email: "aviso.quieto@uniseter.com", senha: "SenhaTeste@123",
    avisar: false, modulos: [{ modulo: "eventos", papel: "gestao" }],
  });
  ok(semAviso.ok === true, "acesso criado mesmo sem avisar");
  ok(saiuDaCaixa().length === 0, "desmarcar 'avisar' segura o e-mail");
  ok(semAviso.email && semAviso.email.ignorado === true, "a resposta diz que foi ignorado");

  limparCaixa();
  await chamar("/api/admin/usuarios/" + criado.id, "PATCH", { ativo: false, senha: "MaisUma@789" });
  ok(saiuDaCaixa().length === 0, "pessoa desativada nao recebe e-mail");

  console.log("\n=== O TEXTO DO E-MAIL ===");
  const htmlMod = correio.htmlModuloNovo({ nome: "Fulano", modulos: [{ nome: "Gestão de Tarefas" }] });
  ok(/senha continua a mesma/i.test(htmlMod), "o e-mail de modulo novo diz que a senha nao mudou");

  const perigoso = correio.htmlContaNova({
    nome: '<img src=x onerror=alert(1)>', email: "f@x.com", senha: "a", modulos: [],
  });
  ok(!perigoso.includes("<img src=x"), "nome com HTML e escapado");

  const semNome = correio.htmlContaNova({ nome: "", email: "f@x.com", senha: "a", modulos: [] });
  ok(!semNome.includes("Olá,"), "sem nome cadastrado nao sai 'Olá,' com virgula solta");

  limparCaixa();
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'aviso.%@uniseter.com'");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
