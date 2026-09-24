// O que e da tela nao vai para o papel.
//
// POR QUE ESTE TESTE EXISTE
// A Precificacao imprime documento que sai da empresa: a Ordem de Servico e o
// Disparo viram PDF e vao para o cliente e para a operacao. A barra do portal
// e o balao do comunicador sao injetados DENTRO do modulo, entao eles entravam
// na impressao junto: o PDF saia com "Trocar de modulo", o nome de quem
// imprimiu, o "Sair" no topo e o balao de conversa carimbado por cima do
// conteudo — e quem recebe o arquivo nao tem como tirar.
//
// Os dois arquivos pertencem a partes diferentes do sistema (a barra mora na
// Fachada, o chat mora no Core), entao a regra pode sumir de um sem que
// ninguem perceba. Este teste guarda os dois.
const fs = require("fs");
const path = require("path");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const raiz = path.join(__dirname, "..");
const fachada = fs.readFileSync(path.join(raiz, "fachada", "server.js"), "utf8");
const chatCss = fs.readFileSync(path.join(raiz, "public", "chat.css"), "utf8");

/** A regra existe e esconde o seletor dentro de um bloco @media print? */
function escondeNaImpressao(css, seletor) {
  const blocos = css.match(/@media\s+print\s*\{[\s\S]*?\}\s*\}|@media\s+print\s*\{[^{}]*\{[^{}]*\}[^{}]*\}/g) ?? [];
  return blocos.some((b) => b.includes(seletor) && /display\s*:\s*none/.test(b));
}

ok(escondeNaImpressao(fachada, "#ug-barra"),
   "a barra do portal nao sai na impressao");
ok(escondeNaImpressao(chatCss, "#ug-chat"),
   "o balao do comunicador nao sai na impressao");

// A regra so vale se o navegador de fato a receber: ela tem de estar no CSS
// que a Fachada injeta no modulo, e nao numa folha que so a home carrega.
ok(fachada.includes("BARRA_CSS") && fachada.indexOf("@media print") > fachada.indexOf("const BARRA_CSS"),
   "a regra da barra esta dentro do CSS injetado nos modulos");

process.exit(falhas ? 1 : 0);
