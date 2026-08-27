"use strict";

// ============================================================================
// PAINEL DE CHECKLISTS DA OPERACAO
// ----------------------------------------------------------------------------
// Le as visitas do Nexti Control (core/nexti.js), guarda aqui e monta os
// numeros da tela.
//
// O QUE ESTE PAINEL FAZ, E O QUE ELE NAO FAZ
//
// A API do Nexti so entrega a visita CONCLUIDA — conferido contra o relatorio
// deles: 422 na API, 422 no relatorio, no mesmo periodo. As 23 nao realizadas e
// as 22 iniciadas de agosto/2026 nao vem por endpoint nenhum; so existem no
// relatorio "Relacao de visitas", que sai por download.
//
// Entao este painel NAO cobra falta a partir de um agendamento — ele nao tem o
// agendamento. O que ele faz e outra coisa, e de proposito:
//
//     o relatorio do Nexti conta o mes passado; este painel conta HOJE.
//
// Quando o mes fecha e o relatorio mostra as faltas, nao da mais para agir. As
// 16h de uma terca, "o Gustavo costuma registrar 4 visitas as tercas e hoje
// registrou 1" ainda e um telefonema. Por isso a comparacao aqui e com o
// COSTUME de cada supervisor, aprendido do proprio historico, e nao com uma
// meta cadastrada — que ninguem teria que manter atualizada.
//
// Quando (e se) a Nexti abrir o endpoint do relatorio, o previsto de verdade
// entra por cima disto sem jogar nada fora.
// ============================================================================

const db = require("./db");
const nexti = require("./nexti");

// Quanto tempo o dado de um dia vale antes de valer a pena buscar de novo.
//
// Hoje muda o tempo todo — 15 minutos e o compromisso entre a tela estar viva e
// nao martelar o fornecedor. Ontem e anteontem ainda recebem lancamento
// atrasado, mas devagar. Dia fechado nao muda mais: buscar de novo seria
// gastar chamada para reescrever a mesma linha.
const FRESCOR_HOJE_MIN = 15;
const FRESCOR_RECENTE_H = 6;
const DIAS_RECENTES = 3;

// Quantas semanas de historico entram no calculo do "costume" de cada
// supervisor. Poucas semanas e o costume vira ruido — uma folga distorce tudo.
// Muitas e ele demora a perceber uma mudanca de roteiro. Seis e o meio.
const SEMANAS_DE_COSTUME = 6;

const p2 = (n) => String(n).padStart(2, "0");
const diaISO = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;

// "2026-08-26 09:17:06" -> Date.
//
// Repare: NAO e o mesmo formato das datas de checklist (ddMMyyyyHHmmss). Cada
// canto da API do Nexti usa um formato diferente; este e o das etapas da
// tarefa. Por isso a conversao mora aqui, junto de quem le a etapa, e nao numa
// funcao generica que daria a impressao de existir um padrao.
function dataDaEtapa(s) {
  const m = String(s || "").match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]);
  return isNaN(d.getTime()) ? null : d;
}

const etapa = (t, nome) =>
  (t.taskStages || []).find((e) => String(e.stageName || "").toUpperCase() === nome);

// De uma tarefa do Nexti para uma linha nossa.
function daTarefa(t, dia) {
  const ini = dataDaEtapa((etapa(t, "TASK_STARTED") || {}).stageDate);
  const fim = dataDaEtapa((etapa(t, "TASK_FINISHED") || {}).stageDate);
  const posto = t.workplace || {};
  const usuario = t.userAccount || {};
  return {
    id: t.id,
    dia,
    postoId: t.workplaceId || null,
    postoNome: posto.name || posto.nome || null,
    clienteNome: clienteDoPosto(posto.name || posto.nome || ""),
    supervisorId: t.userAccountId || null,
    supervisorNome: usuario.name || usuario.nome || usuario.login || null,
    checklistNome: (t.checklist && (t.checklist.name || t.checklist.nome)) || null,
    inicioEm: ini,
    fimEm: fim,
    minutos: ini && fim && fim >= ini ? Math.round((fim - ini) / 60000) : null,
  };
}

// O nome do posto vem como "CLIENTE - CARGO" ou "CLIENTE (Privado) - CARGO".
// O mesmo cliente aparece varias vezes (PORTARIA, VIGILANTE, LIMPEZA sao postos
// separados), e a tela precisa poder somar por cliente.
function clienteDoPosto(nome) {
  const s = String(nome || "");
  const i = s.lastIndexOf(" - ");
  return (i > 0 ? s.slice(0, i) : s).replace(/\s*\(Privado\)\s*$/i, "").trim() || null;
}

// ---------------------------------------------------------------------------
// SINCRONIZACAO
// ---------------------------------------------------------------------------

// Quais dias do intervalo precisam ser buscados de novo.
async function diasParaSincronizar(de, ate) {
  const r = await db.query(
    "SELECT dia, sincronizado_em FROM nexti_sync WHERE dia BETWEEN $1 AND $2",
    [diaISO(de), diaISO(ate)]
  );
  const quando = new Map(r.rows.map((x) => [diaISO(new Date(x.dia)), new Date(x.sincronizado_em)]));
  const hoje = diaISO(new Date());
  const limite = new Date();
  limite.setDate(limite.getDate() - DIAS_RECENTES);

  const faltando = [];
  for (let d = new Date(de); d <= ate; d.setDate(d.getDate() + 1)) {
    const iso = diaISO(d);
    const ultima = quando.get(iso);
    if (!ultima) { faltando.push(new Date(d)); continue; }
    const idadeMin = (Date.now() - ultima.getTime()) / 60000;
    if (iso === hoje) {
      if (idadeMin >= FRESCOR_HOJE_MIN) faltando.push(new Date(d));
    } else if (d >= limite) {
      if (idadeMin >= FRESCOR_RECENTE_H * 60) faltando.push(new Date(d));
    }
    // dia fechado e ja buscado: nao busca mais
  }
  return faltando;
}

async function gravarDia(dia, tarefas) {
  const iso = diaISO(dia);
  for (const t of tarefas) {
    const v = daTarefa(t, iso);
    if (!v.id) continue;
    await db.query(
      `INSERT INTO nexti_visita
         (id, dia, posto_id, posto_nome, cliente_nome, supervisor_id, supervisor_nome,
          checklist_nome, inicio_em, fim_em, minutos, atualizado_em)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NOW())
       ON CONFLICT (id) DO UPDATE SET
         dia = EXCLUDED.dia, posto_id = EXCLUDED.posto_id, posto_nome = EXCLUDED.posto_nome,
         cliente_nome = EXCLUDED.cliente_nome, supervisor_id = EXCLUDED.supervisor_id,
         supervisor_nome = EXCLUDED.supervisor_nome, checklist_nome = EXCLUDED.checklist_nome,
         inicio_em = EXCLUDED.inicio_em, fim_em = EXCLUDED.fim_em,
         minutos = EXCLUDED.minutos, atualizado_em = NOW()`,
      [v.id, v.dia, v.postoId, v.postoNome, v.clienteNome, v.supervisorId,
       v.supervisorNome, v.checklistNome, v.inicioEm, v.fimEm, v.minutos]
    );
  }
  await db.query(
    `INSERT INTO nexti_sync (dia, sincronizado_em, quantas, erro)
     VALUES ($1, NOW(), $2, NULL)
     ON CONFLICT (dia) DO UPDATE SET sincronizado_em = NOW(), quantas = $2, erro = NULL`,
    [iso, tarefas.length]
  );
}

async function gravarErro(dia, mensagem) {
  await db.query(
    `INSERT INTO nexti_sync (dia, sincronizado_em, quantas, erro)
     VALUES ($1, NOW(), 0, $2)
     ON CONFLICT (dia) DO UPDATE SET erro = $2`,
    [diaISO(dia), String(mensagem).slice(0, 300)]
  );
}

// Busca os dias que estao velhos. Devolve o que aconteceu, para a tela poder
// contar a verdade em vez de so mostrar numero.
//
// Um dia que falha NAO interrompe os outros: melhor o painel com 29 dos 30 dias
// e um aviso do que tela em branco. A excecao e o 429 — se o Nexti pediu para
// reduzir o ritmo, parar e o unico jeito de respeitar.
async function sincronizar(de, ate) {
  if (!nexti.configurado()) {
    return { ok: false, motivo: "sem-credencial", dias: 0, visitas: 0 };
  }
  const dias = await diasParaSincronizar(de, ate);
  let visitas = 0, falhas = 0, interrompido = null;

  for (const dia of dias) {
    try {
      const tarefas = await nexti.tudoPaginado(
        (p) => `/controltasks/finished?referenceDate=${p2(dia.getDate())}${
          p2(dia.getMonth() + 1)}${dia.getFullYear()}&page=${p}&size=200`
      );
      await gravarDia(dia, tarefas);
      visitas += tarefas.length;
    } catch (e) {
      falhas++;
      await gravarErro(dia, e.message);
      if (e.causa === "limite") { interrompido = "limite"; break; }
    }
  }
  return { ok: !interrompido, motivo: interrompido, dias: dias.length, visitas, falhas };
}

// ---------------------------------------------------------------------------
// OS NUMEROS DA TELA
// ---------------------------------------------------------------------------

async function painel(de, ate) {
  const d1 = diaISO(de), d2 = diaISO(ate);

  const totais = await db.query(
    `SELECT count(*)::int AS visitas,
            count(DISTINCT posto_id)::int AS postos,
            count(DISTINCT cliente_nome)::int AS clientes,
            count(DISTINCT supervisor_id)::int AS supervisores,
            avg(minutos) FILTER (WHERE minutos IS NOT NULL) AS media_min
       FROM nexti_visita WHERE dia BETWEEN $1 AND $2`,
    [d1, d2]
  );

  const porSupervisor = await db.query(
    `SELECT supervisor_id, supervisor_nome,
            count(*)::int AS visitas,
            count(DISTINCT posto_id)::int AS postos,
            count(DISTINCT dia)::int AS dias,
            avg(minutos) FILTER (WHERE minutos IS NOT NULL) AS media_min,
            max(dia) AS ultima
       FROM nexti_visita WHERE dia BETWEEN $1 AND $2
      GROUP BY supervisor_id, supervisor_nome
      ORDER BY visitas DESC`,
    [d1, d2]
  );

  const porCliente = await db.query(
    `SELECT cliente_nome,
            count(*)::int AS visitas,
            count(DISTINCT posto_id)::int AS postos,
            max(dia) AS ultima
       FROM nexti_visita WHERE dia BETWEEN $1 AND $2 AND cliente_nome IS NOT NULL
      GROUP BY cliente_nome
      ORDER BY visitas DESC`,
    [d1, d2]
  );

  const porChecklist = await db.query(
    `SELECT coalesce(checklist_nome, '(sem nome)') AS nome, count(*)::int AS visitas
       FROM nexti_visita WHERE dia BETWEEN $1 AND $2
      GROUP BY 1 ORDER BY visitas DESC`,
    [d1, d2]
  );

  const porDia = await db.query(
    `SELECT dia, count(*)::int AS visitas
       FROM nexti_visita WHERE dia BETWEEN $1 AND $2
      GROUP BY dia ORDER BY dia`,
    [d1, d2]
  );

  return {
    periodo: { de: d1, ate: d2 },
    totais: totais.rows[0],
    supervisores: porSupervisor.rows,
    clientes: porCliente.rows,
    checklists: porChecklist.rows,
    porDia: porDia.rows,
  };
}

// As visitas uma a uma, para a tabela que abre ao clicar num numero da tela.
//
// Todo numero de painel deve ter um caminho ate as linhas que o formaram. Sem
// isso, quem discorda do total nao tem como conferir — e um painel em que nao
// da para conferir vira um painel em que nao se confia.
//
// O limite de 500 nao e paginacao disfarcada: e o teto do que faz sentido ler
// numa tabela de tela. Quando bate, a resposta diz `truncado: true` e a tela
// avisa, em vez de mostrar uma lista cortada como se fosse completa.
const LIMITE_DETALHE = 500;

async function visitas(de, ate, filtro = {}) {
  const cond = ["dia BETWEEN $1 AND $2"];
  const args = [diaISO(de), diaISO(ate)];
  if (filtro.supervisorId) {
    args.push(filtro.supervisorId);
    cond.push(`supervisor_id = $${args.length}`);
  }
  if (filtro.cliente) {
    args.push(filtro.cliente);
    cond.push(`cliente_nome = $${args.length}`);
  }
  if (filtro.dia) {
    args.push(filtro.dia);
    cond.push(`dia = $${args.length}`);
  }

  const onde = cond.join(" AND ");
  const total = await db.query(`SELECT count(*)::int AS n FROM nexti_visita WHERE ${onde}`, args);
  args.push(LIMITE_DETALHE);
  const r = await db.query(
    `SELECT id, dia, posto_nome, cliente_nome, supervisor_nome, checklist_nome,
            inicio_em, fim_em, minutos
       FROM nexti_visita WHERE ${onde}
      ORDER BY dia DESC, inicio_em DESC NULLS LAST
      LIMIT $${args.length}`,
    args
  );
  return {
    total: total.rows[0].n,
    truncado: total.rows[0].n > LIMITE_DETALHE,
    linhas: r.rows,
  };
}

// O "costume" de cada supervisor no dia da semana de hoje.
//
// E o coracao do painel do dia: sem agendamento vindo do Nexti, a unica
// referencia honesta e o que a propria pessoa costuma fazer nesse dia da
// semana. Se ela faz 4 visitas toda terca e hoje, terca, fez 1, isso e um
// telefonema — e nao precisa de cadastro nenhum para ser descoberto.
//
// Usa a MEDIANA, e nao a media: um dia excepcional de 20 visitas puxaria a
// media para cima e o painel passaria a cobrar todo mundo o tempo todo.
async function costumeDeHoje(quando = new Date()) {
  const diaSemana = quando.getDay();
  const desde = new Date(quando);
  desde.setDate(desde.getDate() - SEMANAS_DE_COSTUME * 7);

  const r = await db.query(
    `SELECT supervisor_id, supervisor_nome, dia, count(*)::int AS visitas
       FROM nexti_visita
      WHERE dia >= $1 AND dia < $2 AND EXTRACT(DOW FROM dia) = $3
        AND supervisor_id IS NOT NULL
      GROUP BY supervisor_id, supervisor_nome, dia`,
    [diaISO(desde), diaISO(quando), diaSemana]
  );

  const porSup = new Map();
  r.rows.forEach((x) => {
    if (!porSup.has(x.supervisor_id)) {
      porSup.set(x.supervisor_id, { nome: x.supervisor_nome, contagens: [] });
    }
    porSup.get(x.supervisor_id).contagens.push(x.visitas);
  });

  const hoje = await db.query(
    `SELECT supervisor_id, count(*)::int AS visitas
       FROM nexti_visita WHERE dia = $1 AND supervisor_id IS NOT NULL
      GROUP BY supervisor_id`,
    [diaISO(quando)]
  );
  const feitasHoje = new Map(hoje.rows.map((x) => [x.supervisor_id, x.visitas]));

  const lista = [];
  porSup.forEach((v, id) => {
    const c = v.contagens.slice().sort((a, b) => a - b);
    // Sem pelo menos tres semanas nao ha costume, ha coincidencia.
    if (c.length < 3) return;
    const mediana = c[Math.floor(c.length / 2)];
    lista.push({
      supervisorId: id,
      supervisorNome: v.nome,
      costume: mediana,
      semanas: c.length,
      hoje: feitasHoje.get(id) || 0,
    });
  });
  lista.sort((a, b) => (a.hoje - a.costume) - (b.hoje - b.costume));
  return lista;
}

// Quando cada dia do intervalo foi atualizado pela ultima vez, e o que falhou.
// A tela usa isto para dizer "atualizado as 10:42" — e, mais importante, para
// dizer quando NAO conseguiu atualizar.
async function frescor(de, ate) {
  const r = await db.query(
    `SELECT max(sincronizado_em) AS ultima,
            count(*) FILTER (WHERE erro IS NOT NULL)::int AS comErro,
            max(erro) AS umErro
       FROM nexti_sync WHERE dia BETWEEN $1 AND $2`,
    [diaISO(de), diaISO(ate)]
  );
  const x = r.rows[0] || {};
  return {
    ultimaAtualizacao: x.ultima || null,
    diasComErro: x.comerro || x.comErro || 0,
    exemploDeErro: x.umerro || x.umErro || null,
    configurado: nexti.configurado(),
  };
}

// Quem enxerga o painel. Mesmo padrao do mural: marcador por pessoa, concedido
// no Admin Geral; administrador geral ve sempre.
function podeVer(u) {
  return Boolean(u && (u.super_admin || u.checklists_ver));
}

module.exports = {
  sincronizar, painel, visitas, costumeDeHoje, frescor, podeVer,
  LIMITE_DETALHE,
  daTarefa, clienteDoPosto, dataDaEtapa, diasParaSincronizar,
  FRESCOR_HOJE_MIN, FRESCOR_RECENTE_H, SEMANAS_DE_COSTUME,
};
