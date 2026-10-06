// A agenda de visitas: o PREVISTO que a API do Nexti nao entrega.
//
// POR QUE ESTE TESTE EXISTE
// Este painel diz, com nome e sobrenome, que fulano deixou de visitar um posto.
// O erro caro aqui nao e a tela ficar feia — e acusar quem trabalhou. Tres
// jeitos de isso acontecer, todos ja vistos nos dados reais de 06/10/2026:
//
//   1. o relatorio CORTA nomes longos de posto ("...PAINEIRAS (VIGI"), enquanto
//      a API devolve o nome inteiro. Se o casamento for por igualdade, a visita
//      feita nao encontra o agendamento e vira falta;
//   2. a visita de quinta feita na sexta cumpriu o roteiro da semana. Cobrar o
//      dia exato transformaria remarcacao em falta;
//   3. a semana corrente ainda nao acabou: visita que ainda vai acontecer nao
//      pode entrar como perdida.
//
// Roda sozinho, sem banco e sem servidor:  node tests/agenda.test.js
"use strict";

const agenda = require("../core/visitas-previstas.js");
const { lerPlanilha } = require("../core/planilha.js");
// A planilha de mentira mora a parte: o teste da rota usa a mesma, e nenhum
// arquivo do cliente entra no repositorio.
const { planilhaDe, CABECALHO, linhaDe } = require("./planilha-de-mentira.js");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

(async () => {
  console.log("\n=== LER A PLANILHA DO NEXTI ===");
  {
    const buf = planilhaDe([
      ["Relação de visitas  -   GRUPO SETER"],
      [],
      CABECALHO,
      linhaDe({ supervisor: "ANA PAULA TESTE", posto: "CONDOMINIO ALFA - PORTARIA",
                agendada: "01/09/2026", visita: "01/09/2026", status: "Tarefa finalizada",
                cliente: "CONDOMINIO ALFA" }),
    ]);
    const visitas = agenda.lerRelatorio(lerPlanilha(buf));
    ok(visitas.length === 1, "le a linha de visita, pulando titulo e linha em branco");
    ok(visitas[0].supervisor === "ANA PAULA TESTE", "com o supervisor");
    ok(visitas[0].agendada === "2026-09-01", "e a data vira ano-mes-dia, para o banco entender");
    ok(visitas[0].status === "Tarefa finalizada", "e o status, que e o que diz se foi feita");
  }
  {
    // O mesmo conteudo, do jeito que o Excel costuma gravar: texto em tabela
    // separada e entradas comprimidas.
    const buf = planilhaDe([CABECALHO, linhaDe({ supervisor: "ANA", posto: "X - PORTARIA", agendada: "02/09/2026" })],
                           { compartilhadas: true, comprimir: true });
    ok(agenda.lerRelatorio(lerPlanilha(buf)).length === 1,
       "le tambem planilha comprimida e com tabela de textos");
  }
  {
    let erro = null;
    try { agenda.lerRelatorio([["qualquer", "coisa"]]); } catch (e) { erro = e; }
    ok(erro && /Relação de visitas/.test(erro.message),
       "planilha errada avisa o que era para subir, em vez de dar erro tecnico");
  }

  console.log("\n=== O NOME CORTADO DO RELATORIO AINDA E O MESMO POSTO ===");
  // Visto nos dados reais: o export corta o nome, a API devolve inteiro.
  ok(agenda.mesmoNome("ASSOCIAÇÃO DOS PROPRIETARIOS DO LOTEAMENTO PAINEIRAS (VIGI",
                      "ASSOCIACAO DOS PROPRIETARIOS DO LOTEAMENTO PAINEIRAS (VIGILANTE)"),
     "nome cortado casa com o nome inteiro  <-- senao a visita feita vira falta");
  ok(agenda.mesmoNome("Condomínio Alfa - Portaria", "CONDOMINIO ALFA - PORTARIA"),
     "acento e caixa nao separam o mesmo posto");
  ok(!agenda.mesmoNome("CONDOMINIO ALFA - PORTARIA", "CONDOMINIO ALFA - LIMPEZA"),
     "mas dois servicos do mesmo cliente continuam sendo postos diferentes");
  ok(!agenda.mesmoNome("ALFA", "ALFA - PORTARIA"),
     "e um pedaco curto nao casa com qualquer coisa que comece igual");

  console.log("\n=== O PADRAO SEMANAL ===");
  {
    const visitas = [
      // mesma quinta, tres linhas: rotina + duas solicitacoes no mesmo posto
      { supervisor: "ANA", posto: "ALFA - PORTARIA", agendada: "2026-09-03", checklist: "VISITA DE ROTINA" },
      { supervisor: "ANA", posto: "ALFA - PORTARIA", agendada: "2026-09-03", checklist: "CC - SOLICITACAO" },
      { supervisor: "ANA", posto: "ALFA - PORTARIA", agendada: "2026-09-03", checklist: "CC - SOLICITACAO" },
      // a semana seguinte, mesmo dia da semana
      { supervisor: "ANA", posto: "ALFA - PORTARIA", agendada: "2026-09-10", checklist: "VISITA DE ROTINA" },
      // outro posto, outro dia
      { supervisor: "ANA", posto: "BETA - LIMPEZA", agendada: "2026-09-07", checklist: "VISITA DE ROTINA" },
    ];
    const padrao = agenda.padraoSemanal(visitas);
    ok(padrao.length === 1, "tres linhas no mesmo posto e dia viram UM ponto do roteiro");
    ok(padrao[0].posto === "ALFA - PORTARIA" && padrao[0].diaSemana === 4,
       "o que se repetiu em duas semanas virou roteiro: quinta-feira no Alfa");
    ok(!padrao.some((p) => p.posto === "BETA - LIMPEZA"),
       "e a visita de uma vez so NAO vira roteiro  <-- senao 'Não se repete' viraria cobranca semanal");

    // Com a regra frouxa, tudo vira obrigacao: nos dados reais de 06/10/2026
    // isso dava 501 pontos por semana onde so 10 se repetiam.
    ok(agenda.padraoSemanal(visitas, 1).length === 2, "a exigencia de repeticao da para afrouxar, se um dia precisar");

    const outubro = agenda.previstasDoMes(padrao, 2026, 10);
    const quintas = outubro.filter((p) => p.posto === "ALFA - PORTARIA");
    ok(quintas.length === 5, "o padrao se repete no mes seguinte: outubro/2026 tem 5 quintas");
    ok(quintas.every((p) => new Date(p.data + "T12:00:00").getDay() === 4), "todas caem na quinta");
  }

  console.log("\n=== CRUZAR SEM ACUSAR QUEM TRABALHOU ===");
  {
    const previstas = [
      { supervisor: "ANA", posto: "ALFA - PORTARIA", cliente: "ALFA", data: "2026-09-03" },   // quinta
      { supervisor: "ANA", posto: "BETA - LIMPEZA", cliente: "BETA", data: "2026-09-07" },    // segunda
      { supervisor: "ANA", posto: "GAMA - RONDA", cliente: "GAMA", data: "2026-09-10" },      // quinta seguinte
    ];
    const realizadas = [
      // feita na SEXTA, e nao na quinta combinada
      { supervisor: "ANA", posto: "ALFA - PORTARIA", dia: "2026-09-04" },
      // feita no dia certo, com o nome do posto cortado no relatorio
      { supervisor: "ANA", posto: "BETA - LIMPEZA DE AREAS COMUNS", dia: "2026-09-07" },
    ];
    const r = agenda.cruzar(previstas, realizadas, "2026-09-30");
    const alfa = r.linhas.find((l) => l.posto === "ALFA - PORTARIA");
    const beta = r.linhas.find((l) => l.posto === "BETA - LIMPEZA");
    const gama = r.linhas.find((l) => l.posto === "GAMA - RONDA");

    ok(alfa.feita && !alfa.noDiaCombinado,
       "visita de quinta feita na sexta CONTA  <-- cobrar o dia viraria remarcacao em falta");
    ok(beta.feita, "nome cortado no relatorio nao impede o encontro");
    ok(!gama.feita, "o que nao foi feito aparece como falta");

    const resumo = agenda.porSupervisor(r);
    ok(resumo.length === 1 && resumo[0].previstas === 3 && resumo[0].feitas === 2,
       "o resumo conta 3 previstas e 2 feitas");
    ok(resumo[0].foraDoDia === 1, "e diz quantas sairam do dia combinado");
    ok(resumo[0].aderencia === 67, "aderencia em porcentagem");
    ok(resumo[0].postos.length === 1 && resumo[0].postos[0].posto === "GAMA - RONDA",
       "com a lista do que faltou, para a pessoa saber onde ir");
  }
  {
    // A semana corrente nao vira cobranca.
    const previstas = [
      { supervisor: "ANA", posto: "ALFA", data: "2026-09-03" },
      { supervisor: "ANA", posto: "ALFA", data: "2026-09-24" },   // semana de hoje
    ];
    const r = agenda.cruzar(previstas, [], "2026-09-24");
    const resumo = agenda.porSupervisor(r);
    ok(resumo[0].previstas === 1,
       "a semana que ainda esta correndo fica de fora da conta  <-- visita de amanha nao e falta");
  }
  {
    // Duas visitas ao mesmo posto na mesma semana nao sao duas cobrancas.
    const previstas = [
      { supervisor: "ANA", posto: "ALFA", data: "2026-09-01" },
      { supervisor: "ANA", posto: "ALFA", data: "2026-09-03" },
    ];
    const r = agenda.cruzar(previstas, [{ supervisor: "ANA", posto: "ALFA", dia: "2026-09-02" }], "2026-09-30");
    const resumo = agenda.porSupervisor(r);
    ok(resumo[0].previstas === 1 && resumo[0].feitas === 1,
       "duas no mesmo posto e semana contam como uma — o roteiro e semanal");
  }
  {
    // Visita que nao estava no roteiro nao vira falta de ninguem.
    const r = agenda.cruzar(
      [{ supervisor: "ANA", posto: "ALFA", data: "2026-09-03" }],
      [{ supervisor: "ANA", posto: "ALFA", dia: "2026-09-03" },
       { supervisor: "ANA", posto: "POSTO QUE NAO ESTA NO ROTEIRO", dia: "2026-09-03" }],
      "2026-09-30");
    ok(r.foraDoRoteiro === 1, "visita fora do roteiro e contada a parte, e nao some");
    ok(agenda.porSupervisor(r)[0].faltaram === 0, "e nao conta como falta");
  }

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exitCode = falhas === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
