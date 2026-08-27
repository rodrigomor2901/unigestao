"use strict";

// ============================================================================
// As tarefas do Nexti Control — e onde a operacao de verdade vive
// ----------------------------------------------------------------------------
//     railway ssh --service core "node scripts/nexti-controltasks.js [diasAtras]"
//
// So le, nao grava nada.
//
// POR QUE ELE EXISTE
// Fomos por /checklists/workplace/... e achamos quase nada: 5 registros em 60
// postos, todos de julho/2025, nenhum respondido. Mas o Rodrigo usa o checklist
// todo dia — ou seja, estavamos procurando no lugar errado.
//
// /controltasks/finished e de outra etiqueta da API ("Nexti Control", que e
// como o fornecedor chama o modulo de checklist) e tem duas diferencas que
// mudam tudo:
//
//   - NAO exige posto. Uma chamada por dia devolve as tarefas do dia inteiro,
//     em vez de 626 chamadas.
//   - o registro traz `workplace`, `userAccount` (o responsavel) e o checklist
//     juntos — inclusive o agrupamento por pessoa, que as Areas nao dao porque
//     estao vazias.
//
// O QUE ELE DESCOBRE
// A documentacao nao diz o formato de `referenceDate`. O resto da API usa
// ddMMyyyyHHmmss, mas "data de referencia" de um dia pode ser so ddMMyyyy ou
// ISO. Ele tenta as variantes, uma vez cada, e mostra qual respondeu.
// ============================================================================

const nexti = require("../core/nexti.js");

const DIAS_ATRAS = Number(process.argv[2] || 0);

const p2 = (n) => String(n).padStart(2, "0");

function formatos(d) {
  const dd = p2(d.getDate()), mm = p2(d.getMonth() + 1), yyyy = d.getFullYear();
  return [
    ["ddMMyyyyHHmmss", `${dd}${mm}${yyyy}000000`],
    ["ddMMyyyy", `${dd}${mm}${yyyy}`],
    ["yyyy-MM-dd", `${yyyy}-${mm}-${dd}`],
    ["dd/MM/yyyy", `${dd}/${mm}/${yyyy}`],
    ["ISO", d.toISOString()],
  ];
}

(async () => {
  if (!nexti.configurado()) { console.log("Credencial nao configurada."); process.exit(1); }

  const dia = new Date();
  dia.setDate(dia.getDate() - DIAS_ATRAS);
  dia.setHours(0, 0, 0, 0);
  console.log(`Dia de referencia: ${dia.toLocaleDateString("pt-BR")}` +
              (DIAS_ATRAS ? `  (${DIAS_ATRAS} dia(s) atras)` : "  (hoje)"));
  console.log("");

  let vencedor = null;
  for (const [nome, valor] of formatos(dia)) {
    let d;
    try {
      d = await nexti.chamar(`/controltasks/finished?referenceDate=${encodeURIComponent(valor)}&page=0&size=200`);
    } catch (e) {
      console.log(`  ${nome.padEnd(15)} "${valor}"  ->  ${e.message}`);
      continue;
    }
    const n = (d && d.content && d.content.length) || 0;
    const total = (d && d.totalElements) || 0;
    console.log(`  ${nome.padEnd(15)} "${valor}"  ->  ${n} nesta pagina, ${total} no total`);
    if (n > 0 && !vencedor) vencedor = { nome, valor, dados: d };
  }

  if (!vencedor) {
    console.log("");
    console.log("Nenhum formato devolveu tarefa neste dia.");
    console.log("Pode ser dia sem movimento — rodar com um dia util:");
    console.log("  node scripts/nexti-controltasks.js 1     (ontem)");
    process.exit(0);
  }

  console.log("");
  console.log(`=== FORMATO QUE FUNCIONA: ${vencedor.nome} ===`);
  const tarefas = vencedor.dados.content;
  console.log(`Tarefas no dia: ${vencedor.dados.totalElements}`);

  console.log("");
  console.log("=== AMOSTRA ===");
  tarefas.slice(0, 5).forEach((t) => {
    const posto = t.workplace || {};
    const usuario = t.userAccount || {};
    const chk = t.checklist || {};
    console.log("");
    console.log(`  Tarefa #${t.id}   registrada em ${t.registerDate}`);
    console.log(`    posto:       #${t.workplaceId} ${posto.name || posto.nome || "(sem nome)"}`);
    console.log(`    responsavel: #${t.userAccountId} ${usuario.name || usuario.nome ||
                                                        usuario.login || "(sem nome)"}`);
    console.log(`    checklist:   ${chk.name || chk.nome || "(sem nome)"}` +
                (chk.id ? `  (#${chk.id})` : ""));
    const etapas = t.taskStages || [];
    console.log(`    etapas:      ${etapas.length}`);
    etapas.slice(0, 3).forEach((e) => {
      const rot = e.name || e.nome || e.stage || JSON.stringify(e).slice(0, 70);
      console.log(`       - ${String(rot).slice(0, 70)}`);
    });
  });

  // As duas perguntas que decidem o painel.
  console.log("");
  console.log("=== DA PARA AGRUPAR? ===");
  const porResponsavel = new Map();
  const porPosto = new Map();
  tarefas.forEach((t) => {
    const u = t.userAccount || {};
    const nome = u.name || u.nome || u.login || ("#" + t.userAccountId);
    porResponsavel.set(nome, (porResponsavel.get(nome) || 0) + 1);
    const w = t.workplace || {};
    const pn = w.name || w.nome || ("#" + t.workplaceId);
    porPosto.set(pn, (porPosto.get(pn) || 0) + 1);
  });
  console.log(`  Responsaveis distintos nesta pagina: ${porResponsavel.size}`);
  [...porResponsavel].slice(0, 10).forEach(([n, q]) => console.log(`     ${n}  —  ${q} tarefa(s)`));
  console.log(`  Postos distintos nesta pagina: ${porPosto.size}`);
  [...porPosto].slice(0, 6).forEach(([n, q]) => console.log(`     ${String(n).slice(0, 60)}  —  ${q}`));

  console.log("");
  console.log("Fim. Nada foi gravado.");
})().catch((e) => { console.error("ERRO:", e && e.message); process.exit(1); });
