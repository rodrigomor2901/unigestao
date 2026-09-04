// O aviso na tela do Windows (a caixinha do canto que aparece por cima do Excel).
//
// POR QUE ESTE TESTE EXISTE
// A regra e "so avisa quando a janela esta escondida" — e isso e justamente o
// que ninguem consegue conferir a olho: para ver a caixinha voce precisa estar
// com a janela escondida, e ai nao esta olhando. Uma inversao aqui produz um
// dos dois defeitos, os dois silenciosos:
//   - caixinha aparecendo por cima da conversa que a pessoa esta lendo
//   - ou nenhum aviso para quem esta em outro programa, que e o motivo de o
//     recurso existir
//
// Roda o chat.js de verdade, com um documento e um fetch de mentira.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// Documento de mentira: so o bastante para o chat.js montar sem quebrar.
function criarElemento() {
  const el = {
    id: "", innerHTML: "", textContent: "", value: "", hidden: false, src: "",
    style: {}, dataset: {}, files: [],
    classList: { toggle() {}, add() {}, remove() {}, contains: () => false },
    addEventListener() {}, removeEventListener() {},
    appendChild() {}, remove() {}, insertAdjacentHTML() {}, focus() {}, click() {},
    setAttribute() {}, getAttribute: () => null,
    querySelector: () => criarElemento(),
    querySelectorAll: () => [],
    getBoundingClientRect: () => ({ width: 100, height: 100 }),
  };
  return el;
}

function criarDocumento() {
  return {
    hidden: false,
    title: "UniGestão",
    readyState: "complete",
    // O body responde a getAttribute porque o chat le `data-janela` nele para
    // saber se esta na janela separada.
    body: { appendChild() {}, getAttribute: () => null },
    createElement: () => criarElemento(),
    querySelector: () => criarElemento(),
    querySelectorAll: () => [],
    getElementById: () => criarElemento(),
    addEventListener() {},
  };
}

(async () => {
  const codigo = fs.readFileSync(path.join(__dirname, "..", "public", "chat.js"), "utf8");

  const janela = {
    UNIGESTAO: { base: "", usuario: { id: "u1", nome: "Ana" } },
    localStorage: { getItem: () => null, setItem() {} },
    // O chat so se monta se a API responder — devolvemos uma lista minima.
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({ pessoas: [{ id: "u2", nome: "Bruno", naoLidas: 0, temFoto: false }] }),
    }),
    setInterval: () => 0,
    setTimeout: (f, t) => setTimeout(f, t),
    EventSource: function () { this.addEventListener = function () {}; this.close = function () {}; },
    Notification: function () {},
    confirm: () => true,
    Image: function () {},
    AudioContext: undefined,
  };
  janela.window = janela;
  janela.document = criarDocumento();
  janela.console = console;

  vm.createContext(janela);
  vm.runInContext(codigo, janela);

  // O chat monta depois da resposta da API — que e uma promessa.
  await new Promise((r) => setTimeout(r, 50));

  const decide = janela.window.UGChat && janela.window.UGChat._deveAvisarNaTela;
  ok(typeof decide === "function", "o chat expoe a regra do aviso para ser conferida");
  if (typeof decide !== "function") {
    console.log("\n" + falhas + " TESTE(S) FALHARAM");
    process.exit(1);
  }

  const doOutro = { conversaId: 3, outroId: "u2", autorNome: "Bruno",
                    mensagem: { id: 9, minha: false, texto: "chegou a escala?" } };
  const minha = { conversaId: 3, outroId: "u2", autorNome: "Ana",
                  mensagem: { id: 10, minha: true, texto: "chegou sim" } };

  console.log("\n=== QUANDO A CAIXINHA APARECE ===");
  ok(decide(doOutro, true) === true,
     "janela escondida (outro programa na frente) -> avisa  <-- e para isto que ela existe");
  ok(decide(doOutro, false) === false,
     "pessoa olhando a tela -> NAO avisa: o selo vermelho e o bip ja contaram");
  ok(decide(minha, true) === false,
     "o que eu mesma mandei nunca vira aviso, nem com a janela escondida");
  ok(decide(minha, false) === false, "e muito menos com ela na frente");

  console.log("\n=== NAO QUEBRAR COM DADO ESTRANHO ===");
  ok(decide(null, true) === false, "sem mensagem nenhuma -> nao avisa, e nao estoura");
  ok(decide({ conversaId: 1 }, true) === false, "evento sem mensagem dentro -> nao avisa");

  // ---------------------------------------------------------------------------
  // A FAIXA DENTRO DO PAINEL
  //
  // Aqui esteve um defeito real: quem ja tinha o navegador bloqueando avisos
  // caia no mesmo caso de quem ja tinha ligado, e a faixa sumia. A pessoa abria
  // o chat, nao via botao nenhum e nao tinha como descobrir o motivo — foi
  // exatamente o que aconteceu no primeiro teste de verdade.
  console.log("\n=== O QUE A FAIXA DIZ EM CADA SITUACAO ===");
  const faixa = janela.window.UGChat._estadoDoConvite;
  const AGORA = 1000000;

  ok(faixa("default", 0, AGORA) === "convite",
     "navegador que ainda nao perguntou nada -> oferece ligar");
  ok(faixa("denied", 0, AGORA) === "bloqueado",
     "navegador bloqueando -> explica onde desbloquear  <-- o caso que sumia calado");
  ok(faixa("granted", 0, AGORA) === "nada",
     "ja ligado -> nao fica repetindo recado que a pessoa nao precisa");
  ok(faixa(null, 0, AGORA) === "nada",
     "navegador sem o recurso -> nao promete o que nao da para cumprir");

  ok(faixa("default", AGORA + 500, AGORA) === "nada",
     "quem disse 'agora nao' nao e incomodado de novo");
  ok(faixa("default", AGORA - 500, AGORA) === "convite",
     "mas o adiamento VENCE: nao existe 'nunca mais', que deixaria a pessoa sem volta");
  ok(faixa("denied", AGORA + 500, AGORA) === "nada",
     "e o aviso de bloqueado tambem pode ser dispensado por um tempo");

  // ---------------------------------------------------------------------------
  // O NOME NA ABA
  //
  // No grupo ha tres Alexandres. Com "Alexandre" em duas abas, a pessoa tem que
  // clicar para descobrir qual e qual — e a aba deixa de servir para o que
  // serve, que e trocar de conversa sem procurar.
  console.log("\n=== O NOME QUE CABE NA ABA ===");
  const rotulo = janela.window.UGChat._rotuloDaAba;

  ok(rotulo("Rodrigo Moraes", ["Rodrigo Moraes", "Gisele Alves"]) === "Rodrigo",
     "nome unico na barra -> so o primeiro nome");
  ok(rotulo("Alexandre Crespo", ["Alexandre Crespo", "Alexandre Oliveira"]) === "Alexandre C.",
     "dois Alexandres abertos -> entra a inicial do sobrenome");
  ok(rotulo("Alexandre Oliveira", ["Alexandre Crespo", "Alexandre Oliveira"]) === "Alexandre O.",
     "e o outro ganha a dele");
  ok(rotulo("Gisele", ["Gisele", "Gisele"]) === "Gisele",
     "quem so tem um nome no cadastro nao vira 'Gisele undefined.'");
  ok(rotulo("", []) === "?", "cadastro sem nome nao quebra a barra de abas");

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
