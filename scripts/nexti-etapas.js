"use strict";

// ============================================================================
// A API entrega as visitas NAO REALIZADAS, disfarcadas de etapa faltando?
// ----------------------------------------------------------------------------
//     railway ssh --service core "node scripts/nexti-etapas.js [ddMMyyyy] [ddMMyyyy]"
//
// So le, nao grava nada.
//
// A APOSTA
// O relatorio "Relacao de visitas" do Nexti tem tres status, e e a unica fonte
// conhecida da visita que NAO aconteceu. Mas ele so sai por download — e o
// pessoal ja faz isso no Power BI hoje, entao um painel que tambem dependa de
// download nao acrescenta nada.
//
// A saida seria a API. O endpoint se chama /controltasks/FINISHED, o que sugere
// que so traz o que foi feito. Mas cada tarefa vem com `taskStages`
// (MOVABLE_STARTED, MOVABLE_FINISH, TASK_STARTED, ...), e talvez a tarefa nao
// realizada esteja la tambem, so que sem as etapas finais. Se estiver, o painel
// fica 100% automatico e o download morre.
//
// COMO CONFERIR
// O relatorio de 01/08 a 27/08/2026 diz, em numero fechado:
//     422 finalizadas   22 iniciadas   23 nao realizadas   = 467
// Este script busca o mesmo periodo pela API e classifica pelas etapas. Se os
// numeros baterem, a aposta esta certa. Se vierem so 422, nao esta.
// ============================================================================

const nexti = require("../core/nexti.js");

const p2 = (n) => String(n).padStart(2, "0");
const refDia = (d) => `${p2(d.getDate())}${p2(d.getMonth() + 1)}${d.getFullYear()}`;
const daArg = (s) => s && /^\d{8}$/.test(s)
  ? new Date(+s.slice(4), +s.slice(2, 4) - 1, +s.slice(0, 2)) : null;

(async () => {
  if (!nexti.configurado()) { console.log("Credencial nao configurada."); process.exit(1); }

  const de = daArg(process.argv[2]) || new Date(2026, 7, 1);
  const ate = daArg(process.argv[3]) || new Date(2026, 7, 27);
  console.log(`Periodo: ${de.toLocaleDateString("pt-BR")} a ${ate.toLocaleDateString("pt-BR")}`);
  console.log("(o relatorio do Nexti, no mesmo periodo: 422 finalizadas, 22 iniciadas, 23 nao realizadas = 467)");
  console.log("");

  const tarefas = [];
  for (let d = new Date(de); d <= ate; d.setDate(d.getDate() + 1)) {
    let pagina = 0, ultimo = false;
    while (!ultimo && pagina < 20) {
      let r;
      try {
        r = await nexti.chamar(`/controltasks/finished?referenceDate=${refDia(d)}&page=${pagina}&size=200`);
      } catch (e) { break; }
      (r.content || []).forEach((t) => tarefas.push(t));
      ultimo = r.last === true || !(r.content || []).length;
      pagina++;
      await new Promise((f) => setTimeout(f, nexti.PAUSA_MS));
    }
  }
  console.log(`Tarefas devolvidas pela API: ${tarefas.length}`);

  // ---- quais etapas existem? ----
  console.log("");
  console.log("=== ETAPAS QUE APARECEM ===");
  const nomes = new Map();
  tarefas.forEach((t) => (t.taskStages || []).forEach((e) => {
    const n = e.stageName || "(sem nome)";
    nomes.set(n, (nomes.get(n) || 0) + 1);
  }));
  [...nomes].sort((a, b) => b[1] - a[1]).forEach(([n, q]) =>
    console.log(`  ${n.padEnd(26)} ${q}`));

  console.log("");
  console.log("=== QUANTAS ETAPAS POR TAREFA ===");
  const porQtd = new Map();
  tarefas.forEach((t) => {
    const n = (t.taskStages || []).length;
    porQtd.set(n, (porQtd.get(n) || 0) + 1);
  });
  [...porQtd].sort((a, b) => a[0] - b[0]).forEach(([n, q]) =>
    console.log(`  ${String(n).padStart(2)} etapa(s): ${q} tarefa(s)`));

  // ---- classificar como o relatorio ----
  const tem = (t, alvo) => (t.taskStages || []).some((e) =>
    new RegExp(alvo, "i").test(e.stageName || ""));
  const finalizada = tarefas.filter((t) => tem(t, "TASK_FINISH")).length;
  const iniciada = tarefas.filter((t) => !tem(t, "TASK_FINISH") && tem(t, "TASK_START")).length;
  const nemComecou = tarefas.filter((t) => !tem(t, "TASK_FINISH") && !tem(t, "TASK_START")).length;

  console.log("");
  console.log("=== CLASSIFICANDO PELAS ETAPAS ===");
  console.log(`  com TASK_FINISH (finalizada):        ${finalizada}   (relatorio: 422)`);
  console.log(`  so TASK_START (iniciada):            ${iniciada}   (relatorio: 22)`);
  console.log(`  sem nenhuma das duas:                ${nemComecou}   (relatorio: 23 nao realizadas)`);
  console.log(`  TOTAL:                               ${tarefas.length}   (relatorio: 467)`);

  console.log("");
  console.log("=== VEREDITO ===");
  const perto = (a, b) => Math.abs(a - b) <= Math.max(3, b * 0.05);
  if (perto(tarefas.length, 467) && nemComecou > 0) {
    console.log("  A API DEVOLVE TAMBEM AS NAO REALIZADAS.");
    console.log("  O painel pode ser 100% automatico — sem download de relatorio.");
  } else if (perto(tarefas.length, 422)) {
    console.log("  A API devolve SO as finalizadas, como o nome do endpoint diz.");
    console.log("  As nao realizadas nao vem por aqui.");
    console.log("  -> ou perguntamos a Nexti por um endpoint do relatorio,");
    console.log("     ou o painel mede o que da (feito, por quem, onde, quanto tempo)");
    console.log("     e a falta continua so no relatorio.");
  } else {
    console.log(`  Numero inesperado (${tarefas.length}). Nao bate com 422 nem com 467.`);
    console.log("  Vale conferir se o periodo do relatorio e o mesmo desta consulta.");
  }

  console.log("");
  console.log("Fim. Nada foi gravado.");
})().catch((e) => { console.error("ERRO:", e && e.message); process.exit(1); });
