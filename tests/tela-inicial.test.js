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

async function rodarTela({ usuario, modulos, publicacoes = [], reservas = null, euNasTarefas = 7 }) {
  const documento = criarDocumento();
  const respostas = {
    "/api/eu": { usuario, modulos },
    "/api/mural?limite=5": { publicacoes },
    "/api/mural/popup": { publicacao: null },
    "/tarefas/api/me": { usuario: { id: euNasTarefas, nome: "Fulana" } },
  };
  // As reservas vem das Tarefas, atraves da Fachada. A URL leva as datas
  // calculadas na hora, entao o casamento aqui e por prefixo.
  const fetchFalso = async (url) => {
    if (String(url).startsWith("/tarefas/api/reservas-sala")) {
      if (reservas === null) throw new Error("Tarefas fora do ar");
      return { ok: true, json: async () => reservas, headers: { get: () => null } };
    }
    return {
      ok: true,
      json: async () => respostas[url] || {},
      headers: { get: () => null },
    };
  };

  const script = scriptDe("inicio.html");
  // A pagina chama carregar() no fim; aqui ela roda com as pecas de mentira.
  // Espera tambem o painel de reservas, que a pagina dispara sem segurar o
  // desenho — senao o teste olharia a tela antes de ele chegar.
  const fn = new Function("document", "fetch", "location", "window",
    script + "\nreturn carregar().then(function () { return reservasPendentes; });");
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

  console.log("\n=== O ATALHO DA AGENDA DE SALAS ===");
  // A reserva de sala mora dentro das Tarefas, mas muita gente entra no portal
  // so para isso. O cartao leva direto la, com ?ir=agenda-salas.
  //
  // A regra que importa: so aparece para quem tem o modulo Tarefas. Cartao que
  // leva a um 403 e pior do que cartao nenhum.
  const comTarefas = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: [{ id: "tarefas", nome: "Gestão de Tarefas", descricao: "Tarefas e agenda de salas",
                papel: "coordenador", papelRotulo: "Coordenador", icone: "tarefas" }],
  });
  const htmlComTarefas = comTarefas.getElementById("grade").innerHTML;
  ok(htmlComTarefas.includes("Agenda de Salas"),
     "quem tem Tarefas ve o atalho da agenda de salas");
  ok(htmlComTarefas.includes("/tarefas/?ir=agenda-salas"),
     "e ele aponta para a tela certa, dentro do modulo");
  ok(htmlComTarefas.includes('data-chave="tarefas:salas"'),
     "com chave propria — da para arrastar como qualquer outro cartao");

  const semTarefas = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: [{ id: "crm", nome: "CRM Comercial", descricao: "Pipeline",
                papel: "vendedor", papelRotulo: "Vendedor", icone: "crm" }],
  });
  ok(!semTarefas.getElementById("grade").innerHTML.includes("Agenda de Salas"),
     "quem NAO tem Tarefas nao ve o atalho  <-- levaria a um 403");

  // As duas agendas do portal precisam ser distinguiveis de relance: a de
  // contatos e a de salas apareciam as duas como "Agenda".
  ok(htmlComTarefas.includes("Agenda de Contatos"),
     "a agenda de gente se chama 'Agenda de Contatos'");
  ok(!/>Agenda</.test(htmlComTarefas),
     "e nenhuma das duas se chama so 'Agenda'");

  console.log("\n=== AS RESERVAS DE SALA DA PROPRIA PESSOA ===");
  // O painel fica acima do mural, na coluna da direita: e informacao com hora
  // marcada, e perder de vista custa uma reuniao.
  const hoje = new Date();
  const iso = (d) => d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") +
                     "-" + String(d.getDate()).padStart(2, "0");
  const daquiADias = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

  const comReservas = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: [{ id: "tarefas", nome: "Gestão de Tarefas", descricao: "Tarefas",
                papel: "coordenador", papelRotulo: "Coordenador", icone: "check" }],
    euNasTarefas: 7,
    reservas: [
      // minha, daqui a dois dias
      { id: 1, usuario_id: 7, usuario_nome: "Fulana", sala: "menor", titulo: "Reunião comercial",
        data: daquiADias(2) + "T00:00:00.000Z", hora_inicio: 540, hora_fim: 600,
        participantes: [] },
      // de outra pessoa, mas eu sou participante
      { id: 2, usuario_id: 99, usuario_nome: "Beltrano", sala: "tao", titulo: "Alinhamento",
        data: daquiADias(3) + "T00:00:00.000Z", hora_inicio: 870, hora_fim: 930,
        participantes: [{ id: 7, nome: "Fulana" }] },
      // de outra pessoa, sem mim: NAO e minha
      { id: 3, usuario_id: 99, usuario_nome: "Beltrano", sala: "principal", titulo: "Reunião alheia",
        data: daquiADias(1) + "T00:00:00.000Z", hora_inicio: 480, hora_fim: 540,
        participantes: [] },
      // minha, hoje, mas ja terminou
      { id: 4, usuario_id: 7, usuario_nome: "Fulana", sala: "auditorio", titulo: "Reunião de ontem à noite",
        data: iso(hoje) + "T00:00:00.000Z", hora_inicio: 0, hora_fim: 1,
        participantes: [] },
    ],
  });

  const painel = comReservas.getElementById("salasLista").innerHTML;
  ok(comReservas.getElementById("salas").style.display === "",
     "o painel de reservas aparece para quem tem Tarefas");
  ok(painel.includes("Reunião comercial"), "a reserva que eu fiz aparece");
  ok(painel.includes("Alinhamento"),
     "e a reserva de outra pessoa em que eu sou participante tambem  <-- e quem mais esquece");
  ok(painel.includes("de Beltrano"), "com o nome de quem reservou, quando nao fui eu");
  ok(!painel.includes("Reunião alheia"),
     "reserva de outra pessoa sem mim NAO aparece — o painel e o meu dia, nao a agenda inteira");
  ok(!painel.includes("Reunião de ontem à noite"),
     "e reserva de hoje que ja terminou some — as 15h nao adianta ver a das 9h");
  // A API devolve a sala como chave ("menor") e a hora como minutos desde a
  // meia-noite (870). Os dois precisam chegar tratados na tela — foi assim que
  // "870" apareceu no lugar do horario em producao.
  ok(painel.includes("Sala Menor") && painel.includes("Sala 6 - TAO"),
     "a chave da sala vira o nome que a pessoa conhece");
  ok(painel.includes("09:00") && painel.includes("14:30"),
     "e os minutos viram hora de relogio  <-- 870 nao e horario nenhum");
  ok(!painel.includes(">870<") && !painel.includes(">540<"),
     "o numero cru nao aparece em lugar nenhum");
  ok(painel.includes('href="/tarefas/?ir=agenda-salas"'), "e o rodape leva para a agenda inteira");

  console.log("\n=== O PAINEL NAO PODE DERRUBAR A TELA INICIAL ===");
  // A pessoa entrou para abrir os modulos. Se as Tarefas estiverem fora do ar,
  // o painel some e o resto da tela continua de pe.
  const comTarefasFora = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: [{ id: "tarefas", nome: "Gestão de Tarefas", descricao: "Tarefas",
                papel: "coordenador", papelRotulo: "Coordenador", icone: "check" }],
    reservas: null,   // a chamada estoura
  });
  ok(comTarefasFora.getElementById("grade").innerHTML.includes("Gestão de Tarefas"),
     "com as Tarefas fora do ar, os modulos continuam desenhados");
  ok(comTarefasFora.getElementById("salas").style.display === "none" ||
     comTarefasFora.getElementById("salas").style.display === undefined,
     "e o painel de reservas simplesmente nao aparece");

  console.log("\n=== SEM RESERVA NENHUMA, O PAINEL CONVIDA ===");
  const semReservas = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: [{ id: "tarefas", nome: "Gestão de Tarefas", descricao: "Tarefas",
                papel: "coordenador", papelRotulo: "Coordenador", icone: "check" }],
    reservas: [],
  });
  ok(semReservas.getElementById("salasLista").innerHTML.includes("Nenhuma reserva sua"),
     "quem nao tem reserva ve que nao tem, em vez de um espaco vazio");
  ok(semReservas.getElementById("salasLista").innerHTML.includes("Reservar uma sala"),
     "com o caminho para reservar");

  console.log("\n=== QUEM NAO TEM TAREFAS NAO VE O PAINEL ===");
  const semTarefasNoPainel = await rodarTela({
    usuario: { nome: "Fulana", superAdmin: false, senhaTemp: false, exigirPerfil: false },
    modulos: [{ id: "crm", nome: "CRM Comercial", descricao: "Pipeline",
                papel: "vendedor", papelRotulo: "Vendedor", icone: "briefcase" }],
    reservas: [{ id: 1, usuario_id: 7, sala: "menor", titulo: "Nao deveria aparecer",
                 data: daquiADias(1) + "T00:00:00.000Z", hora_inicio: 540,
                 hora_fim: 600, participantes: [] }],
  });
  ok(!semTarefasNoPainel.getElementById("salasLista").innerHTML.includes("Nao deveria aparecer"),
     "sem o modulo Tarefas, o painel nem e consultado");

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
