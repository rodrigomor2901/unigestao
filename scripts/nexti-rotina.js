"use strict";

// ============================================================================
// Os dois checklists que importam, ao longo de um periodo
// ----------------------------------------------------------------------------
//     railway ssh --service core "node scripts/nexti-rotina.js [dias]"
//
// So le, nao grava nada.
//
// POR QUE ELE EXISTE
// O painel vai cobrir SO dois checklists:
//     VISITA DE ROTINA        — esperado 2x por semana
//     RELACIONAMENTO|CLIENTE  — esperado 1x por mes
//
// Antes de escrever a agregacao, tres coisas precisam ser fato e nao suposicao:
//
//   1. O NOME DO CHECKLIST E CONFIAVEL? Na primeira amostra, 2 de 5 tarefas
//      vieram com checklist "(sem nome)". Se o nome faltar com frequencia, nao
//      da para filtrar por ele — e o painel inteiro depende desse filtro.
//
//   2. O LOCAL VISITADO VEM MESMO? O export do Nexti nao tem (a coluna "Posto"
//      la e a lotacao do supervisor). A promessa do painel e justamente
//      mostrar a cobertura por cliente, entao o `workplace` da tarefa precisa
//      estar preenchido.
//
//   3. COMO E O ROTEIRO DE VERDADE? Quantos locais distintos, quantas visitas
//      por local por semana. E o que diz se a regra de 2x/semana e alcancavel
//      e quantos locais entram na conta.
// ============================================================================

const nexti = require("../core/nexti.js");

const DIAS = Number(process.argv[2] || 30);

const ROTINA = /VISITA\s*DE\s*ROTINA/i;
const RELACIONAMENTO = /RELACIONAMENTO/i;

const p2 = (n) => String(n).padStart(2, "0");
const refDia = (d) => `${p2(d.getDate())}${p2(d.getMonth() + 1)}${d.getFullYear()}`;
const diaISO = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const segundaDe = (d) => {
  const x = new Date(d); x.setHours(0, 0, 0, 0);
  x.setDate(x.getDate() - ((x.getDay() + 6) % 7));
  return diaISO(x);
};

(async () => {
  if (!nexti.configurado()) { console.log("Credencial nao configurada."); process.exit(1); }

  const tarefas = [];
  const hoje = new Date();
  console.log(`Buscando ${DIAS} dias, um por chamada...`);
  for (let i = 0; i < DIAS; i++) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - i);
    let pagina = 0, ultimo = false;
    while (!ultimo && pagina < 20) {
      let r;
      try {
        r = await nexti.chamar(
          `/controltasks/finished?referenceDate=${refDia(d)}&page=${pagina}&size=200`);
      } catch (e) {
        console.log(`  ${diaISO(d)}: ${e.message}`);
        break;
      }
      (r.content || []).forEach((t) => tarefas.push({ ...t, _dia: diaISO(d) }));
      ultimo = r.last === true || !(r.content || []).length;
      pagina++;
      await new Promise((f) => setTimeout(f, nexti.PAUSA_MS));
    }
  }
  console.log(`Tarefas no periodo: ${tarefas.length}`);

  // ---- 1. o nome do checklist e confiavel? ----
  console.log("");
  console.log("=== 1. O NOME DO CHECKLIST VEM? ===");
  const semNome = tarefas.filter((t) => !(t.checklist && (t.checklist.name || t.checklist.nome))).length;
  console.log(`  Sem nome: ${semNome} de ${tarefas.length}` +
              (semNome ? `  (${Math.round(100 * semNome / tarefas.length)}%)` : ""));
  const nomes = new Map();
  tarefas.forEach((t) => {
    const n = (t.checklist && (t.checklist.name || t.checklist.nome)) || "(sem nome)";
    nomes.set(n, (nomes.get(n) || 0) + 1);
  });
  console.log("  Nomes encontrados:");
  [...nomes].sort((a, b) => b[1] - a[1]).forEach(([n, q]) => console.log(`     ${String(n).padEnd(34)} ${q}`));

  // ---- 2. o local visitado vem? ----
  console.log("");
  console.log("=== 2. O LOCAL VISITADO VEM? ===");
  const semPosto = tarefas.filter((t) => !t.workplaceId).length;
  console.log(`  Sem posto: ${semPosto} de ${tarefas.length}`);
  const semNomeDoPosto = tarefas.filter((t) => t.workplaceId &&
    !(t.workplace && (t.workplace.name || t.workplace.nome))).length;
  console.log(`  Com id de posto mas sem nome: ${semNomeDoPosto}`);

  // ---- 3. o roteiro ----
  const alvo = tarefas.filter((t) => {
    const n = (t.checklist && (t.checklist.name || t.checklist.nome)) || "";
    return ROTINA.test(n) || RELACIONAMENTO.test(n);
  });
  console.log("");
  console.log("=== 3. OS DOIS CHECKLISTS DO PAINEL ===");
  console.log(`  Tarefas de VISITA DE ROTINA ou RELACIONAMENTO: ${alvo.length}`);

  const nomeDoPosto = (t) => (t.workplace && (t.workplace.name || t.workplace.nome)) ||
                             ("#" + t.workplaceId);
  const nomeDeQuem = (t) => (t.userAccount && (t.userAccount.name || t.userAccount.nome ||
                             t.userAccount.login)) || ("#" + t.userAccountId);

  ["VISITA DE ROTINA", "RELACIONAMENTO"].forEach((rotulo) => {
    const re = rotulo === "VISITA DE ROTINA" ? ROTINA : RELACIONAMENTO;
    const lista = alvo.filter((t) =>
      re.test((t.checklist && (t.checklist.name || t.checklist.nome)) || ""));
    console.log("");
    console.log(`  --- ${rotulo}: ${lista.length} tarefa(s) ---`);
    if (!lista.length) return;
    const locais = new Set(lista.map(nomeDoPosto));
    const quem = new Set(lista.map(nomeDeQuem));
    console.log(`    Locais distintos: ${locais.size}   Supervisores: ${quem.size}`);

    const porSup = new Map();
    lista.forEach((t) => porSup.set(nomeDeQuem(t), (porSup.get(nomeDeQuem(t)) || 0) + 1));
    console.log("    Por supervisor:");
    [...porSup].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .forEach(([n, q]) => console.log(`       ${String(n).slice(0, 40).padEnd(42)} ${q}`));

    if (rotulo === "VISITA DE ROTINA") {
      // A regra: 2 por semana, por local.
      const porLocalSemana = new Map();
      lista.forEach((t) => {
        const k = nomeDoPosto(t) + "||" + segundaDe(new Date(t._dia));
        porLocalSemana.set(k, (porLocalSemana.get(k) || 0) + 1);
      });
      const c = [...porLocalSemana.values()];
      const doisOuMais = c.filter((n) => n >= 2).length;
      console.log("");
      console.log("    A REGRA DE 2 POR SEMANA:");
      console.log(`      pares local+semana: ${c.length}`);
      console.log(`      com 2 ou mais: ${doisOuMais} (${
        Math.round(100 * doisOuMais / Math.max(1, c.length))}%)`);
      console.log(`      com apenas 1:  ${c.filter((n) => n === 1).length}`);

      console.log("");
      console.log("    LOCAIS HA MAIS TEMPO SEM VISITA DE ROTINA:");
      const ultima = new Map();
      lista.forEach((t) => {
        const p = nomeDoPosto(t);
        if (!ultima.has(p) || t._dia > ultima.get(p)) ultima.set(p, t._dia);
      });
      [...ultima].sort((a, b) => (a[1] < b[1] ? -1 : 1)).slice(0, 8).forEach(([p, d]) => {
        const dias = Math.round((Date.now() - new Date(d).getTime()) / 86400000);
        console.log(`      ${String(dias).padStart(3)} dias  ${String(p).slice(0, 58)}`);
      });
    }
  });

  console.log("");
  console.log("Fim. Nada foi gravado.");
})().catch((e) => { console.error("ERRO:", e && e.message); process.exit(1); });
