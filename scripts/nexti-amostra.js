"use strict";

// ============================================================================
// Onde estao os checklists, afinal?
// ----------------------------------------------------------------------------
//     railway ssh --service core "node scripts/nexti-amostra.js [dias] [quantos]"
//
// So le, nao grava nada.
//
// POR QUE ELE EXISTE
// O primeiro diagnostico deixou duas perguntas em aberto:
//
//   1. O posto que sorteamos (#687108 "PADRAO") devolveu ZERO checklists no
//      periodo. Zero pode ser posto parado — ou data no formato errado. Os dois
//      casos sao indistinguiveis olhando um posto so.
//
//   2. Sao 626 "postos", com nomes que parecem cargo por cliente
//      ("11623 - AJUDANTE GERAL", "ABEFARMA ... - LIMPEZA"), nao lugar fisico.
//      Precisamos saber em QUANTOS deles ha checklist de verdade — se forem 20
//      dos 626, o painel sincroniza 20 e nao 626, e tudo muda.
//
// Ele varre uma AMOSTRA espalhada pela lista (nao os primeiros, que sao todos
// do mesmo cliente) e conta o que achou. Com pausa entre as chamadas, como todo
// o resto: ainda nao sabemos o limite do fornecedor.
// ============================================================================

const nexti = require("../core/nexti.js");

const DIAS = Number(process.argv[2] || 7);
const QUANTOS = Number(process.argv[3] || 60);

(async () => {
  if (!nexti.configurado()) {
    console.log("Credencial nao configurada.");
    process.exit(1);
  }

  const fim = new Date();
  const inicio = new Date(fim.getTime() - DIAS * 24 * 3600 * 1000);
  inicio.setHours(0, 0, 0, 0);

  const todos = await nexti.postos();
  const ativos = todos.filter((p) => p.active !== false);
  console.log(`Postos: ${todos.length} (${ativos.length} ativos)`);
  console.log(`Janela: ultimos ${DIAS} dias  (${nexti.paraDataNexti(inicio)} a ${nexti.paraDataNexti(fim)})`);

  // Amostra espalhada: pegar os primeiros da lista mostraria so um cliente.
  const passo = Math.max(1, Math.floor(ativos.length / QUANTOS));
  const amostra = ativos.filter((_, i) => i % passo === 0).slice(0, QUANTOS);
  console.log(`Amostra: ${amostra.length} postos, 1 a cada ${passo} da lista`);
  console.log("");

  let comChecklist = 0, totalChecklists = 0, datasIlegiveis = 0;
  const achados = [];

  for (const p of amostra) {
    let lista;
    try {
      lista = await nexti.checklistsDoPosto(p.id, inicio, fim);
    } catch (e) {
      console.log(`  #${p.id} ERRO: ${e.message} (causa: ${e.causa || "?"})`);
      if (e.causa === "limite") {
        console.log("  O Nexti pediu para parar. Interrompendo a amostra aqui.");
        break;
      }
      continue;
    }
    if (lista.length) {
      comChecklist++;
      totalChecklists += lista.length;
      datasIlegiveis += lista.filter((c) => !nexti.deDataNexti(c.startDateTime)).length;
      if (achados.length < 6) achados.push({ posto: p, lista });
    }
  }

  console.log("=== RESULTADO ===");
  console.log(`  Postos da amostra com pelo menos um checklist: ${comChecklist} de ${amostra.length}`);
  console.log(`  Checklists somados na amostra: ${totalChecklists}`);

  if (comChecklist === 0) {
    console.log("");
    console.log("  NENHUM checklist em nenhum posto da amostra.");
    console.log("  Duas leituras possiveis, e elas pedem acoes diferentes:");
    console.log("    a) o formato da data esta errado -> trocar paraDataNexti() para ISO e repetir");
    console.log("    b) os checklists nao estao nesses 'postos' -> perguntar ao Nexti onde vivem");
    console.log("  Para separar: abra o Nexti na tela e veja um checklist recente; anote o");
    console.log("  posto e a data, e rodamos apontando para ele.");
    process.exit(0);
  }

  console.log("");
  console.log("=== O FORMATO DA DATA ===");
  if (datasIlegiveis) {
    console.log(`  *** ${datasIlegiveis} datas NAO foram lidas — o formato nao e ddMMyyyyHHmmss.`);
  } else {
    console.log("  Todas as datas lidas. ddMMyyyyHHmmss confirmado contra dados reais.");
  }

  console.log("");
  console.log("=== AMOSTRA DO QUE HA LA DENTRO ===");
  achados.forEach(({ posto, lista }) => {
    console.log("");
    console.log(`  Posto #${posto.id}  ${posto.name || ""}`);
    console.log(`    ${lista.length} checklist(s) no periodo`);
    lista.slice(0, 4).forEach((c) => {
      const d = nexti.deDataNexti(c.startDateTime);
      console.log(`      "${c.name}"  |  ${d ? d.toLocaleString("pt-BR") : c.startDateTime}` +
                  `  |  ${nexti.STATUS_ROTULO[c.statusId] || c.statusId}`);
    });
  });

  console.log("");
  console.log("=== O QUE ISSO DIZ DO PAINEL ===");
  const proporcao = comChecklist / amostra.length;
  const estimados = Math.round(ativos.length * proporcao);
  console.log(`  Se a amostra representa o todo, ~${estimados} dos ${ativos.length} postos ativos`);
  console.log(`  tem checklist. Sincronizar so esses, e nao os ${todos.length}, muda o custo por ${
    Math.max(1, Math.round(todos.length / Math.max(1, estimados)))}x.`);

  console.log("");
  console.log("Fim. Nada foi gravado.");
})().catch((e) => { console.error("ERRO:", e && e.message); process.exit(1); });
