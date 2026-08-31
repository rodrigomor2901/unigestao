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
           // Imita a topologia da Railway: dois saltos na frente da Fachada.
           // Explicito, e nao herdado do padrao, para o teste dizer QUAL forma
           // esta sendo testada — se o padrao mudar, e aqui que se decide.
           PROXIES_NA_FRENTE: "2",
           URL_OPERACIONAL: "http://localhost:" + PORTA_MODULO,
           // Precificacao: tela num servico, API em outro
           URL_PRECIFICACAO: "http://localhost:" + PORTA_MODULO,
           URL_PRECIFICACAO_API: "http://localhost:" + PORTA_API },
    stdio: "ignore",
  });
  await new Promise((r) => setTimeout(r, 900));

  const pool = new Pool({ connectionString: "postgres://postgres:teste@localhost:55987/unigestao" });
  // Bloqueio por IP e estado global entre os arquivos de teste — ver permissao.test.js
  await pool.query("DELETE FROM login_tentativas");
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

  console.log("\n=== A FACHADA NAO PODE DEPENDER DE NADA FORA DA PASTA DELA ===");
  // No Railway a Fachada e publicada com a propria pasta na RAIZ do container:
  // la dentro server.js e /app/server.js e `../public` aponta para /public, que
  // nao existe. Localmente `../public` existe, entao um readFileSync assim
  // passa em todo teste e derruba a producao — foi o que aconteceu quando a
  // marca passou a ser lida do disco. O processo morre antes de escutar a
  // porta: nao e um arquivo faltando, e o portal inteiro fora do ar.
  const fonte = require("fs").readFileSync(
    path.join(__dirname, "..", "fachada", "server.js"), "utf8");
  ok(!/__dirname\s*,\s*["']\.\.["']/.test(fonte),
     "nao alcanca a pasta de cima (__dirname + '..')");
  ok(!/require\(["']\.\.\//.test(fonte),
     "nao importa modulo de fora da pasta");

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

  console.log("\n=== A IDENTIDADE CHEGA ASSINADA AO MODULO ===");
  // Ponta a ponta, com a Fachada de verdade: o que o modulo recebe tem que ser
  // um bilhete que o verificador canonico aceita. Testar so o assinador e o
  // verificador em separado deixaria passar o erro mais provavel — os dois
  // lados combinando formatos diferentes.
  const ident = require("../integracao/identidade.js");
  const conferir = (b) => ident.verificar(b, {
    env: { CORE_INTERNAL_KEY: CHAVE }, modulo: "operacional", semRepeticao: false });

  await fetch(`${F}/operacional/`, C(comAcesso));
  const bilhete = recebido.headers["x-ug-identidade"];
  ok(Boolean(bilhete), "o modulo recebe o bilhete assinado");
  const dentroDoBilhete = conferir(bilhete);
  ok(Boolean(dentroDoBilhete), "e o verificador do modulo aceita o que a Fachada assinou");
  ok(dentroDoBilhete && dentroDoBilhete.papel === "cco", "com o papel que o Core informou");
  ok(dentroDoBilhete && dentroDoBilhete.mod === "operacional", "preso ao modulo de destino");
  ok(dentroDoBilhete && dentroDoBilhete.exp > dentroDoBilhete.iat, "e com prazo de validade");

  // Bilhete e cabecalhos de identidade vindos DO CLIENTE sao descartados na
  // porta. Sem isso, bastaria mandar um `x-ug-identidade` proprio e torcer para
  // alguma rota nao sobrescrever.
  await fetch(`${F}/operacional/`, {
    headers: { ...C(comAcesso).headers,
               "x-ug-identidade": "bilhete.inventado",
               "x-ug-papel": "admin", "x-ug-super": "1", "x-ug-id": "u-invasor" },
  });
  ok(recebido.headers["x-ug-identidade"] !== "bilhete.inventado",
     "bilhete vindo do cliente NAO chega ao modulo");
  const dentroDoSegundo = conferir(recebido.headers["x-ug-identidade"]);
  ok(dentroDoSegundo && dentroDoSegundo.papel === "cco" && dentroDoSegundo.super === false,
     "o bilhete que chega e o do Core: papel 'cco' e sem super admin");
  ok(dentroDoSegundo && dentroDoSegundo.id !== "u-invasor", "e com o id de quem realmente esta logado");
  ok(recebido.headers["x-ug-papel"] === "cco" && recebido.headers["x-ug-super"] === "0",
     "os cabecalhos antigos tambem sao sobrescritos, nao repassados");

  console.log("\n=== O ENDERECO DE REDE FORJADO MORRE NA PORTA DE ENTRADA ===");
  // A Fachada e a unica porta publica, entao e o unico lugar onde da para saber
  // de quem e a conexao. O X-Forwarded-For que chega de fora e uma lista: o
  // ultimo valor foi escrito pelo proxy da Railway e vale; o resto foi escrito
  // por quem chamou e nao vale nada.
  //
  // O achado do teste de seguranca era o Core ficar com o PRIMEIRO valor. A
  // Fachada agora REESCREVE o cabecalho antes de repassar, entao o texto
  // inventado nao chega nem ao Core nem aos modulos.
  // A lista imita o que a Railway entrega, com os dois saltos dela:
  //   [inventado pelo cliente] , [cliente de verdade] , [borda]
  // O valor bom e o 2 contado da direita.
  await fetch(`${F}/operacional/`, {
    headers: { ...C(comAcesso).headers,
               "x-forwarded-for": "1.2.3.4, 203.0.113.7, 198.51.100.9" },
  });
  const repassado = String(recebido.headers["x-forwarded-for"] || "");
  ok(!repassado.includes("1.2.3.4"),
     "o endereco inventado pelo cliente NAO e repassado  <-- era o furo");
  ok(!repassado.includes(","),
     "vai um valor so, sem lista: nao sobra o que escolher do outro lado");
  ok(repassado === "203.0.113.7",
     "e o que vale e o cliente de verdade, nem o inventado nem o da borda");

  // Lista mais curta que o esperado: alguem chamou por um caminho que nao e o
  // previsto. Nao da para saber de quem e — entao fica a conexao, nunca o
  // cabecalho.
  await fetch(`${F}/operacional/`, {
    headers: { ...C(comAcesso).headers, "x-forwarded-for": "1.2.3.4" },
  });
  const curto = String(recebido.headers["x-forwarded-for"] || "");
  ok(curto !== "1.2.3.4",
     "lista curta demais para os saltos esperados: o cabecalho e descartado");
  ok(curto.includes("127.0.0.1") || curto.includes("::1"),
     "e vale o endereco da conexao de verdade");

  await fetch(`${F}/operacional/`, {
    headers: { ...C(comAcesso).headers, "x-real-ip": "9.9.9.9",
               "x-envoy-external-address": "9.9.9.9" },
  });
  ok(!recebido.headers["x-real-ip"] && !recebido.headers["x-envoy-external-address"],
     "os outros cabecalhos de endereco tambem sao descartados — sao do cliente");

  // E a prova de que isso chega ate onde importa: o contador de tentativas.
  // Cinco tentativas erradas, cada uma inventando um endereco diferente, no
  // formato que a borda da Railway produz (o endereco de verdade entra no FIM
  // da lista). Tem que sobrar UM contador, no endereco de verdade.
  //
  // Antes da correcao sobravam cinco — um por endereco inventado —, e o teto de
  // 60 tentativas por local nunca fechava.
  await pool.query("DELETE FROM login_tentativas");
  for (let i = 0; i < 5; i++) {
    await fetch(`${F}/api/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json",
                 "x-forwarded-for": `10.9.9.${i}, 203.0.113.7, 198.51.100.9` },
      body: JSON.stringify({ email: "naoexiste.fach@uniseter.com", senha: "errada" }),
    });
  }
  const contadores = await pool.query(
    "SELECT chave, count FROM login_tentativas WHERE chave LIKE 'ip:%' ORDER BY chave");
  ok(contadores.rows.length === 1,
     "as 5 tentativas somam num contador so (vieram " + contadores.rows.length + ")");
  ok(contadores.rows[0] && contadores.rows[0].chave === "ip:203.0.113.7",
     "e no endereco que a infraestrutura escreveu, nao no que o cliente inventou");
  ok(contadores.rows[0] && contadores.rows[0].count === 5,
     "com as cinco tentativas somadas — e o teto por local volta a fechar");
  await pool.query("DELETE FROM login_tentativas");

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

  console.log("\n=== MENU DE TROCA DE MODULO ===");
  // Com um modulo so nao ha para onde trocar
  ok(!corpo.includes("ug-troca"), "com um modulo so, nao aparece menu");
  ok(corpo.includes("Todos os módulos"), "e o link de voltar continua");

  const doisModulos = await criar("fach.dois@uniseter.com", [
    { modulo: "operacional", papel: "cco" },
    { modulo: "eventos", papel: "gestao" },
  ]);
  const comMenu = await (await fetch(`${F}/operacional/`, C(doisModulos))).text();
  ok(comMenu.includes("ug-troca"), "com dois modulos, o menu aparece");
  ok(comMenu.includes("Gestão de Eventos"), "lista o outro modulo pelo nome");
  ok(comMenu.includes('href="/eventos/"'), "com o endereco certo");
  ok(/class="ug-aqui"[^>]*>Movimentação Operacional/.test(comMenu) ||
     comMenu.includes('class="ug-aqui" aria-current="page">Movimentação Operacional'),
     "marca o modulo em que a pessoa esta");
  ok(!/onclick|addEventListener\(['"]click['"],\s*function\s*\(\)\s*\{\s*document/.test(comMenu),
     "sem script para abrir — modulo com CSP estrita bloquearia");
  ok(comMenu.includes("<details"), "usa <details>, que abre sozinho no navegador");

  // Um modulo inativo no registro nao pode vazar para o menu
  ok(!comMenu.includes("/tarefas/") || comMenu.includes("Gestão de Tarefas"),
     "so entra no menu o que existe no registro");

  console.log("\n=== HTML REESCRITO NAO PODE SER GUARDADO PELO NAVEGADOR ===");
  // O corpo entregue nao e mais o que o modulo gerou. Repassar o ETag dele e
  // mentir: na visita seguinte o navegador pergunta "mudou?", o modulo diz
  // "nao" (o arquivo dele realmente nao mudou) e a pessoa continua vendo a
  // barra antiga. Foi o que aconteceu quando o menu de trocar de modulo
  // entrou e nao apareceu em quatro dos seis sistemas.
  const cab = await fetch(`${F}/operacional/`, C(comAcesso));
  ok(!cab.headers.get("etag"), "ETag do modulo nao e repassado");
  ok(!cab.headers.get("last-modified"), "Last-Modified tambem nao");
  ok((cab.headers.get("cache-control") || "").includes("no-store"),
     "a pagina do modulo nao fica guardada");

  // E o pedido condicional do navegador tambem nao pode chegar ao modulo:
  // 304 vem sem corpo, e sem corpo nao ha onde injetar a barra.
  recebido = null;
  await fetch(`${F}/operacional/`, {
    headers: { ...C(comAcesso).headers, "if-none-match": '"abc"',
               accept: "text/html,application/xhtml+xml" },
  });
  ok(!recebido.headers["if-none-match"], "if-none-match nao chega ao modulo numa navegacao");

  // Ja um arquivo estatico segue com o cache intacto — e onde ele importa.
  recebido = null;
  await fetch(`${F}/operacional/app.js`, {
    headers: { ...C(comAcesso).headers, "if-none-match": '"abc"', accept: "*/*" },
  });
  ok(recebido.headers["if-none-match"] === '"abc"',
     "arquivo estatico continua podendo ser revalidado");

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
