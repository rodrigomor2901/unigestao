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

// -- servico falso de API, imitando a API separada da Precificacao ----------
// A Precificacao e partida em dois servicos: a tela e um, a API e outro. A
// Fachada precisa mandar /precificacao/api/* para a API e o resto para a tela.
let recebidoApi = null;
const apiFalsa = http.createServer((req, res) => {
  recebidoApi = { url: req.url, headers: req.headers };
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ servico: "api", rota: req.url, papel: req.headers["x-ug-papel"] }));
});

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

// Portas escolhidas pelo sistema operacional, nunca fixas.
//
// Com porta fixa a suite quebrava de forma intermitente: depois que um teste
// encerra, o socket fica um tempo em espera no sistema, e a execucao seguinte
// batia em EADDRINUSE. Verificar "esta livre?" antes nao resolve — livre e
// utilizavel nao sao a mesma coisa nesse intervalo.
function portaLivre() {
  return new Promise((resolve) => {
    const s = require("net").createServer();
    s.listen(0, () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}

(async () => {
  await new Promise((r) => moduloFalso.listen(0, r));
  await new Promise((r) => apiFalsa.listen(0, r));
  const PORTA_MODULO = moduloFalso.address().port;
  const PORTA_API = apiFalsa.address().port;
  const PORTA_FACHADA = await portaLivre();

  const fachada = fork(path.join(__dirname, "..", "fachada", "server.js"), [], {
    env: { ...process.env, PORT: String(PORTA_FACHADA), URL_CORE: "http://localhost:3000",
           CORE_INTERNAL_KEY: CHAVE,
           URL_OPERACIONAL: "http://localhost:" + PORTA_MODULO,
           // Precificacao: tela num servico, API em outro
           URL_PRECIFICACAO: "http://localhost:" + PORTA_MODULO,
           URL_PRECIFICACAO_API: "http://localhost:" + PORTA_API },
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

  const F = "http://localhost:" + PORTA_FACHADA;
  const C = (t) => ({ headers: { cookie: "unigestao_sessao=" + t } });

  console.log("\n=== ROTEAMENTO ===");
  const raiz = await fetch(`${F}/`, { redirect: "manual" });
  ok(raiz.status === 200, "/ vai para o Core");

  const semLogin = await fetch(`${F}/operacional/`, { redirect: "manual" });
  ok(semLogin.status === 302, "modulo sem login -> redireciona para o login");

  const negado = await fetch(`${F}/operacional/`, { ...C(semAcesso), redirect: "manual" });
  ok(negado.status === 403, "sem o modulo liberado -> 403");
  ok((await negado.text()).includes("Fale com o administrador"), "mensagem de bloqueio e clara");

  console.log("\n=== PROXY E IDENTIDADE ===");
  const html = await fetch(`${F}/operacional/`, C(comAcesso));
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
  const shimJs = await fetch(`${F}/operacional/__ug/shim.js`, C(comAcesso));
  const shimCorpo = await shimJs.text();
  ok(shimJs.status === 200, "shim.js responde");
  ok((shimJs.headers.get("content-type") || "").includes("javascript"), "servido como javascript");
  ok(shimCorpo.includes("window.UNIGESTAO"), "shim.js traz a logica");
  const barraCss = await fetch(`${F}/operacional/__ug/barra.css`, C(comAcesso));
  ok(barraCss.status === 200, "barra.css responde");

  // A marca tambem sai da Fachada. Se viesse do Core seria uma requisicao a
  // outro servico em toda pagina de modulo, capaz de falhar sozinha.
  const marca = await fetch(`${F}/operacional/__ug/marca.svg`, C(comAcesso));
  const marcaCorpo = await marca.text();
  ok(marca.status === 200, "marca.svg responde");
  ok((marca.headers.get("content-type") || "").includes("image/svg+xml"),
     "servida como imagem SVG");
  ok(marcaCorpo.includes("<svg") && marcaCorpo.includes("ugCavidade"),
     "e o simbolo com a peca de encaixe, nao um arquivo qualquer");
  ok(corpo.includes('src="/operacional/__ug/marca.svg"'),
     "a barra referencia a marca ja com o prefixo do modulo");
  ok(recebido.url !== "/__ug/shim.js", "esses arquivos nao sao repassados ao modulo");
  ok(corpo.indexOf("ug-barra") < corpo.indexOf("Sistema antigo"),
     "barra entra logo apos <body>, antes do conteudo");

  console.log("\n=== CHAMADA DE API ATRAVES DA FACHADA ===");
  const api = await fetch(`${F}/operacional/api/dados`, C(comAcesso));
  const dados = await api.json();
  ok(api.status === 200, "chamada de API atravessa a Fachada");
  ok(dados.rota === "/api/dados", "modulo recebe /api/dados (sem o prefixo)");
  ok(dados.papel === "cco", "modulo enxerga o papel correto na chamada de API");

  console.log("\n=== MODULO PARTIDO EM DOIS SERVICOS ===");
  const comPrec = await criar("fach.prec@uniseter.com", [{ modulo: "precificacao", papel: "ADMIN" }]);
  const tela = await fetch(F + "/precificacao/", C(comPrec));
  ok(tela.status === 200, "a tela vem do servico principal");
  ok(recebido.url === "/", "tela recebe o caminho sem o prefixo");

  const chamadaApi = await fetch(F + "/precificacao/api/pricing", C(comPrec));
  const corpoApi = await chamadaApi.json();
  ok(chamadaApi.status === 200, "/api vai para o OUTRO servico");
  ok(corpoApi.servico === "api", "quem respondeu foi a API, nao a tela");
  ok(corpoApi.rota === "/api/pricing", "a API recebe /api/... como espera");
  ok(corpoApi.papel === "ADMIN", "a identidade chega tambem na API");
  ok(recebidoApi && recebidoApi.headers["x-ug-key"] === CHAVE, "chave interna acompanha");

  // O modulo sem `sub` nao pode ser afetado pela novidade
  const semSub = await fetch(F + "/operacional/api/dados", C(comAcesso));
  ok(semSub.status === 200, "modulo de servico unico segue igual");
  ok((await semSub.json()).rota === "/api/dados", "e continua recebendo /api/dados");

  await pool.query("DELETE FROM usuarios WHERE email LIKE 'fach.%@uniseter.com'");
  await pool.end();
  fachada.kill();
  moduloFalso.close();
  apiFalsa.close();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
