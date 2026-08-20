// O shim conserta links e window.open montados em tempo de execucao?
//
// POR QUE ESTE TESTE EXISTE
// Os anexos do CRM nao baixavam. O app.js monta
//   <a href="/api/attachments/435/download">
// como TEXTO dentro do JavaScript — nunca foi HTML, entao a reescrita de
// caminhos da Fachada, que age no documento, nao alcanca. O clique ia para a
// raiz do dominio (o Core) e respondia "Cannot GET".
//
// O mesmo buraco ja tinha aparecido com <img> gerado em execucao (logo
// quebrado). Aqui o teste roda o shim de verdade, com um DOM de mentira, e
// confere as tres formas de link.
const fs = require("fs");
const path = require("path");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// Le o shim COMO ELE ESTA no arquivo da Fachada — copiar o codigo para dentro
// do teste faria o teste continuar passando depois de o original mudar.
function shimDaFachada() {
  const fonte = fs.readFileSync(path.join(__dirname, "..", "fachada", "server.js"), "utf8");
  const m = fonte.match(/const SHIM_JS = `([\s\S]*?)`;/);
  if (!m) throw new Error("nao achei o SHIM_JS em fachada/server.js");
  return m[1];
}

// DOM de mentira: so o suficiente para o shim se instalar e para simularmos um
// clique. Nao e um navegador — e o minimo para ver a decisao do shim.
function montarAmbiente(base) {
  const ouvintes = { click: [], error: [] };
  const script = {
    getAttribute: (n) => (n === "data-base" ? base : n === "data-usuario" ? "{}" : null),
  };
  const criarLink = (href, dentroDaBarra) => {
    const el = {
      tagName: "A", _href: href, _dentro: dentroDaBarra,
      getAttribute: (n) => (n === "href" ? el._href : null),
      setAttribute: (n, v) => { if (n === "href") el._href = v; },
      closest: (sel) => {
        if (sel === "a[href]") return el;
        if (sel === "#ug-barra") return el._dentro ? {} : null;
        return null;
      },
    };
    return el;
  };
  const janela = {
    fetch: () => Promise.resolve({}),
    XMLHttpRequest: function () {},
    aberturas: [],
  };
  janela.XMLHttpRequest.prototype = { open() {} };
  janela.open = function (u) { janela.aberturas.push(u); return null; };

  const documento = {
    currentScript: script,
    addEventListener: (tipo, fn) => { (ouvintes[tipo] = ouvintes[tipo] || []).push(fn); },
  };
  return { ouvintes, documento, janela, criarLink };
}

function instalar(base) {
  const amb = montarAmbiente(base);
  const fn = new Function("document", "window", "XMLHttpRequest", "location",
                          shimDaFachada() + "\nreturn window;");
  fn(amb.documento, amb.janela, amb.janela.XMLHttpRequest, { origin: "https://portal" });
  amb.clicar = (el) => amb.ouvintes.click.forEach((f) => f({ target: el }));
  return amb;
}

(async () => {
  const BASE = "/crm";

  console.log("\n=== LINK GERADO EM EXECUCAO ===");
  const a = instalar(BASE);
  const anexo = a.criarLink("/api/attachments/435/download", false);
  a.clicar(anexo);
  ok(anexo._href === "/crm/api/attachments/435/download",
     "o link do anexo passa a apontar para dentro do modulo");

  const raizDoModulo = a.criarLink("/", false);
  a.clicar(raizDoModulo);
  ok(raizDoModulo._href === "/crm/", "link para a raiz do modulo tambem e corrigido");

  console.log("\n=== O QUE NAO PODE SER MEXIDO ===");
  const jaCerto = a.criarLink("/crm/api/x", false);
  a.clicar(jaCerto);
  ok(jaCerto._href === "/crm/api/x", "link ja prefixado fica como esta");

  const externo = a.criarLink("https://uniseter.com.br", false);
  a.clicar(externo);
  ok(externo._href === "https://uniseter.com.br", "endereco externo nao e tocado");

  const protocoloRelativo = a.criarLink("//cdn.exemplo.com/x.js", false);
  a.clicar(protocoloRelativo);
  ok(protocoloRelativo._href === "//cdn.exemplo.com/x.js", "caminho //host tambem nao");

  const ancora = a.criarLink("#secao", false);
  a.clicar(ancora);
  ok(ancora._href === "#secao", "ancora interna da pagina nao e tocada");

  // A barra do portal aponta para a raiz DE PROPOSITO: prefixar levaria a
  // pessoa para dentro do modulo em vez de para o portal.
  const naBarra = a.criarLink("/", true);
  a.clicar(naBarra);
  ok(naBarra._href === "/", "os links da barra do UniGestao ficam intactos");

  console.log("\n=== window.open ===");
  const b = instalar(BASE);
  b.janela.open("/api/attachments/435/download");
  ok(b.janela.aberturas[0] === "/crm/api/attachments/435/download",
     "abrir em outra aba tambem entra no modulo");
  b.janela.open("https://uniseter.com.br");
  ok(b.janela.aberturas[1] === "https://uniseter.com.br", "e endereco externo continua externo");

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
