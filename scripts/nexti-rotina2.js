"use strict";

// ============================================================================
// Duas duvidas que a apuracao anterior levantou
// ----------------------------------------------------------------------------
//     railway ssh --service core "node scripts/nexti-rotina2.js [dias]"
//
// So le, nao grava nada.
//
// DUVIDA 1 — 37% das tarefas vem com checklist "(sem nome)".
// Se parte delas for VISITA DE ROTINA, o painel vai subcontar e cobrar visita
// que na verdade foi feita, que e o pior erro que ele pode cometer. Mas talvez
// o nome so falte no JSON e o `checklist.id` esteja la. Se estiver, da para
// montar um dicionario id -> nome com as tarefas que TEM nome e preencher o
// resto. Este script mede quanto isso recupera.
//
// DUVIDA 2 — a regra de 2 visitas por semana aparece cumprida em 3% dos casos.
// Duas leituras, muito diferentes:
//   a) a regra nao esta sendo cumprida (e o painel vai mostrar isso)
//   b) a regra nao e por POSTO, e sim por CLIENTE — o mesmo cliente aparece
//      varias vezes na lista de postos (PORTARIA, VIGILANTE, LIMPEZA sao
//      postos separados do mesmo lugar). Agrupando por cliente, a conta muda.
// O script calcula a aderencia dos dois jeitos, lado a lado.
// ============================================================================

const nexti = require("../core/nexti.js");

const DIAS = Number(process.argv[2] || 30);
const ROTINA = /VISITA\s*DE\s*ROTINA/i;

const p2 = (n) => String(n).padStart(2, "0");
const refDia = (d) => `${p2(d.getDate())}${p2(d.getMonth() + 1)}${d.getFullYear()}`;
const diaISO = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const segundaDe = (iso) => {
  const x = new Date(iso + "T00:00:00");
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return diaISO(x);
};

const nomeChecklist = (t) => (t.checklist && (t.checklist.name || t.checklist.nome)) || "";
const idChecklist = (t) => (t.checklist && t.checklist.id) || null;
const nomePosto = (t) => (t.workplace && (t.workplace.name || t.workplace.nome)) || ("#" + t.workplaceId);

// O nome do posto e "CLIENTE - CARGO" ou "CLIENTE (Privado) - CARGO".
// O cliente e o que vem antes do ultimo " - ".
function clienteDoPosto(nome) {
  const s = String(nome);
  const i = s.lastIndexOf(" - ");
  return (i > 0 ? s.slice(0, i) : s).replace(/\s*\(Privado\)\s*$/i, "").trim();
}

(async () => {
  if (!nexti.configurado()) { console.log("Credencial nao configurada."); process.exit(1); }

  const tarefas = [];
  const hoje = new Date();
  for (let i = 0; i < DIAS; i++) {
    const d = new Date(hoje); d.setDate(d.getDate() - i);
    let pagina = 0, ultimo = false;
    while (!ultimo && pagina < 20) {
      let r;
      try {
        r = await nexti.chamar(`/controltasks/finished?referenceDate=${refDia(d)}&page=${pagina}&size=200`);
      } catch (e) { break; }
      (r.content || []).forEach((t) => tarefas.push({ ...t, _dia: diaISO(d) }));
      ultimo = r.last === true || !(r.content || []).length;
      pagina++;
      await new Promise((f) => setTimeout(f, nexti.PAUSA_MS));
    }
  }
  console.log(`Tarefas em ${DIAS} dias: ${tarefas.length}`);

  // ---- duvida 1 ----
  console.log("");
  console.log("=== 1. DA PARA RECUPERAR OS '(SEM NOME)' PELO ID? ===");
  const semNome = tarefas.filter((t) => !nomeChecklist(t));
  const comId = semNome.filter((t) => idChecklist(t));
  console.log(`  Sem nome: ${semNome.length}   destas, com id de checklist: ${comId.length}`);

  const dicionario = new Map();
  tarefas.forEach((t) => {
    const n = nomeChecklist(t), id = idChecklist(t);
    if (n && id) dicionario.set(id, n);
  });
  console.log(`  Dicionario id->nome montado com ${dicionario.size} checklist(s) nomeado(s)`);

  const recuperadas = semNome.filter((t) => dicionario.has(idChecklist(t)));
  console.log(`  Recuperaveis pelo dicionario: ${recuperadas.length} de ${semNome.length}`);
  if (recuperadas.length) {
    const quais = new Map();
    recuperadas.forEach((t) => {
      const n = dicionario.get(idChecklist(t));
      quais.set(n, (quais.get(n) || 0) + 1);
    });
    console.log("  Viraram:");
    [...quais].sort((a, b) => b[1] - a[1]).forEach(([n, q]) => console.log(`     ${n.padEnd(34)} ${q}`));
  }
  const irrecuperaveis = semNome.length - recuperadas.length;
  console.log(`  Continuam sem identificacao: ${irrecuperaveis}`);
  if (irrecuperaveis) {
    const semIdNenhum = semNome.filter((t) => !idChecklist(t)).length;
    console.log(`     (destas, ${semIdNenhum} nao tem nem id — nao ha o que fazer pela API)`);
  }

  // ---- duvida 2 ----
  const nomeFinal = (t) => nomeChecklist(t) || dicionario.get(idChecklist(t)) || "";
  const rotina = tarefas.filter((t) => ROTINA.test(nomeFinal(t)));
  console.log("");
  console.log("=== 2. A REGRA DE 2x/SEMANA: POR POSTO OU POR CLIENTE? ===");
  console.log(`  Visitas de rotina no periodo: ${rotina.length}` +
              `  (${rotina.length - tarefas.filter((t) => ROTINA.test(nomeChecklist(t))).length} vieram do dicionario)`);

  function aderencia(chaveDe, rotulo) {
    const porChaveSemana = new Map();
    rotina.forEach((t) => {
      const k = chaveDe(t) + "||" + segundaDe(t._dia);
      porChaveSemana.set(k, (porChaveSemana.get(k) || 0) + 1);
    });
    const c = [...porChaveSemana.values()];
    const dois = c.filter((n) => n >= 2).length;
    const chaves = new Set(rotina.map(chaveDe));
    console.log("");
    console.log(`  --- por ${rotulo} ---`);
    console.log(`    ${rotulo}s distintos: ${chaves.size}`);
    console.log(`    pares ${rotulo}+semana com visita: ${c.length}`);
    console.log(`    com 2 ou mais: ${dois} (${Math.round(100 * dois / Math.max(1, c.length))}%)`);
    console.log(`    com apenas 1:  ${c.filter((n) => n === 1).length}`);
    const media = c.reduce((a, b) => a + b, 0) / Math.max(1, c.length);
    console.log(`    media de visitas por semana: ${media.toFixed(2)}`);
  }
  aderencia(nomePosto, "posto");
  aderencia((t) => clienteDoPosto(nomePosto(t)), "cliente");

  console.log("");
  console.log("  Amostra de como o nome do posto vira cliente:");
  [...new Set(rotina.map(nomePosto))].slice(0, 6).forEach((p) =>
    console.log(`     "${String(p).slice(0, 52)}"  ->  "${clienteDoPosto(p)}"`));

  console.log("");
  console.log("Fim. Nada foi gravado.");
})().catch((e) => { console.error("ERRO:", e && e.message); process.exit(1); });
