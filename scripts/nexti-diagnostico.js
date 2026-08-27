"use strict";

// ============================================================================
// Diagnostico da conexao com o Nexti
// ----------------------------------------------------------------------------
// Roda no servico do CORE, onde as credenciais moram:
//
//     railway ssh --service core "node scripts/nexti-diagnostico.js"
//
// NAO GRAVA NADA. So le, e conta o que achou.
//
// POR QUE ELE EXISTE
// A especificacao do Nexti deixa tres coisas em aberto, e todas as tres
// derrubariam o painel se a gente construisse por cima do palpite errado:
//
//   1. O FORMATO DAS DATAS. A documentacao se contradiz — os parametros dizem
//      `date-time` (ISO), os exemplos dos campos dizem `ddMMyyyyHHmmss`, e
//      outros endpoints escrevem ddMMyyyyHHmmss na descricao. Escolhemos o
//      segundo. Se estiver errado, o sintoma NAO e um erro claro: e uma janela
//      de datas silenciosamente diferente da pedida, com a tela mostrando
//      numeros que parecem certos. Este script pergunta por um dia conhecido e
//      mostra o que voltou, para dar para conferir com o olho.
//
//   2. O VINCULO SUPERVISOR -> POSTOS. Deduzimos que sai das Areas
//      (`personSupervisors` + `workplaceIds`). Aqui se ve se as areas estao
//      mesmo preenchidas na conta da Uniseter, ou se estao vazias — caso em que
//      o agrupamento por supervisor nao teria de onde sair.
//
//   3. O TAMANHO DA OPERACAO. Quantos postos existem decide o ritmo da
//      sincronizacao. 30 e um cenario; 300 e outro.
//
// De quebra, mede o tempo das chamadas — que e o que diz se o painel sob
// demanda vai abrir em 3 segundos ou em 30.
// ============================================================================

const nexti = require("../core/nexti.js");

const linha = (t) => console.log(t);
const titulo = (t) => { console.log(""); console.log("=== " + t + " ==="); };

function amostra(lista, quantos, comoMostrar) {
  lista.slice(0, quantos).forEach((x) => linha("    " + comoMostrar(x)));
  if (lista.length > quantos) linha(`    ... e mais ${lista.length - quantos}`);
}

(async () => {
  titulo("CREDENCIAL");
  if (!nexti.configurado()) {
    linha("  NAO configurada.");
    linha("  Faltam NEXTI_CLIENT_ID e/ou NEXTI_CLIENT_SECRET no servico core.");
    process.exit(1);
  }
  linha("  Variaveis presentes. Endereco: " + nexti.BASE);

  const t0 = Date.now();
  try {
    await nexti.pegarToken();
    linha(`  Autenticou em ${Date.now() - t0}ms.`);
  } catch (e) {
    linha("  FALHOU ao autenticar: " + e.message);
    linha("  (causa: " + (e.causa || "?") + ")");
    process.exit(1);
  }

  // ---- tamanho da operacao ----
  titulo("TAMANHO DA OPERACAO");
  const tP = Date.now();
  const postos = await nexti.postos();
  linha(`  Postos: ${postos.length}  (em ${Date.now() - tP}ms)`);
  amostra(postos, 5, (p) => `#${p.id}  ${p.name || p.nome || "(sem nome)"}` +
                            (p.active === false ? "  [inativo]" : ""));

  const tC = Date.now();
  const clientes = await nexti.clientes();
  linha(`  Clientes: ${clientes.length}  (em ${Date.now() - tC}ms)`);
  amostra(clientes, 5, (c) => `#${c.id}  ${c.name || c.nome || "(sem nome)"}`);

  // ---- supervisores ----
  titulo("SUPERVISOR -> POSTOS (via Areas)");
  const areas = await nexti.areas();
  linha(`  Areas: ${areas.length}`);
  let comSupervisor = 0, comPosto = 0;
  const supervisores = new Map();
  areas.forEach((a) => {
    const sups = a.personSupervisors || [];
    const ids = a.personSupervisorIds || [];
    const postosDaArea = a.workplaceIds || [];
    if (sups.length || ids.length) comSupervisor++;
    if (postosDaArea.length) comPosto++;
    sups.forEach((s) => {
      const nome = s.name || s.nome || ("#" + (s.id || "?"));
      supervisores.set(nome, (supervisores.get(nome) || 0) + postosDaArea.length);
    });
  });
  linha(`  Areas com supervisor definido: ${comSupervisor} de ${areas.length}`);
  linha(`  Areas com posto vinculado:     ${comPosto} de ${areas.length}`);
  linha(`  Supervisores distintos: ${supervisores.size}`);
  if (supervisores.size === 0) {
    linha("  ATENCAO: nenhum supervisor saiu das areas.");
    linha("  Sem isso o painel nao tem como agrupar por supervisor — o agrupamento");
    linha("  teria que ser por cliente ou por posto. Vale conferir no painel do Nexti");
    linha("  se as areas estao cadastradas com supervisor e postos.");
  } else {
    amostra([...supervisores], 8, ([nome, n]) => `${nome}  —  ${n} posto(s)`);
  }
  const semArea = postos.filter((p) =>
    !areas.some((a) => (a.workplaceIds || []).includes(p.id))).length;
  linha(`  Postos fora de qualquer area: ${semArea}`);

  // ---- o teste que importa: o formato das datas ----
  titulo("FORMATO DAS DATAS  (a incognita que mais importa)");
  const primeiro = postos.find((p) => p.active !== false) || postos[0];
  if (!primeiro) {
    linha("  Nenhum posto para consultar.");
    process.exit(0);
  }

  // Uma janela larga, para haver o que voltar mesmo em dia parado.
  const fim = new Date();
  const inicio = new Date(fim.getTime() - 7 * 24 * 3600 * 1000);
  inicio.setHours(0, 0, 0, 0);

  linha(`  Posto usado: #${primeiro.id} ${primeiro.name || ""}`);
  linha(`  Janela pedida: ${inicio.toLocaleString("pt-BR")}  ate  ${fim.toLocaleString("pt-BR")}`);
  linha(`  Como foi enviada: start=${nexti.paraDataNexti(inicio)}  finish=${nexti.paraDataNexti(fim)}`);

  const tL = Date.now();
  let lista;
  try {
    lista = await nexti.checklistsDoPosto(primeiro.id, inicio, fim);
  } catch (e) {
    linha("  FALHOU: " + e.message + "  (causa: " + (e.causa || "?") + ")");
    linha("");
    linha("  Se a causa for 'resposta', o formato da data e o primeiro suspeito.");
    linha("  Trocar paraDataNexti() em core/nexti.js para ISO e rodar de novo.");
    process.exit(1);
  }
  linha(`  Checklists no periodo: ${lista.length}  (em ${Date.now() - tL}ms)`);

  if (lista.length === 0) {
    linha("");
    linha("  Zero registros. Pode ser posto parado — ou data no formato errado.");
    linha("  NAO da para distinguir os dois casos so por aqui: rodar de novo com");
    linha("  um posto que voce SAIBA que teve checklist esta semana.");
  } else {
    linha("  Datas como o Nexti devolveu, e como lemos:");
    lista.slice(0, 5).forEach((c) => {
      const lido = nexti.deDataNexti(c.startDateTime);
      linha(`    "${c.name}"`);
      linha(`       cru: ${c.startDateTime}   ->   lido: ` +
            (lido ? lido.toLocaleString("pt-BR") : "*** NAO CONSEGUI LER ***"));
      linha(`       situacao: ${nexti.STATUS_ROTULO[c.statusId] || c.statusId}`);
    });
    const ilegiveis = lista.filter((c) => !nexti.deDataNexti(c.startDateTime)).length;
    linha("");
    if (ilegiveis) {
      linha(`  *** ${ilegiveis} de ${lista.length} datas nao foram lidas.`);
      linha("  O formato NAO e ddMMyyyyHHmmss. Ajustar core/nexti.js.");
    } else {
      linha("  Todas as datas lidas. O formato ddMMyyyyHHmmss esta correto.");
    }

    // A pergunta que a especificacao deixou sem resposta.
    titulo("checklistSupervisorId — da para usar?");
    const alvo = lista[0];
    const resp = await nexti.respostasDoChecklist(alvo.id, inicio, fim);
    linha(`  Respostas do checklist #${alvo.id}: ${resp.length}`);
    const comSup = resp.filter((r) => r.checklistSupervisorId).length;
    linha(`  Com checklistSupervisorId preenchido: ${comSup} de ${resp.length}`);
    if (comSup) {
      amostra(resp.filter((r) => r.checklistSupervisorId), 3,
        (r) => `supervisorId=${r.checklistSupervisorId}  personId=${r.personId}  ` +
               `postoId=${r.workplaceId}  em ${r.answerDate}`);
      linha("  Se esses ids baterem com ids de pessoas, dao um agrupamento mais");
      linha("  direto que o das areas.");
    }
  }

  // ---- ritmo ----
  titulo("RITMO — quanto o painel vai demorar");
  const porPosto = Math.max(1, Date.now() - tL);
  const ativos = postos.filter((p) => p.active !== false).length || postos.length;
  const total = (porPosto + nexti.PAUSA_MS) * ativos;
  linha(`  Uma consulta de posto levou ~${porPosto}ms.`);
  linha(`  Com ${ativos} postos ativos e ${nexti.PAUSA_MS}ms de pausa entre eles,`);
  linha(`  uma atualizacao completa leva ~${Math.round(total / 1000)}s.`);
  if (total > 25000) {
    linha("  Isso e demais para alguem esperar olhando a tela. A tela deve mostrar");
    linha("  o dado guardado na hora e ir atualizando posto a posto por tras.");
  }

  console.log("");
  console.log("Fim do diagnostico. Nada foi gravado.");
})().catch((e) => { console.error("ERRO:", e && e.message); process.exit(1); });
