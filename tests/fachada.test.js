// Testa o proxy da Fachada: roteamento, cabecalhos de identidade,
// remocao do prefixo e injecao do shim no HTML.
const http = require("http");
const path = require("path");
const { fork } = require("child_process");
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const CHAVE = "chave-de-desenvolvimento";
let falhas = 0;
function ok(c, m) { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; }

// -- modulo falso, imitando um sistema atual --------------------------------
let recebido = null;
const moduloFalso = http.createServer((req, res) => {
  recebido = { url: req.url, headers: req.headers };
  if (req.url.startsWith("/api/")) {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ rota: req.url, papel: req.headers["x-ug-papel"] }));
  }
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end('<!doctype html><html><head><title>Modulo</title></head><body><h1>Sistema antigo</h1>' +
          '<script>fetch("/api/dados")</script></body></html>');
});

// Mesma guarda do teste do modulo: se a porta ja estiver ocupada por um
// processo esquecido, o listen falha e a suite quebra sem relacao com o que
// esta sendo testado. Melhor parar e dizer o porque.
async function portaLivre(porta) {
  try { await fetch("http://localhost:" + porta + "/"); return false; } catch (e) { return true; }
}

(async () => {
  for (const porta of [3100, 8099]) {
    if (!(await portaLivre(porta))) {
      console.error("Ja existe algo escutando em localhost:" + porta + ". Encerre esse processo.");
      process.exit(1);
    }
  }
  await new Promise((r) => moduloFalso.listen(3100, r));

  const fachada = fork(path.join(__dirname, "..", "fachada", "server.js"), [], {
    env: { ...process.env, PORT: "8099", URL_CORE: "http://localhost:3000",
           CORE_INTERNAL_KEY: CHAVE, URL_OPERACIONAL: "http://localhost:3100" },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 900));

  const pool = new Pool({ connectionString: "postgres://postgres:teste@localhost:55987/unigestao" });
  // Bloqueio por IP e estado global entre os arquivos de teste — ver permissao.test.js
  await pool.query("DELETE FROM login_attempts");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'fach.%@uniseter.com'");

  async function criar(email, modulos) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await pool.query("INSERT INTO usuarios (id,nome,email,senha) VALUES ($1,$2,$3,$4)",
      [id, "Fachada " + email, email, auth.gerarHash("SenhaTeste@123")]);
    for (const m of modulos)
      await pool.query("INSERT INTO usuario_modulos (usuario_id,modulo,papel) VALUES ($1,$2,$3)",
        [id, m.modulo, m.papel]);
    const r = await fetch("http://localhost:3000/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, senha: "SenhaTeste@123" }),
    });
    return (r.headers.get("set-cookie").match(/unigestao_sessao=([^;]+)/) || [])[1];
  }

  const comAcesso = await criar("fach.cco@uniseter.com", [{ modulo: "operacional", papel: "cco" }]);
  const semAcesso = await criar("fach.sem@uniseter.com", []);

  const C = (t) => ({ headers: { cookie: "unigestao_sessao=" + t } });

  console.log("\n=== ROTEAMENTO ===");
  const raiz = await fetch("http://localhost:8099/", { redirect: "manual" });
  ok(raiz.status === 200, "/ vai para o Core");

  const semLogin = await fetch("http://localhost:8099/operacional/", { redirect: "manual" });
  ok(semLogin.status === 302, "modulo sem login -> redireciona para o login");

  const negado = await fetch("http://localhost:8099/operacional/", { ...C(semAcesso), redirect: "manual" });
  ok(negado.status === 403, "sem o modulo liberado -> 403");
  ok((await negado.text()).includes("Fale com o administrador"), "mensagem de bloqueio e clara");

  console.log("\n=== PROXY E IDENTIDADE ===");
  const html = await fetch("http://localhost:8099/operacional/", C(comAcesso));
  const corpo = await html.text();
  ok(html.status === 200, "modulo liberado responde 200");
  ok(recebido.url === "/", "prefixo /operacional removido antes de chegar ao modulo");
  ok(recebido.headers["x-ug-papel"] === "cco", "papel do modulo chega no cabecalho (cco)");
  ok(recebido.headers["x-ug-key"] === CHAVE, "chave interna acompanha a requisicao");
  ok(decodeURIComponent(recebido.headers["x-ug-nome"] || "").includes("Fachada"),
     "nome com acento trafega sem quebrar o cabecalho");

  console.log("\n=== INJECAO NO HTML ===");
  ok(corpo.includes("Sistema antigo"), "conteudo original do modulo preservado");
  ok(corpo.includes('src="/operacional/__ug/shim.js"'), "shim referenciado como arquivo");
  ok(!/<script>[^<]*window\.UNIGESTAO/.test(corpo), "shim NAO vai embutido no HTML");
  ok(corpo.includes('data-base="/operacional"'), "shim recebeu o prefixo correto");
  ok(corpo.includes('id="ug-barra"'), "barra superior comum injetada");
  ok(!/onclick=/.test(corpo), "sem manipulador inline — bloqueado por script-src 'self'");

  console.log("\n=== O SHIM E SERVIDO PELA FACHADA ===");
  // Modulos com politica estrita (script-src 'self') bloqueiam script inline.
  // Por isso shim e barra saem como arquivos do proprio dominio.
  const shimJs = await fetch("http://localhost:8099/operacional/__ug/shim.js", C(comAcesso));
  const shimCorpo = await shimJs.text();
  ok(shimJs.status === 200, "shim.js responde");
  ok((shimJs.headers.get("content-type") || "").includes("javascript"), "servido como javascript");
  ok(shimCorpo.includes("window.UNIGESTAO"), "shim.js traz a logica");
  const barraCss = await fetch("http://localhost:8099/operacional/__ug/barra.css", C(comAcesso));
  ok(barraCss.status === 200, "barra.css responde");
  ok(recebido.url !== "/__ug/shim.js", "esses arquivos nao sao repassados ao modulo");
  ok(corpo.indexOf("ug-barra") < corpo.indexOf("Sistema antigo"),
     "barra entra logo apos <body>, antes do conteudo");

  console.log("\n=== CHAMADA DE API ATRAVES DA FACHADA ===");
  const api = await fetch("http://localhost:8099/operacional/api/dados", C(comAcesso));
  const dados = await api.json();
  ok(api.status === 200, "chamada de API atravessa a Fachada");
  ok(dados.rota === "/api/dados", "modulo recebe /api/dados (sem o prefixo)");
  ok(dados.papel === "cco", "modulo enxerga o papel correto na chamada de API");

  await pool.query("DELETE FROM usuarios WHERE email LIKE 'fach.%@uniseter.com'");
  await pool.end();
  fachada.kill();
  moduloFalso.close();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
