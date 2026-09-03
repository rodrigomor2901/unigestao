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
    body: { appendChild() {} },
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

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
