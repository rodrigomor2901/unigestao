// Integracao real do modulo Movimentacao Operacional (Fase 1).
//
// Sobe o Sistema de Lancamento de Extra de verdade, poe uma Fachada na frente
// e verifica que a identidade do UniGestao chega la dentro com o papel certo —
// sem que o modulo tenha login proprio no caminho.
//
// Requer o Core no ar (npm run dev) e o PostgreSQL de desenvolvimento.
const path = require("path");
const crypto = require("crypto");
const { fork } = require("child_process");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const CHAVE = "chave-de-desenvolvimento";
const CORE = "http://localhost:3000";
// Portas escolhidas pelo sistema operacional — ver a explicacao em fachada.test.js
function portaLivre() {
  return new Promise((resolve) => {
    const s = require("net").createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
let PORTA_MODULO = 0;
let PORTA_FACHADA = 0;
const MODULO_DIR = "C:/Users/USER/Documents/Sistema de Lançamento de Extra";
const BANCO_CORE = process.env.DATABASE_URL || "postgres://postgres:teste@localhost:55987/unigestao";
const BANCO_MODULO = "postgres://postgres:teste@localhost:55987/operacional";

let falhas = 0;
function ok(c, m) { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; }

async function esperar(url, tentativas = 40) {
  for (let i = 0; i < tentativas; i++) {
    try { await fetch(url); return true; } catch (e) { await new Promise(r => setTimeout(r, 500)); }
  }
  return false;
}

(async () => {
  PORTA_MODULO = await portaLivre();
  PORTA_FACHADA = await portaLivre();

  const poolCore = new Pool({ connectionString: BANCO_CORE });
  await poolCore.query("DELETE FROM login_attempts");
  await poolCore.query("DELETE FROM usuarios WHERE email LIKE 'oper.%@uniseter.com'");

  // ── sobe o modulo de verdade ──────────────────────────────────────────────
  const modulo = fork(path.join(MODULO_DIR, "server.js"), [], {
    cwd: MODULO_DIR,
    env: {
      ...process.env,
      PORT: String(PORTA_MODULO),
      DATABASE_URL: BANCO_MODULO,
      CORE_INTERNAL_KEY: CHAVE,
      NODE_ENV: "development",
      LOG_LEVEL: "silent",
    },
    stdio: "ignore",
  });

  const fachada = fork(path.join(__dirname, "..", "fachada", "server.js"), [], {
    env: {
      ...process.env,
      PORT: String(PORTA_FACHADA),
      URL_CORE: CORE,
      CORE_INTERNAL_KEY: CHAVE,
      URL_OPERACIONAL: `http://localhost:${PORTA_MODULO}`,
    },
    stdio: "ignore",
  });

  const encerrar = () => { try { modulo.kill(); fachada.kill(); } catch (e) {} };
  process.on("exit", encerrar);

  const subiu = await esperar(`http://localhost:${PORTA_MODULO}/`);
  if (!subiu) { console.error("modulo nao subiu"); encerrar(); process.exit(1); }
  await esperar(`http://localhost:${PORTA_FACHADA}/`);

  // ── cria a pessoa no Core com papel 'cco' no operacional ──────────────────
  async function criar(email, papel) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await poolCore.query(
      "INSERT INTO usuarios (id,nome,email,senha) VALUES ($1,$2,$3,$4)",
      [id, "Fulano de Teste", email, auth.gerarHash("SenhaTeste@123")]
    );
    if (papel) {
      await poolCore.query(
        "INSERT INTO usuario_modulos (usuario_id,modulo,papel) VALUES ($1,'operacional',$2)",
        [id, papel]
      );
    }
    const r = await fetch(CORE + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, senha: "SenhaTeste@123" }),
    });
    return { id, token: (r.headers.get("set-cookie").match(/unigestao_sessao=([^;]+)/) || [])[1] };
  }

  const cco = await criar("oper.cco@uniseter.com", "cco");
  const semAcesso = await criar("oper.sem@uniseter.com", null);

  const F = `http://localhost:${PORTA_FACHADA}`;
  const C = t => ({ headers: { cookie: "unigestao_sessao=" + t }, redirect: "manual" });

  console.log("\n=== O MODULO ABRE PELA FACHADA ===");
  const home = await fetch(F + "/operacional/", C(cco.token));
  const html = await home.text();
  ok(home.status === 200, "abre o modulo com 200");
  ok(html.includes('src="/operacional/__ug/shim.js"'), "shim referenciado na pagina do modulo");
  ok(html.includes('data-base="/operacional"'), "shim com o prefixo certo");

  // Sem isto a pagina abre em BRANCO: o navegador buscaria /app.js na raiz do
  // dominio (o Core) em vez de no modulo. O shim nao cobre src/href — eles sao
  // resolvidos na leitura do HTML, antes de qualquer JS rodar.
  ok(/src=["']\/operacional\/app\.js/.test(html), "<script src> reescrito para dentro do modulo");
  ok(/href=["']\/operacional\/styles\.css/.test(html), "<link href> reescrito para dentro do modulo");
  ok(!/src=["']\/app\.js/.test(html), "nao sobrou caminho apontando para a raiz");

  console.log("\n=== OS ARQUIVOS DO MODULO SAO SERVIDOS ===");
  const js = await fetch(F + "/operacional/app.js", C(cco.token));
  ok(js.status === 200, "app.js responde pela Fachada");
  const corpoJs = await js.text();
  ok(corpoJs.includes("window.UNIGESTAO"), "app.js e o do modulo, ja ciente do UniGestao");
  const css = await fetch(F + "/operacional/styles.css", C(cco.token));
  ok(css.status === 200, "styles.css responde pela Fachada");

  console.log("\n=== IMAGENS GERADAS EM TEMPO DE EXECUCAO ===");
  // O app.js do modulo monta <img src="/assets/uniseter-logo.png"> no navegador.
  // Esse trecho nunca passa pela reescrita do HTML, entao o shim conserta a
  // falha de carregamento acrescentando o prefixo. Aqui garantimos as duas
  // pontas: o caminho prefixado existe, e o shim ainda sabe corrigir.
  const logo = await fetch(F + "/operacional/assets/uniseter-logo.png", C(cco.token));
  ok(logo.status === 200, "imagem responde no caminho com prefixo");
  ok((logo.headers.get("content-type") || "").includes("image"), "servida como imagem");
  const shim = await (await fetch(F + "/operacional/__ug/shim.js", C(cco.token))).text();
  ok(shim.includes("addEventListener('error'"), "shim mantem o conserto de imagem quebrada");
  ok(shim.includes("data-ug-tentado"), "e tenta apenas uma vez por elemento");

  console.log("\n=== A IDENTIDADE CHEGA COM O PAPEL DO CORE ===");
  const me = await fetch(F + "/operacional/api/me", C(cco.token));
  const dados = await me.json();
  ok(me.status === 200, "/api/me responde sem login proprio do modulo");
  ok(dados.user && dados.user.role === "cco", "papel veio do Core (cco)");
  ok(dados.user && dados.user.email === "oper.cco@uniseter.com", "e-mail confere");
  ok(Array.isArray(dados.access) && dados.access.length > 0, "o modulo resolveu as filas do papel");

  console.log("\n=== A LINHA LOCAL FOI CRIADA E LIGADA ===");
  const poolMod = new Pool({ connectionString: BANCO_MODULO });
  const local = await poolMod.query("SELECT data FROM users WHERE data->>'email' = $1", ["oper.cco@uniseter.com"]);
  ok(local.rows.length === 1, "usuario local criado no banco do modulo");
  ok(local.rows[0] && local.rows[0].data.ugId === cco.id, "linha local ligada ao id do Core");
  ok(local.rows[0] && Array.isArray(local.rows[0].data.queueAccess), "queueAccess preservado no modulo");

  console.log("\n=== QUEM NAO TEM O MODULO NAO PASSA ===");
  const negado = await fetch(F + "/operacional/api/me", C(semAcesso.token));
  ok(negado.status === 403, "sem o modulo liberado -> 403 na Fachada");
  const anonimo = await fetch(F + "/operacional/api/me", { redirect: "manual" });
  ok(anonimo.status === 302, "sem sessao -> redireciona para o login");

  console.log("\n=== O MODULO SOZINHO NAO ACEITA CABECALHO FORJADO ===");
  const forjado = await fetch(`http://localhost:${PORTA_MODULO}/api/me`, {
    headers: { "x-ug-id": "qualquer", "x-ug-papel": "admin", "x-ug-key": "chave-errada" },
  });
  ok(forjado.status === 401, "cabecalho com chave errada e ignorado");
  const semChave = await fetch(`http://localhost:${PORTA_MODULO}/api/me`, {
    headers: { "x-ug-id": "qualquer", "x-ug-papel": "admin" },
  });
  ok(semChave.status === 401, "cabecalho sem chave e ignorado");

  console.log("\n=== TROCAR O PAPEL NO CORE MUDA O ACESSO NO MODULO ===");
  await poolCore.query(
    "UPDATE usuario_modulos SET papel='supervisor' WHERE usuario_id=$1 AND modulo='operacional'",
    [cco.id]
  );
  await new Promise(r => setTimeout(r, 31000)); // cache de sessao da Fachada: 30s
  const depois = await fetch(F + "/operacional/api/me", C(cco.token));
  const d2 = await depois.json();
  ok(d2.user && d2.user.role === "supervisor", "papel novo refletido no modulo");

  await poolCore.query("DELETE FROM usuarios WHERE email LIKE 'oper.%@uniseter.com'");
  await poolCore.query("DELETE FROM login_attempts");
  await poolMod.query("DELETE FROM users WHERE data->>'email' LIKE 'oper.%@uniseter.com'");
  await poolCore.end();
  await poolMod.end();
  encerrar();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
