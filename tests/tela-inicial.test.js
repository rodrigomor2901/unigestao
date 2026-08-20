// A tela inicial realmente desenha os modulos?
//
// POR QUE ESTE TESTE EXISTE
// Uma remocao de bloco em inicio.html levou junto a funcao cartaoAgenda(). O
// arquivo continuou com sintaxe valida — o erro so aparece quando carregar()
// tenta CHAMAR a funcao que nao existe mais. Resultado: a grade nunca era
// preenchida e a tela inicial ficou sem modulo nenhum, em producao.
//
// Conferir sintaxe nao pega isso. Este teste executa o script da pagina de
// verdade, com um documento e um fetch de mentira, e olha o que foi desenhado.
const fs = require("fs");
const path = require("path");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// Documento de mentira: guarda o que cada elemento recebeu, para o teste poder
// olhar depois. So o suficiente para a pagina rodar — nao e um navegador.
function criarDocumento() {
  const elementos = new Map();
  const novo = (id) => ({
    id, innerHTML: "", textContent: "", style: {}, value: "",
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, querySelectorAll: () => [], remove() {},
  });
  return {
    elementos,
    getElementById(id) {
      if (!elementos.has(id)) elementos.set(id, novo(id));
      return elementos.get(id);
    },
    querySelector: () => novo("qualquer"),
    createElement: () => ({ ...novo("criado"), appendChild() {} }),
    body: { appendChild() {} },
    addEventListener() {},
  };
}

function scriptDe(arquivo) {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", arquivo), "utf8");
  const m = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  return m.map((x) => x[1]).join("\n");
}

const MODULOS = [
  { nome: "Movimentação Operacional", descricao: "Extras", base: "/operacional", papelRotulo: "CCO" },
  { nome: "CRM Comercial", descricao: "Pipeline", base: "/crm", papelRotulo: "Vendedor" },
];

async function rodarTela({ usuario, modulos, publicacoes = [] }) {
  const documento = criarDocumento();
  const respostas = {
    "/api/eu": { usuario, modulos },
    "/api/mural?limite=5": { publicacoes },
    "/api/mural/popup": { publicacao: null },
  };
  const fetchFalso = async (url) => ({
    ok: true,
    json: async () => respostas[url] || {},
    headers: { get: () => null },
  });

  const script = scriptDe("inicio.html");
  // A pagina chama carregar() no fim; aqui ela roda com as pecas de mentira.
  const fn = new Function("document", "fetch", "location", "window", script + "\nreturn carregar();");
  await fn(documento, fetchFalso, { href: "/" }, { location: {} });
  return documento;
}

(async () => {
  console.log("\n=== OS MODULOS APARECEM ===");
  const doc = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: MODULOS,
  });
  const grade = doc.getElementById("grade").innerHTML;

  ok(grade.includes("Movimentação Operacional"), "o primeiro modulo foi desenhado");
  ok(grade.includes("CRM Comercial"), "o segundo tambem");
  ok(grade.includes('href="/operacional/"'), "com o endereco certo");
  ok(doc.getElementById("sub").textContent.includes("2 módulos"), "e a contagem confere");

  console.log("\n=== E OS CARTOES DO PORTAL JUNTO ===");
  ok(grade.includes("Mural"), "o cartao do Mural aparece");
  ok(grade.includes("Agenda"), "o cartao da Agenda aparece");
  ok(grade.includes('href="/mural"') && grade.includes('href="/agenda"'),
     "os dois apontam para as paginas do portal");

  console.log("\n=== SEM MODULO LIBERADO, A PESSOA NAO FICA NO VAZIO ===");
  const vazio = await rodarTela({
    usuario: { nome: "Novata", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: [],
  });
  const gradeVazia = vazio.getElementById("grade").innerHTML;
  ok(gradeVazia.includes("nenhum módulo liberado"), "explica a situacao");
  ok(gradeVazia.includes("Agenda"),
     "e ainda oferece a agenda — achar quem libera o acesso e o que ela precisa agora");

  console.log("\n=== SENHA PROVISORIA CONTINUA BARRANDO ===");
  const comSenhaTemp = await rodarTela({
    usuario: { nome: "Recem", superAdmin: false, senhaTemp: true, exigirPerfil: false },
    modulos: MODULOS,
  });
  ok(!comSenhaTemp.getElementById("grade").innerHTML.includes("CRM Comercial"),
     "quem esta com senha provisoria nao ve modulo nenhum");

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
