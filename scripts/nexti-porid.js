"use strict";

// ============================================================================
// Consultar um checklist pelo ID — o caminho que a tela do Nexti Control usa
// ----------------------------------------------------------------------------
//     railway ssh --service core "node scripts/nexti-porid.js <id> [dias]"
//
// So le, nao grava nada.
//
// POR QUE ELE EXISTE
// O Rodrigo abriu o Nexti Control e mostrou a lista de checklists com os IDs:
// VISITA DE ROTINA e o 565272. Isso destrava um endpoint que ate agora nao
// dava para usar por falta do id:
//
//     GET /checklists/answer/checklist/{id}/start/{start}/finish/{finish}
//
// Se ele devolver as respostas de TODOS os postos de uma vez, e melhor que o
// caminho por /controltasks/finished em dois pontos:
//   - uma chamada por periodo, em vez de uma por dia
//   - vem `checklistSupervisorId` e `personId`, alem do posto
//
// E as abas da tela (em aberto / finalizado / cancelado) batem com o statusId
// do ChecklistDto (1 nao respondido, 2 respondido, 4 cancelado) — o que sugere
// que /checklists/{id} devolve o mesmo que a tela mostra.
//
// A duvida que ele resolve: o id da TELA (565272) e o mesmo que aparece dentro
// da control task (vimos 439285 e 416095 para "VISITA DE ROTINA")? Se forem
// diferentes, ha uma definicao por posto, e o id da tela e o "modelo".
// ============================================================================

const nexti = require("../core/nexti.js");

const ID = process.argv[2];
const DIAS = Number(process.argv[3] || 30);

if (!ID) { console.log("uso: node scripts/nexti-porid.js <id> [dias]"); process.exit(1); }

(async () => {
  if (!nexti.configurado()) { console.log("Credencial nao configurada."); process.exit(1); }

  const fim = new Date();
  const inicio = new Date(fim.getTime() - DIAS * 24 * 3600 * 1000);
  inicio.setHours(0, 0, 0, 0);

  console.log(`Checklist #${ID}, ultimos ${DIAS} dias`);

  // ---- 1. a definicao ----
  console.log("");
  console.log("=== A DEFINICAO  (GET /checklists/{id}) ===");
  try {
    const d = await nexti.chamar(`/checklists/${encodeURIComponent(ID)}`);
    const c = d && (d.content || d);
    console.log(`  nome:      ${c.name || "(sem nome)"}`);
    console.log(`  situacao:  ${nexti.STATUS_ROTULO[c.statusId] || c.statusId}`);
    console.log(`  tipo:      ${c.checklistTypeId === 1 ? "COLABORADOR" : c.checklistTypeId === 2 ? "POSTO" : c.checklistTypeId}`);
    console.log(`  recorrente: ${c.recurrent}`);
    console.log(`  inicio:    ${c.startDateTime}   fim: ${c.finishDateTime}`);
    console.log(`  perguntas: ${(c.questions || []).length}`);
    (c.questions || []).slice(0, 5).forEach((q) =>
      console.log(`     - ${String(q.name || q.description || JSON.stringify(q)).slice(0, 76)}`));
    console.log(`  postos vinculados:     ${(c.workplaces || []).length}`);
    console.log(`  clientes vinculados:   ${(c.clients || []).length}`);
    console.log(`  pessoas vinculadas:    ${(c.persons || []).length}`);
    console.log(`  enviaPara todos:       ${c.sendToAll}`);
  } catch (e) {
    console.log(`  FALHOU: ${e.message}  (causa: ${e.causa || "?"})`);
  }

  // ---- 2. as respostas ----
  console.log("");
  console.log("=== AS RESPOSTAS  (GET /checklists/answer/checklist/{id}/...) ===");
  let respostas = [];
  try {
    respostas = await nexti.respostasDoChecklist(ID, inicio, fim);
  } catch (e) {
    console.log(`  FALHOU: ${e.message}  (causa: ${e.causa || "?"})`);
    process.exit(0);
  }
  console.log(`  Respostas no periodo: ${respostas.length}`);
  if (!respostas.length) {
    console.log("  Zero. Ou o id nao tem resposta no periodo, ou este endpoint");
    console.log("  quer outro tipo de id (o da tela pode ser o 'modelo', e as");
    console.log("  ocorrencias terem ids proprios, como os 439285/416095 que");
    console.log("  aparecem dentro das control tasks).");
    process.exit(0);
  }

  const datas = respostas.map((r) => nexti.deDataNexti(r.answerDate)).filter(Boolean).sort((a, b) => a - b);
  if (datas.length) {
    console.log(`  Periodo real: ${datas[0].toLocaleString("pt-BR")} a ${
      datas[datas.length - 1].toLocaleString("pt-BR")}`);
  }
  const ilegiveis = respostas.filter((r) => !nexti.deDataNexti(r.answerDate)).length;
  if (ilegiveis) console.log(`  *** ${ilegiveis} datas nao foram lidas`);

  const postos = new Set(respostas.map((r) => r.workplaceId).filter(Boolean));
  const pessoas = new Set(respostas.map((r) => r.personId).filter(Boolean));
  const sups = new Set(respostas.map((r) => r.checklistSupervisorId).filter(Boolean));
  console.log(`  Postos distintos:       ${postos.size}`);
  console.log(`  Colaboradores (personId): ${pessoas.size}`);
  console.log(`  checklistSupervisorId preenchido em: ${
    respostas.filter((r) => r.checklistSupervisorId).length} de ${respostas.length}` +
    (sups.size ? `  (${sups.size} distintos)` : ""));

  console.log("");
  console.log("  Amostra:");
  respostas.slice(0, 4).forEach((r) => {
    const d = nexti.deDataNexti(r.answerDate);
    console.log("");
    console.log(`    resposta #${r.id}  em ${d ? d.toLocaleString("pt-BR") : r.answerDate}`);
    console.log(`      posto ${r.workplaceId} | pessoa ${r.personId} | supervisor ${
      r.checklistSupervisorId || "-"} | dispositivo ${r.deviceCode || "-"}`);
    (r.answers || []).slice(0, 3).forEach((a) =>
      console.log(`      - ${String(a.questionName || "").slice(0, 52)} => ${
        String(a.answerText != null ? a.answerText : a.answerValue).slice(0, 26)}`));
  });

  console.log("");
  console.log("=== O QUE ISSO MUDA ===");
  console.log(`  Se este caminho funciona, o painel busca UMA vez por periodo`);
  console.log(`  (${respostas.length} respostas numa consulta) em vez de uma chamada por dia.`);

  console.log("");
  console.log("Fim. Nada foi gravado.");
})().catch((e) => { console.error("ERRO:", e && e.message); process.exit(1); });
