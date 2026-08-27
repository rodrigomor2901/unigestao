// O cliente da API do Nexti se comporta?
//
// POR QUE ESTE TESTE EXISTE
// Este é o primeiro pedaço do portal que fala com um sistema de TERCEIRO, na
// nuvem dele. Não temos como testar contra o Nexti de verdade sem credencial —
// e, mesmo com ela, não se testa integração batendo no fornecedor a cada vez.
// Então aqui sobe um Nexti de mentira que imita o que a especificação
// (https://api.nexti.com/v3/api-docs) descreve, e o cliente de verdade fala com
// ele.
//
// O que este arquivo guarda, e por quê:
//
//   - O FORMATO DAS DATAS. A especificação se contradiz: os parâmetros dizem
//     `date-time` (ISO), mas os exemplos dos campos e a descrição de outros
//     endpoints dizem `ddMMyyyyHHmmss`. Escolhemos o segundo. Se estiver
//     errado, o sintoma é janela silenciosamente errada — o pior tipo de bug,
//     porque a tela mostra números que parecem certos.
//
//   - O RITMO. Não há limite de chamadas documentado, o que significa que não
//     sabemos qual é. O cliente tem que ser manso por construção: uma chamada
//     por vez, com pausa, e recuo quando o servidor reclama.
//
//   - QUE ELE NÃO INSISTE COM CREDENCIAL RUIM. Repetir 401 acumula tentativa
//     de login falha do lado do fornecedor.
const http = require("http");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// ---------------------------------------------------------------------------
// Nexti de mentira
// ---------------------------------------------------------------------------
function subirNextiFalso(comportamento = {}) {
  const chamadas = [];
  const servidor = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    chamadas.push({ caminho: url.pathname, busca: url.search, em: Date.now(),
                    auth: req.headers.authorization || "" });

    const responder = (codigo, corpo) => {
      res.writeHead(codigo, { "Content-Type": "application/json" });
      res.end(JSON.stringify(corpo));
    };

    if (url.pathname === "/security/oauth/token") {
      if (comportamento.recusarLogin) return responder(401, { error: "invalid_client" });
      // O Nexti de verdade EXIGE Basic e responde 401 a query string, com
      // `WWW-Authenticate: Basic realm="oauth2/client"`. O de mentira faz
      // igual, senao o teste passaria com um cliente que na pratica nao entra.
      if (!/^Basic /.test(req.headers.authorization || "")) {
        res.writeHead(401, { "Content-Type": "application/json",
                             "WWW-Authenticate": 'Basic realm="oauth2/client"' });
        return res.end(JSON.stringify({ error: "Unauthorized" }));
      }
      return responder(200, { access_token: "tok-" + (comportamento.tokens = (comportamento.tokens || 0) + 1),
                              expires_in: comportamento.expiraEm || 3600 });
    }
    if (comportamento.limite) return responder(429, { error: "too many requests" });
    if (comportamento.exigirToken && req.headers.authorization !== "Bearer " + comportamento.exigirToken) {
      return responder(401, { error: "expired" });
    }

    // Listagem paginada, no formato Page* da especificação
    const pagina = Number(url.searchParams.get("page") || 0);
    const paginas = comportamento.paginas || 1;
    const item = (i) => ({ id: pagina * 100 + i, name: "item " + pagina + "-" + i });
    return responder(200, {
      content: [item(1), item(2)],
      totalPages: paginas, number: pagina, last: pagina >= paginas - 1,
    });
  });
  return new Promise((r) => servidor.listen(0, () => r({
    servidor, chamadas,
    url: "http://localhost:" + servidor.address().port,
    parar: () => new Promise((f) => servidor.close(f)),
  })));
}

// O cliente lê as variáveis no `require`, então cada cenário carrega uma cópia.
function clienteApontadoPara(url, extras = {}) {
  process.env.NEXTI_URL = url;
  process.env.NEXTI_CLIENT_ID = extras.id || "id-de-teste";
  process.env.NEXTI_CLIENT_SECRET = extras.segredo || "segredo-de-teste";
  if (extras.pausa !== undefined) process.env.NEXTI_PAUSA_MS = String(extras.pausa);
  delete require.cache[require.resolve("../core/nexti.js")];
  return require("../core/nexti.js");
}

(async () => {
  console.log("\n=== O FORMATO DA DATA E ddMMyyyyHHmmss ===");
  {
    const n = clienteApontadoPara("http://localhost:1", { pausa: 0 });
    const d = new Date(2026, 7, 26, 6, 5, 9);   // 26/08/2026 06:05:09
    ok(n.paraDataNexti(d) === "26082026060509",
       "26/08/2026 06:05:09 vira 26082026060509  (e NÃO ISO — ver o comentário no código)");
    const volta = n.deDataNexti("26082026060509");
    ok(volta && volta.getFullYear() === 2026 && volta.getMonth() === 7 &&
       volta.getDate() === 26 && volta.getHours() === 6,
       "e o caminho de volta devolve a mesma data");
    ok(n.deDataNexti("2026-08-26T06:05:09Z") === null,
       "ISO NÃO é aceito de volta — se o Nexti mandar ISO, isso aparece como null e não como data errada");
    ok(n.deDataNexti("") === null && n.deDataNexti(null) === null, "vazio vira null, não data inválida");
  }

  console.log("\n=== A DATA CHEGA ASSIM NA CHAMADA ===");
  {
    const f = await subirNextiFalso();
    const n = clienteApontadoPara(f.url, { pausa: 0 });
    await n.checklistsDoPosto(77, new Date(2026, 7, 26, 0, 0, 0), new Date(2026, 7, 26, 23, 59, 59));
    const c = f.chamadas.find((x) => x.caminho.includes("/checklists/workplace"));
    ok(c.caminho === "/checklists/workplace/77/start/26082026000000/finish/26082026235959",
       "o caminho sai montado com as datas no formato do Nexti");
    ok(c.busca.includes("size=200"),
       "e pede 200 por página — o padrão da API é 10, o que multiplicaria as chamadas por 20");
    await f.parar();
  }

  console.log("\n=== PAGINAÇÃO ATÉ O FIM ===");
  {
    const f = await subirNextiFalso({ paginas: 3 });
    const n = clienteApontadoPara(f.url, { pausa: 0 });
    const itens = await n.postos();
    ok(itens.length === 6, "as 3 páginas foram lidas (2 itens cada)");
    const paginas = f.chamadas.filter((c) => c.caminho === "/workplaces/all").length;
    ok(paginas === 3, "com uma chamada por página, nem mais nem menos");
    await f.parar();
  }

  console.log("\n=== O CLIENTE É MANSO ===");
  {
    // Sem limite documentado, o jeito de não ser bloqueado é não disparar tudo
    // de uma vez. As chamadas saem em fila, com intervalo entre elas.
    const f = await subirNextiFalso({ paginas: 3 });
    const n = clienteApontadoPara(f.url, { pausa: 120 });
    const antes = Date.now();
    await n.postos();
    const levou = Date.now() - antes;
    ok(levou >= 240, `as páginas saíram espaçadas, não em rajada (levou ${levou}ms para 3)`);
    const soUmaPorVez = f.chamadas.filter((c) => c.caminho === "/workplaces/all")
      .every((c, i, todas) => i === 0 || c.em >= todas[i - 1].em);
    ok(soUmaPorVez, "e em sequência, uma de cada vez");
    await f.parar();
  }

  console.log("\n=== QUANDO O NEXTI PEDE PARA PARAR ===");
  {
    const f = await subirNextiFalso({ limite: true });
    const n = clienteApontadoPara(f.url, { pausa: 0 });
    let erro = null;
    try { await n.postos(); } catch (e) { erro = e; }
    ok(erro && erro.causa === "limite", "o 429 vira um erro com causa reconhecível");
    const tentativas = f.chamadas.filter((c) => c.caminho === "/workplaces/all").length;
    ok(tentativas === 1, "e ele NÃO tenta de novo — quem pediu para parar, parou");
    await f.parar();
  }

  console.log("\n=== O LOGIN VAI POR HTTP BASIC, NAO POR QUERY STRING ===");
  {
    // A documentacao do Nexti manda as credenciais na query string. Isso da
    // 401: o servidor responde `WWW-Authenticate: Basic realm="oauth2/client"`
    // e quer o cabecalho, como manda o proprio OAuth2. Conferido contra a API
    // de producao em 26/08/2026 — a documentacao deles esta desatualizada.
    //
    // Este bloco existe para ninguem "consertar" de volta seguindo a
    // documentacao e derrubar a integracao inteira.
    const f = await subirNextiFalso();
    const n = clienteApontadoPara(f.url, { id: "meu-id", segredo: "meu-segredo", pausa: 0 });
    await n.postos();
    const login = f.chamadas.find((c) => c.caminho === "/security/oauth/token");
    ok(/^Basic /.test(login.auth), "as credenciais vao no cabecalho Authorization: Basic");
    const esperado = "Basic " + Buffer.from("meu-id:meu-segredo").toString("base64");
    ok(login.auth === esperado, "com id e segredo codificados como o padrao manda");

    // Segredo em query string vaza para log de servidor, de proxy e de CDN.
    // Cabecalho nao. Esta garantia vale por si, independente do 401.
    ok(!login.busca.includes("meu-segredo") && !login.busca.includes("client_secret"),
       "e o segredo NAO viaja na URL — la ele acabaria escrito em log");
    await f.parar();
  }

  console.log("\n=== TOKEN: GUARDA, RENOVA UMA VEZ, NÃO INSISTE ===");
  {
    const f = await subirNextiFalso();
    const n = clienteApontadoPara(f.url, { pausa: 0 });
    await n.postos(); await n.postos(); await n.postos();
    const logins = f.chamadas.filter((c) => c.caminho === "/security/oauth/token").length;
    ok(logins === 1, "três consultas seguidas pedem UM token só");
    await f.parar();
  }
  {
    // Token vencido antes da hora: a primeira chamada leva 401, ele renova e
    // segue. O caso comum, e que não pode virar erro na cara do usuário.
    const f = await subirNextiFalso({ exigirToken: "tok-2" });
    const n = clienteApontadoPara(f.url, { pausa: 0 });
    const itens = await n.postos();
    ok(itens.length === 2, "401 no meio do caminho: renova o token e a consulta conclui");
    ok(f.chamadas.filter((c) => c.caminho === "/security/oauth/token").length === 2,
       "com exatamente um token novo");
    await f.parar();
  }
  {
    const f = await subirNextiFalso({ recusarLogin: true });
    const n = clienteApontadoPara(f.url, { pausa: 0 });
    let erro = null;
    try { await n.postos(); } catch (e) { erro = e; }
    ok(erro && erro.causa === "credencial", "credencial ruim vira erro de credencial");
    ok(f.chamadas.filter((c) => c.caminho === "/security/oauth/token").length <= 2,
       "e ele não fica martelando o login do fornecedor");
    await f.parar();
  }

  console.log("\n=== SEM CREDENCIAL, DIZ QUE NÃO ESTÁ CONFIGURADO ===");
  {
    process.env.NEXTI_CLIENT_ID = "";
    process.env.NEXTI_CLIENT_SECRET = "";
    delete require.cache[require.resolve("../core/nexti.js")];
    const n = require("../core/nexti.js");
    ok(n.configurado() === false, "sabe que não tem credencial");
    let erro = null;
    try { await n.pegarToken(); } catch (e) { erro = e; }
    ok(erro && /NEXTI_CLIENT_ID/.test(erro.message),
       "e o erro diz qual variável falta, em vez de 'algo deu errado'");
  }

  console.log("\n=== OS CÓDIGOS DO NEXTI TÊM NOME ===");
  {
    const n = clienteApontadoPara("http://localhost:1", { pausa: 0 });
    ok(n.STATUS.NAO_RESPONDIDO === 1 && n.STATUS.CANCELADO === 4, "os status conferem com a especificação");
    // "Respondido em outro dispositivo" é feito, não pendente: a tarefa
    // aconteceu, só foi registrada de outro lugar. Contar como pendente
    // cobraria de novo algo já entregue.
    ok(n.foiRespondido(2) && n.foiRespondido(3), "respondido e respondido-em-outro-dispositivo contam como feitos");
    ok(!n.foiRespondido(1) && !n.foiRespondido(4), "não respondido e cancelado não contam");
  }

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
