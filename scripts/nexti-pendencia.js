"use strict";

// ============================================================================
// "Checklist em aberto" da tela do Nexti Control e pendencia de verdade?
// ----------------------------------------------------------------------------
//     railway ssh --service core "node scripts/nexti-pendencia.js [dias]"
//
// So le, nao grava nada.
//
// A PERGUNTA
// A tela do Nexti Control tem tres abas: em aberto / finalizado / cancelado.
// Isso bate com o statusId do ChecklistDto (1 NAO RESPONDIDO, 2 RESPONDIDO,
// 3 RESPONDIDO EM OUTRO DISPOSITIVO, 4 CANCELADO). Se "em aberto" significar
// "este posto deve uma visita", o painel ganha a coluna de pendentes de graca,
// vinda da fonte, em vez de calculada por nos a partir da regra de 2x/semana.
//
// A DESCONFIANCA
// Na tela, "em aberto" lista CC - FACILITIES, CC - SEGURANCA, VISITA DE ROTINA
// — ou seja, os MODELOS de checklist, nao ocorrencias por posto e por dia. Se
// for isso, "em aberto" quer dizer "definicao ativa" e nao "visita devendo", e
// a pendencia continua sendo conta nossa.
//
// COMO SEPARAR OS DOIS CASOS
// Consultar /checklists/workplace/{id}/... nos postos que REALMENTE tem visita
// de rotina (a tentativa anterior sorteou postos da lista inteira, quase todos
// parados) e olhar a data:
//   - status 1 com data RECENTE, variando por posto  -> e pendencia de verdade
//   - status 1 sempre com a mesma data velha (2025)  -> e definicao ativa
// ============================================================================

const nexti = require("../core/nexti.js");

const DIAS = Number(process.argv[2] || 15);
const ROTINA = /VISITA\s*DE\s*ROTINA|RELACIONAMENTO/i;

const p2 = (n) => String(n).padStart(2, "0");
const refDia = (d) => `${p2(d.getDate())}${p2(d.getMonth() + 1)}${d.getFullYear()}`;

(async () => {
  if (!nexti.configurado()) { console.log("Credencial nao configurada."); process.exit(1); }

  // ---- 1. quais postos realmente tem os checklists que nos interessam ----
  console.log(`Levantando os postos com visita nos ultimos ${DIAS} dias...`);
  const postos = new Map();     // id -> nome
  const hoje = new Date();
  for (let i = 0; i < DIAS; i++) {
    const d = new Date(hoje); d.setDate(d.getDate() - i);
    try {
      const r = await nexti.chamar(`/controltasks/finished?referenceDate=${refDia(d)}&page=0&size=200`);
      (r.content || []).forEach((t) => {
        const nome = (t.checklist && (t.checklist.name || t.checklist.nome)) || "";
        if (!ROTINA.test(nome) || !t.workplaceId) return;
        postos.set(t.workplaceId,
          (t.workplace && (t.workplace.name || t.workplace.nome)) || ("#" + t.workplaceId));
      });
    } catch (e) { /* dia sem dado ou erro pontual */ }
    await new Promise((f) => setTimeout(f, nexti.PAUSA_MS));
  }
  console.log(`Postos com visita de rotina/relacionamento: ${postos.size}`);
  if (!postos.size) { console.log("Nenhum. Nada a testar."); process.exit(0); }

  // ---- 2. o que /checklists/workplace devolve para ESSES postos ----
  const fim = new Date();
  const inicio = new Date(fim.getTime() - DIAS * 24 * 3600 * 1000);
  inicio.setHours(0, 0, 0, 0);

  console.log("");
  console.log("=== O QUE /checklists/workplace DEVOLVE PARA ELES ===");
  const porStatus = new Map();
  const datasPorStatus = new Map();
  const exemplos = [];
  let consultados = 0, comAlgo = 0, erros = 0;

  for (const [id, nome] of [...postos].slice(0, 40)) {
    consultados++;
    let lista;
    try {
      lista = await nexti.checklistsDoPosto(id, inicio, fim);
    } catch (e) { erros++; continue; }
    if (!lista.length) continue;
    comAlgo++;
    lista.forEach((c) => {
      const rot = nexti.STATUS_ROTULO[c.statusId] || String(c.statusId);
      porStatus.set(rot, (porStatus.get(rot) || 0) + 1);
      const d = nexti.deDataNexti(c.startDateTime);
      if (!datasPorStatus.has(rot)) datasPorStatus.set(rot, new Set());
      datasPorStatus.get(rot).add(d ? d.toLocaleDateString("pt-BR") : c.startDateTime);
      if (exemplos.length < 8) exemplos.push({ posto: nome, c, d });
    });
  }

  console.log(`  Postos consultados: ${consultados}   com algum retorno: ${comAlgo}   erros: ${erros}`);
  console.log("");
  console.log("  Por situacao:");
  [...porStatus].sort((a, b) => b[1] - a[1]).forEach(([rot, q]) => {
    const datas = [...(datasPorStatus.get(rot) || [])];
    console.log(`     ${rot.padEnd(34)} ${String(q).padStart(4)}   datas distintas: ${datas.length}`);
    console.log(`        ${datas.slice(0, 6).join("  ")}${datas.length > 6 ? "  ..." : ""}`);
  });

  console.log("");
  console.log("  Exemplos:");
  exemplos.forEach((e) => {
    console.log(`     ${String(e.posto).slice(0, 44).padEnd(46)} "${String(e.c.name || "(sem nome)").slice(0, 24)}"`);
    console.log(`        situacao: ${nexti.STATUS_ROTULO[e.c.statusId] || e.c.statusId}` +
                `   inicio: ${e.d ? e.d.toLocaleDateString("pt-BR") : e.c.startDateTime}` +
                `   recorrente: ${e.c.recurrent}`);
  });

  // ---- 3. o veredito ----
  console.log("");
  console.log("=== VEREDITO ===");
  const naoResp = datasPorStatus.get("Não respondido");
  if (!naoResp || !naoResp.size) {
    console.log("  Nenhum 'nao respondido' voltou. A API nao esta entregando pendencia");
    console.log("  por este caminho -> a coluna de pendentes fica por nossa conta,");
    console.log("  calculada pela regra de 2x/semana.");
  } else if (naoResp.size <= 3) {
    console.log(`  Os 'nao respondido' tem apenas ${naoResp.size} data(s) distinta(s):`);
    console.log(`     ${[...naoResp].join("  ")}`);
    console.log("  Poucas datas repetidas em muitos postos = DEFINICAO ativa, nao");
    console.log("  ocorrencia devendo. 'Em aberto' na tela quer dizer 'modelo ligado'.");
    console.log("  -> a pendencia continua sendo conta nossa.");
  } else {
    console.log(`  Os 'nao respondido' tem ${naoResp.size} datas distintas, variando por posto.`);
    console.log("  Isso tem cara de ocorrencia de verdade devendo resposta.");
    console.log("  -> vale usar a fonte em vez de calcular.");
  }

  console.log("");
  console.log("Fim. Nada foi gravado.");
})().catch((e) => { console.error("ERRO:", e && e.message); process.exit(1); });
