"use strict";

// ============================================================================
// AGENDA DE VISITAS — o PREVISTO, que a API do Nexti nao entrega
// ----------------------------------------------------------------------------
// O painel de checklists mostra o que FOI feito: vem da API do Nexti
// (core/nexti.js). O que estava previsto nao vem de la — procurei endpoint de
// roteiro e de agendamento, inclusive pelo id que aparece na tela do Nexti
// (18073), e nao existe: a API tem 386 enderecos e o roteiro nao e um deles
// (apurado em 06/10/2026). O que a Nexti chama de `schedules` e escala de
// trabalho ("das 06:00 as 15:48, 5X2"), nao roteiro de visita.
//
// O previsto entao entra por onde existe: o relatorio "Relacao de visitas"
// (Nexti Control > Relatorio), exportado em planilha. Alguem sobe o arquivo uma
// vez; ele vira a AGENDA PADRAO e vale mes a mes ate subirem outro.
//
// POR QUE PADRAO SEMANAL, E NAO AS DATAS DO ARQUIVO
// O arquivo cobre o periodo que a pessoa pediu na exportacao. Usar as datas
// dele direto faria o painel ficar cego no mes seguinte. O roteiro do Nexti e
// semanal ("Semanal: cada quinta-feira"), entao o que se guarda e o PADRAO —
// que supervisor visita que posto, em que dia da semana — e ele se repete.
//
// DUAS DECISOES QUE EVITAM ACUSAR GENTE A TOA
//
// 1. A conta e por SEMANA, nao por dia. Visita de quinta feita na sexta cumpriu
//    o roteiro da semana; cobrar o dia exato transformaria remarcacao em falta.
//    A tela mostra separado o que saiu do dia combinado.
// 2. Semana corrente nao vira cobranca. Ate a semana terminar, visita que ainda
//    nao aconteceu nao e visita perdida.
// ============================================================================

const db = require("./db");
const { lerPlanilha } = require("./planilha");

// O relatorio corta nomes longos de posto ("...PAINEIRAS (VIGI"), enquanto a
// API devolve o nome inteiro. Por isso o casamento aceita prefixo — mas so a
// partir de um tamanho que nao confunda dois postos do mesmo cliente.
const PREFIXO_MINIMO = 14;

const SEM_ACENTO = (s) => String(s || "").normalize("NFD").replace(/[̀-ͯ]/g, "");
const normalizar = (s) => SEM_ACENTO(s).toUpperCase().replace(/\s+/g, " ").trim();

/** Dois nomes sao o mesmo lugar/pessoa? Aceita o corte do relatorio. */
function mesmoNome(a, b) {
  const x = normalizar(a);
  const y = normalizar(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const curto = x.length < y.length ? x : y;
  const longo = x.length < y.length ? y : x;
  return curto.length >= PREFIXO_MINIMO && longo.startsWith(curto);
}

const p2 = (n) => String(n).padStart(2, "0");
const diaISO = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

/** "01/09/2026" -> "2026-09-01". Devolve "" no que nao casar. */
function dataBR(s) {
  const m = String(s || "").trim().match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : "";
}

/** Segunda-feira da semana de uma data ISO — a semana do roteiro. */
function semanaDe(iso) {
  const d = new Date(iso + "T12:00:00");
  const recuo = (d.getDay() + 6) % 7;            // domingo(0) vira 6
  d.setDate(d.getDate() - recuo);
  return diaISO(d);
}

// ---------------------------------------------------------------------------
// Ler o relatorio exportado
// ---------------------------------------------------------------------------

// As colunas sao procuradas pelo NOME, e sem acento: o proprio export escreve
// "InÍcio" com acento no meio e maiuscula trocada. Procurar por posicao
// quebraria no dia em que a Nexti acrescentasse uma coluna.
const COLUNAS = {
  matricula: "MATRICULA",
  supervisor: "COLABORADOR",
  posto: "POSTO",
  checklist: "NOME DO CHECKLIST",
  status: "STATUS",
  agendada: "DATA DO AGENDAMENTO",
  visita: "DATA DA VISITA",
  cliente: "CLIENTE",
  unidade: "UNIDADE DE NEGOCIO",
};

class ErroAgenda extends Error {
  constructor(mensagem) { super(mensagem); this.name = "ErroAgenda"; }
}

function acharCabecalho(linhas) {
  for (let i = 0; i < Math.min(linhas.length, 30); i++) {
    const nomes = linhas[i].map(normalizar);
    if (nomes.includes(COLUNAS.supervisor) && nomes.includes(COLUNAS.agendada)) {
      const onde = {};
      for (const [campo, titulo] of Object.entries(COLUNAS)) {
        const pos = nomes.indexOf(titulo);
        if (pos >= 0) onde[campo] = pos;
      }
      return { linha: i, onde };
    }
  }
  return null;
}

/**
 * Transforma a planilha exportada nas visitas AGENDADAS que ela descreve.
 *
 * Cada linha do relatorio e um agendamento — com o que aconteceu com ele
 * (finalizada, iniciada, nao realizada) na coluna Status.
 */
function lerRelatorio(linhas) {
  const cab = acharCabecalho(linhas);
  if (!cab) {
    throw new ErroAgenda(
      "Esta planilha não parece a \"Relação de visitas\" do Nexti: não achei as " +
      "colunas Colaborador e Data do agendamento.");
  }
  const pegar = (linha, campo) => {
    const i = cab.onde[campo];
    return i === undefined ? "" : String(linha[i] || "").trim();
  };

  const visitas = [];
  for (let i = cab.linha + 1; i < linhas.length; i++) {
    const l = linhas[i];
    const supervisor = pegar(l, "supervisor");
    const agendada = dataBR(pegar(l, "agendada"));
    if (!supervisor || !agendada) continue;          // rodape, linha em branco
    visitas.push({
      matricula: pegar(l, "matricula"),
      supervisor,
      posto: pegar(l, "posto"),
      cliente: pegar(l, "cliente"),
      checklist: pegar(l, "checklist"),
      status: pegar(l, "status"),
      agendada,
      visita: dataBR(pegar(l, "visita")),
      unidade: pegar(l, "unidade"),
    });
  }
  if (!visitas.length) throw new ErroAgenda("A planilha não tem nenhuma visita agendada.");
  return visitas;
}

// ---------------------------------------------------------------------------
// O padrao semanal
// ---------------------------------------------------------------------------

// Quantas semanas diferentes um ponto precisa aparecer para ser considerado
// roteiro. DUAS, e aqui esta o motivo:
//
// O relatorio mistura tres coisas na mesma lista — a visita que se repete toda
// semana ("Semanal: cada quinta-feira"), a visita marcada uma vez só ("Não se
// repete") e as tarefas que nascem de demanda (CC - SOLICITACAO, REMANEJAMENTO).
// So a primeira e roteiro. Cobrar as outras seria inventar obrigacao que
// ninguem assumiu — nos dados de 06/10/2026, tratar tudo como roteiro dava 501
// pontos por semana; o que de fato se repetia eram 10.
//
// Consequencia pratica, e ela precisa estar na tela: a planilha tem que cobrir
// VARIAS semanas. Exportar o mes que passou funciona; exportar tres dias nao.
const SEMANAS_PARA_SER_ROTEIRO = 2;

/**
 * De que supervisor visita que posto, em que dia da semana — o roteiro.
 *
 * O mesmo posto repetido no mesmo dia conta UMA vez: no relatorio isso aparece
 * quando houve mais de um checklist no mesmo lugar (uma visita de rotina e uma
 * solicitacao, por exemplo) e quando a agenda recem-cadastrada repetiu a
 * ocorrencia. Em nenhum dos dois casos sao duas visitas a cobrar.
 */
function padraoSemanal(visitas, minimoDeSemanas = SEMANAS_PARA_SER_ROTEIRO) {
  const porChave = new Map();
  for (const v of visitas) {
    if (!v.posto) continue;
    const diaSemana = new Date(v.agendada + "T12:00:00").getDay();
    const chave = normalizar(v.supervisor) + "|" + normalizar(v.posto) + "|" + diaSemana;
    if (!porChave.has(chave)) {
      porChave.set(chave, {
        supervisor: v.supervisor, posto: v.posto, cliente: v.cliente, diaSemana,
        semanas: new Set(),
      });
    }
    porChave.get(chave).semanas.add(semanaDe(v.agendada));
  }
  return [...porChave.values()]
    .filter((p) => p.semanas.size >= minimoDeSemanas)
    .map(({ semanas, ...p }) => ({ ...p, vezes: semanas.size }))
    .sort((a, b) =>
      a.supervisor.localeCompare(b.supervisor, "pt-BR") ||
      a.diaSemana - b.diaSemana ||
      a.posto.localeCompare(b.posto, "pt-BR"));
}

/** As datas de um mes em que o padrao preve visita. */
function previstasDoMes(padrao, ano, mes) {
  const saida = [];
  const ultimo = new Date(ano, mes, 0).getDate();
  for (let dia = 1; dia <= ultimo; dia++) {
    const d = new Date(ano, mes - 1, dia);
    for (const p of padrao) {
      if (p.diaSemana === d.getDay()) saida.push({ ...p, data: diaISO(d) });
    }
  }
  return saida;
}

// ---------------------------------------------------------------------------
// O cruzamento
// ---------------------------------------------------------------------------

/**
 * Casa o previsto com o realizado, semana a semana.
 *
 * `realizadas` vem do nosso banco (o que a API do Nexti entregou):
 * { supervisor, posto, dia }.
 *
 * `ateODia` corta o que ainda nao venceu: a semana corrente nao vira cobranca.
 */
function cruzar(previstas, realizadas, ateODia) {
  const feitas = realizadas.map((r) => ({
    supervisor: r.supervisor, posto: r.posto, dia: r.dia, semana: semanaDe(r.dia), usada: false,
  }));

  const linhas = [];
  // Uma visita por semana por posto: duas no mesmo lugar na mesma semana nao
  // sao duas cobrancas, sao a mesma visita (o roteiro e semanal).
  const porSemana = new Map();
  for (const p of previstas) {
    const semana = semanaDe(p.data);
    const chave = normalizar(p.supervisor) + "|" + normalizar(p.posto) + "|" + semana;
    if (!porSemana.has(chave)) porSemana.set(chave, { ...p, semana });
  }

  for (const p of porSemana.values()) {
    const candidatas = feitas.filter((f) =>
      !f.usada && f.semana === p.semana &&
      mesmoNome(f.supervisor, p.supervisor) && mesmoNome(f.posto, p.posto));

    const noDia = candidatas.find((f) => f.dia === p.data);
    const escolhida = noDia || candidatas[0] || null;
    if (escolhida) escolhida.usada = true;

    // A semana corrente nao vira cobranca: so entra na conta a semana que ja
    // FECHOU. Sem o "menor que", a visita combinada para depois de hoje
    // apareceria como perdida todo comeco de semana.
    const venceu = !ateODia || p.semana < semanaDe(ateODia);
    linhas.push({
      supervisor: p.supervisor, posto: p.posto, cliente: p.cliente,
      data: p.data, semana: p.semana,
      feita: Boolean(escolhida),
      diaFeito: escolhida ? escolhida.dia : "",
      noDiaCombinado: Boolean(noDia),
      cobravel: venceu,
    });
  }

  // O que foi feito e nao estava no roteiro: nao e falta, e trabalho a mais —
  // e some da conta de aderencia se ninguem contar.
  const foraDoRoteiro = feitas.filter((f) => !f.usada).length;
  return { linhas, foraDoRoteiro };
}

/** Resume por supervisor, para a tela. */
function porSupervisor(cruzamento) {
  const mapa = new Map();
  for (const l of cruzamento.linhas) {
    if (!l.cobravel) continue;
    const chave = normalizar(l.supervisor);
    if (!mapa.has(chave)) {
      mapa.set(chave, {
        supervisor: l.supervisor, previstas: 0, feitas: 0, foraDoDia: 0, faltaram: 0, postos: [],
      });
    }
    const s = mapa.get(chave);
    s.previstas += 1;
    if (l.feita) {
      s.feitas += 1;
      if (!l.noDiaCombinado) s.foraDoDia += 1;
    } else {
      s.faltaram += 1;
      s.postos.push({ posto: l.posto, cliente: l.cliente, data: l.data });
    }
  }
  return [...mapa.values()]
    .map((s) => ({ ...s, aderencia: s.previstas ? Math.round((s.feitas / s.previstas) * 100) : null }))
    .sort((a, b) => (a.aderencia ?? 999) - (b.aderencia ?? 999) ||
                    b.previstas - a.previstas);
}

// ---------------------------------------------------------------------------
// Banco
// ---------------------------------------------------------------------------

/** Guarda a planilha enviada como a agenda padrao, substituindo a anterior. */
async function guardar({ visitas, arquivo, usuarioId, usuarioNome }) {
  const padrao = padraoSemanal(visitas);
  const datas = visitas.map((v) => v.agendada).sort();
  const semanas = new Set(visitas.map((v) => semanaDe(v.agendada))).size;

  // Planilha sem nada que se repita nao e agenda: ou cobre pouco tempo, ou so
  // tem tarefa avulsa. Guardar assim deixaria o painel dizendo "nenhuma visita
  // prevista" sem explicar por que — o pior tipo de tela vazia.
  if (!padrao.length) {
    throw new ErroAgenda(
      semanas < 2
        ? "Esta planilha cobre menos de duas semanas, então não dá para saber o que se repete. " +
          "Exporte de novo com um período maior — de preferência as próximas 8 semanas."
        : "Não achei nenhuma visita que se repita semana a semana nesta planilha. " +
          "Confira se exportou o período do roteiro (Nexti Control → Relatório → Relação de visitas).");
  }
  return db.transaction(async (c) => {
    await c.query("UPDATE agenda_envio SET ativo = FALSE WHERE ativo = TRUE");
    const envio = await c.query(
      `INSERT INTO agenda_envio (arquivo, usuario_id, usuario_nome, periodo_inicio, periodo_fim,
                                 visitas, pontos, ativo)
       VALUES ($1,$2,$3,$4,$5,$6,$7,TRUE) RETURNING id, enviado_em`,
      [arquivo, usuarioId, usuarioNome, datas[0], datas[datas.length - 1], visitas.length, padrao.length]
    );
    const id = envio.rows[0].id;
    for (const p of padrao) {
      await c.query(
        `INSERT INTO agenda_ponto (envio_id, supervisor, posto, cliente, dia_semana)
         VALUES ($1,$2,$3,$4,$5)`,
        [id, p.supervisor, p.posto, p.cliente, p.diaSemana]
      );
    }
    return { id, enviadoEm: envio.rows[0].enviado_em, visitas: visitas.length,
             pontos: padrao.length, semanas };
  });
}

/** A agenda padrao de hoje — a ultima que subiram. */
async function agendaAtual() {
  const envio = await db.query(
    `SELECT id, arquivo, usuario_nome, enviado_em, periodo_inicio, periodo_fim, visitas, pontos
       FROM agenda_envio WHERE ativo = TRUE ORDER BY id DESC LIMIT 1`
  );
  if (!envio.rows[0]) return null;
  const pontos = await db.query(
    `SELECT supervisor, posto, cliente, dia_semana AS "diaSemana"
       FROM agenda_ponto WHERE envio_id = $1`, [envio.rows[0].id]
  );
  return { envio: envio.rows[0], padrao: pontos.rows };
}

/** O painel do mes: previsto, realizado e o que faltou. */
async function painelDoMes(ano, mes, hojeISO) {
  const atual = await agendaAtual();
  if (!atual) return { temAgenda: false };

  const previstas = previstasDoMes(atual.padrao, ano, mes);
  const r = await db.query(
    `SELECT supervisor_nome AS supervisor, posto_nome AS posto, dia::text AS dia
       FROM nexti_visita
      WHERE dia >= $1 AND dia <= $2`,
    [`${ano}-${p2(mes)}-01`, diaISO(new Date(ano, mes, 0))]
  );
  const cruzamento = cruzar(previstas, r.rows, hojeISO);
  return {
    temAgenda: true,
    envio: atual.envio,
    supervisores: porSupervisor(cruzamento),
    foraDoRoteiro: cruzamento.foraDoRoteiro,
    previstas: cruzamento.linhas.filter((l) => l.cobravel).length,
  };
}

module.exports = {
  lerPlanilha, lerRelatorio, padraoSemanal, previstasDoMes, cruzar, porSupervisor,
  guardar, agendaAtual, painelDoMes,
  mesmoNome, normalizar, dataBR, semanaDe, ErroAgenda,
};
