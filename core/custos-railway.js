"use strict";

// ============================================================================
// CUSTOS DO RAILWAY — painel e alerta
// ----------------------------------------------------------------------------
// Responde a pergunta que apareceu na fatura de 07/10/2026: "eu gastava US$ 6
// e veio US$ 24 — o que mudou?". A tela do Railway mostra o total, mas so no
// computador da para voltar ao mes anterior, e ela nao avisa ninguem antes de
// a fatura fechar. Este modulo:
//   1. pergunta a API do Railway quanto cada projeto e cada servico gastou no
//      ciclo atual, quanto deve fechar no fim do ciclo e quanto foi o anterior;
//   2. guarda uma foto por dia (custos_dia), para enxergar a evolucao;
//   3. manda e-mail quando a projecao ou o gasto passam do limite definido no
//      Admin Geral — UMA vez por ciclo e por tipo, nunca todo dia.
//
// Nao e regra de negocio de nenhum modulo: e custo de infraestrutura, assunto
// do Admin Geral, como os acessos.
//
// ---------------------------------------------------------------------------
// De onde vem cada numero (conferido contra a fatura 8M4PF9EW-0007):
//
//   API (workspaceUsageTotals, 08/09 a 08/10)     fatura
//   CPU_USAGE        7.862,6 vCPU-minuto    ->   US$ 3,64  (x 0,000463)
//   MEMORY_USAGE_GB 83.839,4 GB-minuto      ->   US$ 19,36 (x 0,000231)
//   NETWORK_TX_GB       15,6 GB             ->   US$ 0,78  (x 0,05)
//   DISK + BACKUP  111.886   GB-minuto      ->   US$ 0,39  (x 0,0000034722)
//
// Ou seja: a API devolve MINUTOS, nao meses. Quem multiplicar pelo preco
// mensal da pagina de precos erra por um fator de 43.200. Os precos por minuto
// estao em PRECO_POR_UNIDADE e sao os da pagina "Plans" do Railway.
//
// O backup e cobrado na mesma linha do disco ("Disk (per GB / min)"); por isso
// os dois entram com o mesmo preco.
//
// ---------------------------------------------------------------------------
// Credencial: RAILWAY_API_TOKEN (token de WORKSPACE, criado em
// railway.com/account/tokens escolhendo o workspace) e RAILWAY_WORKSPACE_ID.
// So o Core tem os dois; o navegador nunca ve o token.
// ============================================================================

const db = require("./db");
const correio = require("./email");

const API = "https://backboard.railway.com/graphql/v2";
const ESPERA_MS = 15000;

// Preco por unidade que a API devolve (minuto, ou GB no caso da rede).
const PRECO_POR_UNIDADE = {
  CPU_USAGE: 0.000463,                // US$ 20 / vCPU / mes
  MEMORY_USAGE_GB: 0.000231,          // US$ 10 / GB / mes
  NETWORK_TX_GB: 0.05,                // US$ 0,05 / GB de saida
  DISK_USAGE_GB: 0.000003472222222,   // US$ 0,15 / GB / mes
  BACKUP_USAGE_GB: 0.000003472222222, // cobrado junto com o disco
};
const MEDIDAS = Object.keys(PRECO_POR_UNIDADE);

// Minutos num mes de 30 dias — para converter GB-minuto em "RAM media".
const MINUTOS_MES = 30 * 24 * 60;

// Plano Hobby: US$ 5 de assinatura, que voltam como US$ 5 de uso incluido.
// A fatura e o maior dos dois: uso abaixo de 5 paga 5; acima, paga o uso.
const INCLUIDO_PADRAO = 5;

// Quanto tempo a tela reaproveita a ultima consulta. A API do Railway tem
// limite de chamadas por hora; o numero muda devagar.
const CACHE_MS = 10 * 60 * 1000;

function token() { return (process.env.RAILWAY_API_TOKEN || "").trim(); }
function workspaceId() { return (process.env.RAILWAY_WORKSPACE_ID || "").trim(); }
function configurado() { return Boolean(token() && workspaceId()); }

// ---------------------------------------------------------------------------
// Contas puras — testadas em tests/custos-railway.test.js, sem rede e sem banco
// ---------------------------------------------------------------------------

function custoDe(medida, valor) {
  const preco = PRECO_POR_UNIDADE[medida];
  const v = Number(valor);
  return preco && Number.isFinite(v) ? v * preco : 0;
}

// O que a fatura vai cobrar, dado o uso: nunca menos que o incluido no plano.
function faturaDe(uso, incluido = INCLUIDO_PADRAO) {
  return Math.max(Number(uso) || 0, incluido);
}

function arred(n) { return Math.round((Number(n) || 0) * 100) / 100; }

// Junta as respostas cruas da API num relatorio que a tela le direto.
//   uso:       [{ measurement, value, tags: { projectId, serviceId } }]
//   estimado:  [{ measurement, estimatedValue, projectId }]
//   projetos:  [{ id, name, services: [{ id, name }] }]
//   anterior:  [{ measurement, value }]  (totais do ciclo passado)
function montarRelatorio({ ciclo, uso, estimado, projetos, anterior, agora, incluido }) {
  const inc = incluido == null ? INCLUIDO_PADRAO : incluido;
  const nomeProjeto = new Map();
  const nomeServico = new Map();
  for (const p of projetos || []) {
    nomeProjeto.set(p.id, p.name);
    for (const s of p.services || []) nomeServico.set(s.id, s.name);
  }

  const porProjeto = new Map();
  function projeto(id) {
    const chave = id || "?";
    if (!porProjeto.has(chave)) {
      porProjeto.set(chave, {
        id: chave,
        nome: nomeProjeto.get(id) || "Projeto removido",
        atual: 0, estimado: 0, servicos: new Map(),
      });
    }
    return porProjeto.get(chave);
  }

  const porMedida = {};
  for (const linha of uso || []) {
    const tags = linha.tags || {};
    const p = projeto(tags.projectId);
    const sid = tags.serviceId || "?";
    if (!p.servicos.has(sid)) {
      p.servicos.set(sid, {
        id: sid, nome: nomeServico.get(sid) || "Serviço removido",
        custo: 0, cpu: 0, ram: 0, rede: 0, disco: 0, ramGbMin: 0, discoGbMin: 0,
      });
    }
    const s = p.servicos.get(sid);
    const c = custoDe(linha.measurement, linha.value);
    s.custo += c;
    p.atual += c;
    porMedida[linha.measurement] = (porMedida[linha.measurement] || 0) + c;
    if (linha.measurement === "CPU_USAGE") s.cpu += c;
    else if (linha.measurement === "MEMORY_USAGE_GB") { s.ram += c; s.ramGbMin += Number(linha.value) || 0; }
    else if (linha.measurement === "NETWORK_TX_GB") s.rede += c;
    else {
      s.disco += c;
      // So o volume conta para o teto do plano; backup e copia, fica de fora.
      if (linha.measurement === "DISK_USAGE_GB") s.discoGbMin += Number(linha.value) || 0;
    }
  }

  for (const e of estimado || []) projeto(e.projectId).estimado += custoDe(e.measurement, e.estimatedValue);

  // RAM media = GB-minuto / minutos decorridos no ciclo. E o numero que conta
  // a historia de um vazamento: servico parado com 600 MB "medios" e suspeito.
  const inicio = ciclo && ciclo.start ? new Date(ciclo.start).getTime() : null;
  const minutosDecorridos = inicio ? Math.max(1, ((agora || Date.now()) - inicio) / 60000) : null;

  const lista = [...porProjeto.values()].map((p) => ({
    id: p.id,
    nome: p.nome,
    atual: arred(p.atual),
    estimado: arred(p.estimado),
    servicos: [...p.servicos.values()]
      .map((s) => ({
        id: s.id, nome: s.nome,
        custo: arred(s.custo),
        cpu: arred(s.cpu), ram: arred(s.ram), rede: arred(s.rede), disco: arred(s.disco),
        ramMediaMb: minutosDecorridos ? Math.round((s.ramGbMin / minutosDecorridos) * 1024) : null,
        volumeGb: minutosDecorridos ? Math.round((s.discoGbMin / minutosDecorridos) * 100) / 100 : null,
      }))
      .sort((a, b) => b.custo - a.custo),
  })).sort((a, b) => b.estimado - a.estimado || b.atual - a.atual);

  const usoAtual = lista.reduce((t, p) => t + p.atual, 0);
  const usoEstimado = lista.reduce((t, p) => t + p.estimado, 0);
  const usoAnterior = (anterior || []).reduce((t, l) => t + custoDe(l.measurement, l.value), 0);

  return {
    ciclo: ciclo ? { inicio: ciclo.start, fim: ciclo.end } : null,
    incluido: inc,
    atual: { uso: arred(usoAtual), fatura: arred(faturaDe(usoAtual, inc)) },
    estimado: { uso: arred(usoEstimado), fatura: arred(faturaDe(usoEstimado, inc)) },
    anterior: anterior ? { uso: arred(usoAnterior), fatura: arred(faturaDe(usoAnterior, inc)) } : null,
    porMedida: {
      ram: arred(porMedida.MEMORY_USAGE_GB),
      cpu: arred(porMedida.CPU_USAGE),
      rede: arred(porMedida.NETWORK_TX_GB),
      disco: arred((porMedida.DISK_USAGE_GB || 0) + (porMedida.BACKUP_USAGE_GB || 0)),
    },
    projetos: lista,
  };
}

// ---------------------------------------------------------------------------
// Qual plano compensa
// ---------------------------------------------------------------------------
// Conferido na pagina "Plans" do Railway em 09/10/2026. Os precos por recurso
// sao os mesmos nos dois planos; muda a assinatura, o uso incluido e os tetos.
//   Hobby: US$ 5 (5 de uso incluido)  · volume ate 5 GB · 6 replicas/servico
//   Pro:   US$ 20 (20 de uso incluido) · volume ate 1 TB · membros no workspace
//
// Consequencia que orienta a regra: a fatura e max(uso, incluido). Com o mesmo
// uso, o Pro NUNCA sai mais barato — no maximo empata, quando o uso passa de
// US$ 20. Entao o Pro so se justifica por limite (volume perto de 5 GB) ou por
// recurso (colocar outra pessoa na conta), e nunca por economia.
const PLANOS = {
  HOBBY: { nome: "Hobby", incluido: 5, volumeGb: 5 },
  PRO: { nome: "Pro", incluido: 20, volumeGb: 1000 },
};
const MARGEM_VOLUME = 0.8; // avisa com 80% do teto, antes de travar o banco

const gb = (n) => Number(n).toFixed(1).replace(".", ",");

function recomendarPlano(rel, plano) {
  const atual = PLANOS[plano];
  if (!rel || !atual) return { acao: "manter", titulo: "Plano atual", motivos: ["Plano não reconhecido: " + (plano || "?")] };

  const servicos = rel.projetos.flatMap((p) => p.servicos.map((s) => ({ ...s, projeto: p.nome })));
  const volumes = servicos.filter((s) => s.volumeGb != null).sort((a, b) => b.volumeGb - a.volumeGb);
  const maior = volumes[0];
  const usoMes = rel.estimado.uso;
  // O ciclo anterior entra para nao mudar de plano por causa de um mes so.
  const usoAnterior = rel.anterior ? rel.anterior.uso : null;
  const fatura = (incl, u) => Math.max(u, incl);

  if (plano === "HOBBY") {
    if (maior && maior.volumeGb >= PLANOS.HOBBY.volumeGb * MARGEM_VOLUME) {
      return {
        acao: "subir", para: "PRO", titulo: "Hora de considerar o Pro",
        motivos: [
          `O banco de ${maior.projeto} já usa ${gb(maior.volumeGb)} GB dos 5 GB permitidos no Hobby. ` +
          "Quando encher, o banco para de gravar.",
        ],
        diferenca: fatura(20, usoMes) - fatura(5, usoMes),
      };
    }
    if (usoMes >= 20 && (usoAnterior == null || usoAnterior >= 20)) {
      return {
        acao: "subir", para: "PRO", titulo: "O Pro já sairia pelo mesmo preço",
        motivos: [
          `O uso projetado (${US(usoMes)}) passa dos US$ 20 que o Pro inclui, então a fatura seria igual.`,
          "Com o Pro, dá para colocar outra pessoa da TI na conta e os limites de volume e réplicas sobem.",
        ],
        diferenca: 0,
      };
    }
    return {
      acao: "manter", titulo: "O Hobby continua sendo o certo",
      motivos: [
        `No Pro, a fatura deste mês seria ${US(fatura(20, usoMes))} em vez de ${US(fatura(5, usoMes))}, ` +
        "sem nenhum ganho para o uso atual.",
        maior ? `O maior banco usa ${gb(maior.volumeGb)} GB de 5 GB.` : "Nenhum banco perto do limite de 5 GB.",
      ],
      diferenca: fatura(20, usoMes) - fatura(5, usoMes),
    };
  }

  // Esta no Pro.
  const cabeNoHobby = !maior || maior.volumeGb < PLANOS.HOBBY.volumeGb * MARGEM_VOLUME;
  const usoBaixo = usoMes < 20 && (usoAnterior == null || usoAnterior < 20);
  if (cabeNoHobby && usoBaixo) {
    const economia = fatura(20, usoMes) - fatura(5, usoMes);
    return {
      acao: "descer", para: "HOBBY", titulo: "Dá para voltar ao Hobby",
      motivos: [
        `O uso fica abaixo dos US$ 20 incluídos no Pro, então parte da assinatura está sendo paga sem uso.`,
        "Antes de trocar: o Hobby não aceita outros membros no workspace.",
      ],
      economia,
    };
  }
  return { acao: "manter", titulo: "O Pro continua fazendo sentido", motivos: [
    cabeNoHobby ? `O uso (${US(usoMes)}) passa dos US$ 20 incluídos — no Hobby a fatura seria a mesma.`
                : `O banco de ${maior.projeto} usa ${gb(maior.volumeGb)} GB — não cabe nos 5 GB do Hobby.`,
  ] };
}

// Quais alertas cabem agora. `enviados` e a lista de tipos ja mandados NESTE
// ciclo — cada tipo sai uma vez por ciclo, para o e-mail continuar sendo lido.
//   projecao -> a fatura estimada do mes passou do limite (aviso cedo)
//   gasto    -> o que ja foi gasto passou do limite (o limite ja foi)
//   plano    -> o uso passou do que o plano inclui (opcional, desligado por padrao)
function alertasDevidos(rel, cfg, enviados = []) {
  const ja = new Set(enviados);
  const out = [];
  if (!rel || !cfg || !cfg.ativo) return out;
  const limite = Number(cfg.limite_usd);
  if (limite > 0) {
    if (rel.atual.fatura > limite && !ja.has("gasto")) out.push("gasto");
    else if (rel.estimado.fatura > limite && !ja.has("projecao") && !ja.has("gasto")) out.push("projecao");
  }
  if (cfg.avisar_plano && rel.atual.uso > rel.incluido && !ja.has("plano")) out.push("plano");
  // Sugestao de troca de plano: sai sozinha, uma vez por ciclo, quando a regra
  // de recomendarPlano pede mudanca. Nao depende de limite.
  if (rel.recomendacao && rel.recomendacao.acao !== "manter" && !ja.has("mudar_plano")) out.push("mudar_plano");
  return out;
}

// ---------------------------------------------------------------------------
// Conversa com a API do Railway
// ---------------------------------------------------------------------------

async function gql(query, variables) {
  const resp = await fetch(API, {
    method: "POST",
    headers: { authorization: "Bearer " + token(), "content-type": "application/json" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(ESPERA_MS),
  });
  const corpo = await resp.json().catch(() => ({}));
  if (!resp.ok || corpo.errors) {
    const msg = (corpo.errors && corpo.errors[0] && corpo.errors[0].message) || ("HTTP " + resp.status);
    // O texto cru fica no log. Para a tela vai o que a pessoa consegue resolver.
    console.warn("[custos] API do Railway recusou:", msg);
    if (resp.status === 401 || /not authorized|unauthorized/i.test(msg)) {
      throw new Error("O Railway recusou o token. Confira RAILWAY_API_TOKEN e RAILWAY_WORKSPACE_ID no serviço core.");
    }
    throw new Error("O Railway não respondeu como esperado (" + msg + ").");
  }
  return corpo.data;
}

const Q_CICLO = `query($w:String!){ workspace(workspaceId:$w){ plan customer { currentUsage billingPeriod { start end } } } }`;
const Q_USO = `query($w:String!,$m:[MetricMeasurement!]!,$s:DateTime!,$e:DateTime!){
  usage(workspaceId:$w, measurements:$m, startDate:$s, endDate:$e, groupBy:[PROJECT_ID, SERVICE_ID], includeDeleted:true){
    measurement value tags { projectId serviceId } } }`;
const Q_ESTIMADO = `query($w:String!,$m:[MetricMeasurement!]!){
  estimatedUsage(workspaceId:$w, measurements:$m, includeDeleted:true){ measurement estimatedValue projectId } }`;
const Q_PROJETOS = `query($w:String!){ projects(workspaceId:$w, includeDeleted:false){
  edges { node { id name services { edges { node { id name } } } } } } }`;
const Q_TOTAIS = `query($w:String!,$m:[MetricMeasurement!]!,$s:DateTime!,$e:DateTime!){
  workspaceUsageTotals(workspaceId:$w, measurements:$m, startDate:$s, endDate:$e, includeDeleted:true){ measurement value } }`;

function mesAntes(iso) {
  const d = new Date(iso);
  d.setUTCMonth(d.getUTCMonth() - 1);
  return d.toISOString();
}

let cache = null; // { quando, relatorio } — um objeto so, nao cresce

async function consultar({ forcar = false } = {}) {
  if (!configurado()) {
    const e = new Error("Painel de custos ainda não configurado: faltam RAILWAY_API_TOKEN e RAILWAY_WORKSPACE_ID no serviço core.");
    e.naoConfigurado = true;
    throw e;
  }
  if (!forcar && cache && Date.now() - cache.quando < CACHE_MS) return cache.relatorio;

  const w = workspaceId();
  const agora = new Date();
  const c = await gql(Q_CICLO, { w });
  const ciclo = c.workspace.customer.billingPeriod;
  const plano = c.workspace.plan;

  const [u, e, p, t] = await Promise.all([
    gql(Q_USO, { w, m: MEDIDAS, s: ciclo.start, e: agora.toISOString() }),
    gql(Q_ESTIMADO, { w, m: MEDIDAS }),
    gql(Q_PROJETOS, { w }),
    gql(Q_TOTAIS, { w, m: MEDIDAS, s: mesAntes(ciclo.start), e: ciclo.start }).catch(() => null),
  ]);

  const projetos = p.projects.edges.map((x) => ({
    id: x.node.id, name: x.node.name,
    services: x.node.services.edges.map((s) => s.node),
  }));

  const relatorio = montarRelatorio({
    ciclo, agora: agora.getTime(),
    uso: u.usage,
    estimado: e.estimatedUsage,
    projetos,
    anterior: t ? t.workspaceUsageTotals : null,
    incluido: plano === "HOBBY" ? 5 : plano === "PRO" ? 20 : INCLUIDO_PADRAO,
  });
  relatorio.plano = plano;
  relatorio.recomendacao = recomendarPlano(relatorio, plano);
  relatorio.consultadoEm = agora.toISOString();

  cache = { quando: Date.now(), relatorio };
  return relatorio;
}

// ---------------------------------------------------------------------------
// Configuracao, historico e alerta — no banco, nao em memoria: com duas
// instancias do Core, as duas precisam concordar sobre o que ja foi avisado.
// ---------------------------------------------------------------------------

async function lerConfig() {
  const r = await db.query("SELECT limite_usd, emails, ativo, avisar_plano FROM custos_config WHERE id = 1");
  const c = r.rows[0] || { limite_usd: 10, emails: [], ativo: true, avisar_plano: false };
  // NUMERIC chega do pg como texto ("10.00"); a tela e a conta querem numero.
  return { ...c, limite_usd: Number(c.limite_usd), emails: c.emails || [] };
}

async function salvarConfig({ limite, emails, ativo, avisarPlano }) {
  const lim = Number(limite);
  if (!Number.isFinite(lim) || lim < 0 || lim > 10000) throw Object.assign(new Error("Limite inválido"), { status: 400 });
  const lista = (Array.isArray(emails) ? emails : String(emails || "").split(/[\s,;]+/))
    .map((x) => String(x).trim().toLowerCase())
    .filter(Boolean);
  for (const em of lista) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) throw Object.assign(new Error("E-mail inválido: " + em), { status: 400 });
  }
  await db.query(
    `INSERT INTO custos_config (id, limite_usd, emails, ativo, avisar_plano, atualizado_em)
     VALUES (1, $1, $2, $3, $4, NOW())
     ON CONFLICT (id) DO UPDATE SET limite_usd = $1, emails = $2, ativo = $3, avisar_plano = $4, atualizado_em = NOW()`,
    [lim, lista, ativo !== false, Boolean(avisarPlano)]
  );
  return lerConfig();
}

async function historico(dias = 62) {
  const r = await db.query(
    // dia::text: o DATE do pg vira Date no fuso do servidor e pode escorregar
    // um dia; texto "2026-10-08" e o que a tela compara e desenha.
    `SELECT dia::text AS dia, uso_atual, uso_estimado FROM custos_dia
      WHERE dia >= (NOW() AT TIME ZONE 'America/Sao_Paulo')::date - $1::int ORDER BY dia`,
    [dias]
  );
  return r.rows.map((x) => ({
    dia: String(x.dia),
    atual: Number(x.uso_atual), estimado: Number(x.uso_estimado),
  }));
}

async function alertasEnviados(cicloInicio) {
  const r = await db.query("SELECT tipo, enviado_em FROM custos_alerta WHERE ciclo_inicio = $1", [cicloInicio]);
  return r.rows;
}

const US = (n) => "US$ " + Number(n).toFixed(2).replace(".", ",");

function htmlAlerta(tipo, rel, cfg) {
  const titulo = {
    gasto: "O gasto do Railway passou do limite",
    projecao: "A fatura do Railway deve passar do limite",
    plano: "O uso do Railway passou do incluído no plano",
    mudar_plano: rel.recomendacao ? "Sugestão: " + rel.recomendacao.titulo : "Sugestão de plano",
  }[tipo];
  const topo = rel.projetos.slice(0, 5)
    .map((p) => `<tr><td style="padding:4px 0">${correio.esc(p.nome)}</td><td align="right">${US(p.estimado)}</td></tr>`)
    .join("");
  const fim = rel.ciclo ? new Date(rel.ciclo.fim).toLocaleDateString("pt-BR", { timeZone: "America/Sao_Paulo" }) : "";
  const miolo =
    `<p style="margin:0 0 12px;font-size:14px;color:#344054;line-height:1.6">` +
    `Gasto até agora: <b>${US(rel.atual.uso)}</b> (a fatura mínima é ${US(rel.incluido)})<br>` +
    `Projeção até ${fim}: <b>${US(rel.estimado.fatura)}</b><br>` +
    `Limite definido: <b>${US(cfg.limite_usd)}</b></p>` +
    (tipo === "mudar_plano" && rel.recomendacao
      ? `<p style="margin:0 0 12px;font-size:14px;color:#344054;line-height:1.6">` +
        rel.recomendacao.motivos.map(correio.esc).join("<br>") + `</p>`
      : "") +
    `<p style="margin:12px 0 6px;font-size:13px;color:#667085">Projetos que mais pesam na projeção:</p>` +
    `<table width="100%" style="font-size:14px;color:#101828">${topo}</table>` +
    `<p style="margin:16px 0 0;font-size:13px;color:#667085">Este aviso sai uma vez por ciclo. ` +
    `O detalhe por serviço está em Admin Geral &rsaquo; Custos.</p>`;
  const assunto = tipo === "mudar_plano" ? titulo
    : titulo + " — " + US(tipo === "gasto" ? rel.atual.fatura : rel.estimado.fatura);
  return { assunto, html: correio.moldura(titulo, miolo) };
}

async function enviarAlerta(tipo, rel, cfg) {
  const { assunto, html } = htmlAlerta(tipo, rel, cfg);
  const resultados = [];
  for (const para of cfg.emails) resultados.push(await correio.enviar(para, assunto, html));
  return resultados;
}

// Roda de tempos em tempos: grava a foto do dia e manda o que for devido.
// Nunca lanca — falha da API do Railway nao pode derrubar o Core.
async function verificar() {
  if (!configurado()) return { ignorado: "não configurado" };
  try {
    const rel = await consultar({ forcar: true });
    await db.query(
      `INSERT INTO custos_dia (dia, uso_atual, uso_estimado, detalhe) VALUES ((NOW() AT TIME ZONE 'America/Sao_Paulo')::date, $1, $2, $3)
       ON CONFLICT (dia) DO UPDATE SET uso_atual = $1, uso_estimado = $2, detalhe = $3, gravado_em = NOW()`,
      [rel.atual.uso, rel.estimado.uso, JSON.stringify(rel.projetos.map((p) => ({ nome: p.nome, atual: p.atual, estimado: p.estimado })))]
    );
    const cfg = await lerConfig();
    if (!cfg.emails || !cfg.emails.length) return { gravado: true, alertas: [] };
    const ja = (await alertasEnviados(rel.ciclo.inicio)).map((x) => x.tipo);
    const devidos = alertasDevidos(rel, cfg, ja);
    for (const tipo of devidos) {
      // A linha entra ANTES do envio, com chave unica: se duas instancias
      // chegarem juntas, so uma consegue inserir e so uma manda o e-mail.
      const r = await db.query(
        `INSERT INTO custos_alerta (ciclo_inicio, tipo, valor) VALUES ($1,$2,$3)
         ON CONFLICT (ciclo_inicio, tipo) DO NOTHING RETURNING tipo`,
        [rel.ciclo.inicio, tipo, tipo === "gasto" ? rel.atual.fatura : rel.estimado.fatura]
      );
      if (r.rowCount) await enviarAlerta(tipo, rel, cfg);
    }
    return { gravado: true, alertas: devidos };
  } catch (e) {
    console.error("[custos] verificacao falhou:", e.message);
    return { erro: e.message };
  }
}

// A cada 6 horas, com a primeira volta 2 minutos depois do boot (para nao
// disputar com o proprio boot). `unref` para nao segurar o processo.
function agendar() {
  if (!configurado()) {
    console.log("[custos] RAILWAY_API_TOKEN/RAILWAY_WORKSPACE_ID ausentes — painel de custos desligado");
    return;
  }
  setTimeout(verificar, 2 * 60 * 1000).unref();
  setInterval(verificar, 6 * 60 * 60 * 1000).unref();
}

module.exports = {
  configurado, consultar, verificar, agendar,
  lerConfig, salvarConfig, historico, alertasEnviados, enviarAlerta,
  // contas puras, para o teste
  custoDe, faturaDe, montarRelatorio, alertasDevidos, htmlAlerta, recomendarPlano, PLANOS,
  PRECO_POR_UNIDADE, MINUTOS_MES,
};
