// O balao do chat pode ser arrastado — e tem que continuar alcancavel.
//
// POR QUE ESTE TESTE EXISTE
// O balao mora no canto de baixo a direita e as vezes cai em cima de um botao do
// modulo (15/09/2026). Agora ele se arrasta, e a posicao fica gravada no
// navegador da pessoa. Dois defeitos possiveis, os dois sem conserto pela tela:
//   - o balao parar fora da area visivel (ou so a metade dele), e nao dar mais
//     para pega-lo de volta — inclusive ao abrir num monitor menor;
//   - o painel abrir para um lado que nao cabe, ficando metade fora da tela.
//
// Roda o chat.js de verdade, com documento e fetch de mentira.
const fs = require("fs");
const path = require("path");
const vm = require("vm");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

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
    getBoundingClientRect: () => ({ width: 52, height: 52, right: 0, bottom: 0 }),
  };
  return el;
}

function criarDocumento() {
  return {
    hidden: false, title: "UniGestão", readyState: "complete",
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
    innerWidth: 1366, innerHeight: 768,
    fetch: async () => ({
      ok: true, status: 200,
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
  await new Promise((r) => setTimeout(r, 50));

  const limitar = janela.window.UGChat && janela.window.UGChat._limitarLugar;
  const lados = janela.window.UGChat && janela.window.UGChat._ladosDoPainel;
  ok(typeof limitar === "function" && typeof lados === "function",
     "o chat expoe as contas do balao para serem conferidas");
  if (typeof limitar !== "function") {
    console.log("\n" + (falhas || 1) + " TESTE(S) FALHARAM");
    process.exitCode = 1;
    return;
  }

  const TELA = { largura: 1366, altura: 768 };

  console.log("\n=== O BALAO NUNCA SAI DA TELA ===");
  ok(limitar({ direita: 400, baixo: 300 }, TELA).direita === 400,
     "onde a pessoa soltou, fica");
  const foraDireita = limitar({ direita: -80, baixo: 20 }, TELA);
  ok(foraDireita.direita >= 8,
     "arrastado para alem da borda direita -> volta para dentro  <-- senao nao da mais para pega-lo");
  const foraEsquerda = limitar({ direita: 5000, baixo: 20 }, TELA);
  ok(foraEsquerda.direita <= TELA.largura - 52 - 8, "e para alem da esquerda tambem");
  ok(limitar({ direita: 20, baixo: -50 }, TELA).baixo >= 8, "abaixo do rodape -> volta");
  ok(limitar({ direita: 20, baixo: 5000 }, TELA).baixo <= TELA.altura - 52 - 8,
     "acima do topo -> volta");

  const notebook = { largura: 1024, altura: 600 };
  const guardadoNaTelaGrande = { direita: 1200, baixo: 500 };
  const cabeAqui = limitar(guardadoNaTelaGrande, notebook);
  ok(cabeAqui.direita <= notebook.largura - 52 - 8 && cabeAqui.baixo <= notebook.altura - 52 - 8,
     "lugar guardado numa tela grande cabe na tela pequena do dia seguinte");

  console.log("\n=== O PAINEL ABRE PARA O LADO QUE CABE ===");
  const canto = lados({ direita: 18, baixo: 18 }, TELA);
  ok(canto.direita === 18 && canto.baixo === 18 && !canto.aDireita && !canto.paraBaixo,
     "no canto de sempre, nada muda: painel para cima e para a esquerda");

  const naEsquerda = lados({ direita: TELA.largura - 80, baixo: 18 }, TELA);
  ok(naEsquerda.aDireita === true && naEsquerda.esquerda !== null && naEsquerda.direita === null,
     "balao encostado na esquerda -> o painel abre para a DIREITA dele");

  const noAlto = lados({ direita: 18, baixo: TELA.altura - 120 }, TELA);
  ok(noAlto.paraBaixo === true && noAlto.topo !== null && noAlto.baixo === null,
     "balao no alto -> o painel desce, em vez de subir para fora da tela");

  const cantoDeCima = lados({ direita: TELA.largura - 80, baixo: TELA.altura - 120 }, TELA);
  ok(cantoDeCima.aDireita && cantoDeCima.paraBaixo, "no canto de cima a esquerda, os dois ao mesmo tempo");

  console.log("\n=== E CABE INTEIRO, EM QUALQUER LUGAR ===");
  // Escolher o lado nao basta: com o balao perto do meio da tela, nenhum dos
  // dois lados tem os 520px inteiros e o painel vazava pelo rodape — visto no
  // navegador, 17px para fora, antes desta conta existir.
  function passaDaTela(l, janela) {
    const d = lados(l, janela);
    const topo = d.paraBaixo
      ? d.topo + 52 + 10               // painel logo abaixo do balao
      : janela.altura - d.baixo - 52 - 10 - d.altura;   // painel logo acima
    return topo < 0 || topo + d.altura > janela.altura;
  }

  const lugares = [
    { direita: 18, baixo: 18 }, { direita: 18, baixo: 513 },
    { direita: 18, baixo: 300 }, { direita: 18, baixo: 380 },
    { direita: 700, baixo: 700 }, { direita: 1300, baixo: 40 },
  ];
  const telas = [TELA, { largura: 1024, altura: 600 }, { largura: 1920, altura: 1080 }];
  let vazou = null;
  telas.forEach((t) => lugares.forEach((l) => {
    const dentro = { direita: Math.min(l.direita, t.largura - 60), baixo: Math.min(l.baixo, t.altura - 60) };
    if (!vazou && passaDaTela(dentro, t)) vazou = JSON.stringify({ tela: t, lugar: dentro });
  }));
  ok(vazou === null, "em toda posicao e em toda tela, o painel fica dentro  <-- vazava pelo rodape" +
     (vazou ? "  (" + vazou + ")" : ""));

  const meio = lados({ direita: 18, baixo: 380 }, TELA);
  ok(meio.altura < 520, "perto do meio, o painel encolhe em vez de vazar");
  ok(lados({ direita: 18, baixo: 18 }, TELA).altura === 520,
     "no canto de sempre, segue do tamanho de sempre");

  const telaBaixa = { largura: 1366, altura: 500 };
  const emTelaBaixa = lados({ direita: 18, baixo: 18 }, telaBaixa);
  ok(emTelaBaixa.baixo !== null || emTelaBaixa.topo !== null, "em tela baixa ainda sai uma ancora valida");
  ok(emTelaBaixa.altura >= 180, "e o painel nunca fica menor que o util");

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exitCode = falhas === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
