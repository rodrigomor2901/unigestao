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
    id, innerHTML: "", textContent: "", style: {}, value: "", dataset: {},
    classList: { toggle() {}, add() {}, remove() {} },
    addEventListener() {}, querySelectorAll: () => [], remove() {},
    insertAdjacentHTML() {}, setAttribute() {}, getAttribute: () => null,
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

// Com `id`: e o que a API devolve de verdade (ver modulosDoUsuario em
// server.js), e e a chave que a tela usa para guardar a ordem dos cartoes.
const MODULOS = [
  { id: "operacional", nome: "Movimentação Operacional", descricao: "Extras",
    base: "/operacional", papelRotulo: "CCO", icone: "truck" },
  { id: "crm", nome: "CRM Comercial", descricao: "Pipeline", base: "/crm",
    papelRotulo: "Vendedor", icone: "briefcase" },
];

// Quantos quadrados de icone existem no HTML desenhado.
const quantosIcones = (html) => (html.match(/class="ic"/g) || []).length;

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

  console.log("\n=== CADA CARTAO TEM SEU ICONE ===");
  // O nome do icone vem do registro de modulos (core/modulos.js). Ele existia
  // ha tempos e nao era usado em lugar nenhum — se alguem o remover de la, e
  // aqui que isso aparece, em vez de a tela ficar com quadrados vazios.
  ok(quantosIcones(grade) === 4, "dois modulos mais Mural e Agenda: quatro icones");
  ok(grade.includes("<svg viewBox=\"0 0 24 24\""), "desenhados como SVG na propria pagina");

  // Plugar um sistema novo nao pode quebrar a tela inicial por causa de um
  // icone que ninguem cadastrou.
  const desconhecido = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: [{ nome: "Sistema Novo", descricao: "?", base: "/novo",
                papelRotulo: "Admin", icone: "icone-que-nao-existe" }],
  });
  const gradeNova = desconhecido.getElementById("grade").innerHTML;
  ok(quantosIcones(gradeNova) === 3, "icone desconhecido nao deixa o cartao sem quadrado");
  ok(gradeNova.includes("Sistema Novo"), "e o modulo continua aparecendo normalmente");

  // Modulo antigo, cadastrado antes de o campo existir, tambem nao pode falhar.
  const semIcone = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: [{ nome: "Sem Icone", descricao: "?", base: "/x", papelRotulo: "Admin" }],
  });
  ok(quantosIcones(semIcone.getElementById("grade").innerHTML) === 3,
     "modulo sem o campo `icone` tambem ganha o quadrado generico");

  console.log("\n=== A ORDEM SALVA PELA PESSOA E RESPEITADA ===");
  // A ordem e uma PREFERENCIA, nunca um filtro. O erro caro aqui seria usar a
  // lista salva para decidir o que mostrar: quem ganhasse um modulo novo nao o
  // veria, e ninguem entenderia por que.
  const ordenado = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false,
               ordemModulos: ["portal:agenda", "crm"] },
    modulos: MODULOS,
  });
  const g = ordenado.getElementById("grade").innerHTML;
  const posDe = (t) => g.indexOf(t);
  ok(posDe("Agenda") < posDe("CRM Comercial"),
     "a Agenda, salva em primeiro, vem antes do CRM");
  ok(posDe("CRM Comercial") < posDe("Movimentação Operacional"),
     "o CRM, salvo em segundo, vem antes do que nao foi arrastado");
  ok(posDe("Movimentação Operacional") > 0,
     "e o modulo fora da lista salva NAO some — so vai para o fim");
  ok(posDe("Mural") > 0, "o Mural, tambem fora da lista, continua na tela");

  // Cada cartao precisa levar a chave, senao nao ha o que salvar depois.
  ok(g.includes('data-chave="crm"'), "cada cartao carrega a chave que sera salva");
  ok(g.includes('data-chave="portal:mural"'),
     "inclusive as telas do proprio portal, com chave propria");

  // Chave que nao existe mais (modulo removido da pessoa) nao pode quebrar nada.
  const comLixo = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false,
               ordemModulos: ["modulo-que-nao-existe-mais", "crm"] },
    modulos: MODULOS,
  });
  const g2 = comLixo.getElementById("grade").innerHTML;
  ok(g2.includes("CRM Comercial") && g2.includes("Movimentação Operacional"),
     "chave orfa na ordem salva e ignorada, e a tela desenha normalmente");

  // Sem ordem salva (todo mundo, no primeiro acesso) nada muda.
  const semOrdem = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: MODULOS,
  });
  const g3 = semOrdem.getElementById("grade").innerHTML;
  ok(g3.indexOf("Movimentação Operacional") < g3.indexOf("CRM Comercial"),
     "sem ordem salva, vale a ordem natural do registro de modulos");

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
