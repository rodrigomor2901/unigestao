"use strict";

// ============================================================================
// NEXTI — cliente da API de checklists
// ----------------------------------------------------------------------------
// O Nexti e o sistema de checklist da operacao, do fornecedor, rodando na nuvem
// dele. Nao da para plugar como os seis modulos do Grupo (ver core/modulos.js,
// bloco `externo`): o que da e ler os dados pela API publica e montar uma tela
// nossa.
//
// Especificacao: https://api.nexti.com/v3/api-docs
//
// TRES COISAS QUE DECIDEM O DESENHO DESTE ARQUIVO
//
// 1. NAO EXISTE "LISTAR TODOS OS CHECKLISTS". Toda consulta e ancorada em um
//    posto (`workplaceId`) mais um periodo. Cobrir a operacao inteira exige um
//    laco posto a posto — e e por isso que ha cache (ver core/checklists.js):
//    consultar ao vivo a cada abertura de tela seria uma chamada por posto,
//    por pessoa olhando.
//
// 2. NAO HA LIMITE DE CHAMADAS DOCUMENTADO. Nenhum endpoint declara resposta
//    429 e o texto nao menciona cota. Isso NAO quer dizer que nao exista um —
//    quer dizer que nao sabemos qual e. Por isso este cliente e deliberadamente
//    manso: uma chamada por vez, com pausa entre elas, e recuo imediato se o
//    servidor reclamar. Melhor demorar do que ser bloqueado.
//
// 3. A CREDENCIAL E DA EMPRESA, NAO DA PESSOA. O OAuth aqui e
//    client_credentials: existe um unico par Client-ID/Secret para o Grupo
//    todo, e quem o usa enxerga tudo. Ou seja, o filtro de quem ve o que NAO
//    vem do Nexti — tem que ser nosso, na camada de cima.
// ============================================================================

const BASE = process.env.NEXTI_URL || "https://api.nexti.com";
const CLIENT_ID = process.env.NEXTI_CLIENT_ID || "";
const CLIENT_SECRET = process.env.NEXTI_CLIENT_SECRET || "";

// Pausa entre chamadas seguidas. Com ~30 postos, 350ms espalha o ciclo em uns
// 10 segundos em vez de disparar tudo de uma vez — que e justamente a forma que
// costuma esbarrar em limite por minuto.
const PAUSA_MS = Number(process.env.NEXTI_PAUSA_MS || 350);

// Quantos registros por pagina. O padrao da API e 10, o que multiplicaria as
// chamadas por nada.
const PAGINA = 200;

function configurado() {
  return Boolean(CLIENT_ID && CLIENT_SECRET);
}

// ----------------------------------------------------------------------------
// DATAS — ddMMyyyyHHmmss, e nao ISO
// ----------------------------------------------------------------------------
// A especificacao se contradiz. Os parametros `start`/`finish` do endpoint de
// checklists declaram `format: date-time`, que em OpenAPI significa ISO-8601.
// Mas:
//   - os campos de data dos proprios DTOs trazem `example: ddMMyyyyHHmmss`
//   - varios outros endpoints da MESMA API dizem, na descricao, "Data inicio
//     no formato ddMMyyyyHHmmss"
//   - um deles declara as duas coisas ao mesmo tempo
//
// O `date-time` tem cara de sobra da ferramenta que gerou a especificacao, e
// nao do que o servidor aceita. Entao vai ddMMyyyyHHmmss.
//
// SE ISSO ESTIVER ERRADO, E AQUI QUE SE CONSERTA — em uma funcao so. Confirmar
// na primeira chamada com credencial de verdade: formato errado devolve erro,
// ou pior, uma janela silenciosamente diferente da pedida.
function paraDataNexti(d) {
  const p = (n, tam = 2) => String(n).padStart(tam, "0");
  return p(d.getDate()) + p(d.getMonth() + 1) + p(d.getFullYear(), 4) +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

// O caminho de volta: "26082026060000" -> Date. Devolve null no que nao casar,
// em vez de uma data invalida que contamina tudo silenciosamente.
function deDataNexti(s) {
  const m = String(s || "").match(/^(\d{2})(\d{2})(\d{4})(\d{2})(\d{2})(\d{2})$/);
  if (!m) return null;
  const d = new Date(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
  return isNaN(d.getTime()) ? null : d;
}

// ----------------------------------------------------------------------------
// TOKEN
// ----------------------------------------------------------------------------
// Guardado em memoria ate perto de vencer. Pedir um token novo a cada chamada
// dobraria o trafego contra o fornecedor sem necessidade.
let tokenAtual = null;
let tokenExpiraEm = 0;

async function pegarToken(forcar = false) {
  if (!configurado()) throw new Error("NEXTI_CLIENT_ID/SECRET nao configurados");
  const agora = Date.now();
  if (!forcar && tokenAtual && agora < tokenExpiraEm) return tokenAtual;

  // HTTP Basic, e NAO query string.
  //
  // A documentacao do Nexti manda assim:
  //   /security/oauth/token?grant_type=client_credentials&client_id=&client_secret=
  // e isso responde 401. O servidor devolve `WWW-Authenticate: Basic
  // realm="oauth2/client"`, ou seja: quer as credenciais no cabecalho, como
  // manda o proprio OAuth2 (RFC 6749 §2.3.1). A assinatura da URL
  // (/security/oauth/token) e de Spring Security OAuth, que exige Basic por
  // padrao — a documentacao deles descreve o que era, nao o que e.
  //
  // Conferido contra a API de producao em 26/08/2026: query string da 401,
  // Basic da 200. Ver scripts/nexti-login.js, que testa as duas formas.
  const basico = Buffer.from(`${CLIENT_ID.trim()}:${CLIENT_SECRET.trim()}`).toString("base64");
  const r = await fetch(`${BASE}/security/oauth/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + basico,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!r.ok) throw new Error(`Nexti recusou a autenticacao (HTTP ${r.status})`);
  const d = await r.json();
  if (!d.access_token) throw new Error("Nexti nao devolveu access_token");

  tokenAtual = d.access_token;
  // Um minuto de folga: token que vence no meio de um ciclo de 30 postos
  // derrubaria a metade final por 401.
  const segundos = Number(d.expires_in || 3600);
  tokenExpiraEm = agora + Math.max(60, segundos - 60) * 1000;
  return tokenAtual;
}

function esquecerToken() {
  tokenAtual = null;
  tokenExpiraEm = 0;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

// Erro com a causa legivel, para a tela poder dizer o que houve em vez de
// "algo deu errado".
class ErroNexti extends Error {
  constructor(mensagem, causa, status) {
    super(mensagem);
    this.causa = causa;      // 'credencial' | 'limite' | 'fora' | 'resposta'
    this.status = status || 0;
  }
}

// ----------------------------------------------------------------------------
// CHAMADA
// ----------------------------------------------------------------------------
// 401 tem UMA segunda chance com token novo: o caso comum e token vencido antes
// da hora. Insistir mais que isso, com credencial errada, so acumularia
// tentativa de login falha no fornecedor.
//
// 429 nao tem segunda chance nenhuma. Se ele pediu para parar, para — quem
// chamou decide se tenta de novo mais tarde.
async function chamar(caminho, { tentouDeNovo = false } = {}) {
  let token;
  try {
    token = await pegarToken();
  } catch (e) {
    throw new ErroNexti(e.message, "credencial");
  }

  let r;
  try {
    r = await fetch(BASE + caminho, {
      headers: { Authorization: "Bearer " + token, Accept: "application/json" },
    });
  } catch (e) {
    throw new ErroNexti("Nao foi possivel falar com o Nexti: " + e.message, "fora");
  }

  if (r.status === 401 && !tentouDeNovo) {
    esquecerToken();
    return chamar(caminho, { tentouDeNovo: true });
  }
  if (r.status === 401) {
    throw new ErroNexti("O Nexti recusou a credencial", "credencial", 401);
  }
  if (r.status === 429) {
    throw new ErroNexti("O Nexti pediu para reduzir o ritmo", "limite", 429);
  }
  if (!r.ok) {
    throw new ErroNexti(`O Nexti respondeu HTTP ${r.status}`, "resposta", r.status);
  }
  try {
    return await r.json();
  } catch (e) {
    throw new ErroNexti("O Nexti devolveu algo que nao e JSON", "resposta", r.status);
  }
}

// Percorre uma listagem paginada ate o fim, com pausa entre paginas.
//
// O limite de paginas nao e desconfianca da API: e para um dado inesperado
// (um `last` que nunca vira true) nao virar laco infinito martelando o
// fornecedor ate alguem perceber.
async function tudoPaginado(montarCaminho, limitePaginas = 50) {
  const itens = [];
  for (let pagina = 0; pagina < limitePaginas; pagina++) {
    if (pagina > 0) await dormir(PAUSA_MS);
    const d = await chamar(montarCaminho(pagina));
    const conteudo = (d && d.content) || [];
    itens.push(...conteudo);
    if (!d || d.last === true || conteudo.length === 0) break;
    if (typeof d.totalPages === "number" && pagina + 1 >= d.totalPages) break;
  }
  return itens;
}

// ----------------------------------------------------------------------------
// O QUE A TELA PRECISA
// ----------------------------------------------------------------------------

// Postos. Muda pouco — quem chama deve guardar, nao pedir a cada consulta.
async function postos() {
  return tudoPaginado((p) => `/workplaces/all?page=${p}&size=${PAGINA}`);
}

// Areas: e daqui que sai o vinculo supervisor -> postos, que o Nexti nao expoe
// de forma direta. Uma chamada so monta o mapa inteiro.
async function areas() {
  return tudoPaginado((p) => `/areas/all?page=${p}&size=${PAGINA}`);
}

async function clientes() {
  return tudoPaginado((p) => `/clients/all?page=${p}&size=${PAGINA}`);
}

// Checklists de UM posto num periodo. E a unidade de consulta da API — nao ha
// como pedir de varios postos de uma vez.
async function checklistsDoPosto(workplaceId, inicio, fim) {
  const de = paraDataNexti(inicio);
  const ate = paraDataNexti(fim);
  return tudoPaginado((p) =>
    `/checklists/workplace/${encodeURIComponent(workplaceId)}` +
    `/start/${de}/finish/${ate}?page=${p}&size=${PAGINA}`);
}

// Respostas de um checklist: quem respondeu, quando, e o que respondeu.
async function respostasDoChecklist(checklistId, inicio, fim) {
  const de = paraDataNexti(inicio);
  const ate = paraDataNexti(fim);
  return tudoPaginado((p) =>
    `/checklists/answer/checklist/${encodeURIComponent(checklistId)}` +
    `/start/${de}/finish/${ate}?page=${p}&size=${PAGINA}`);
}

// ----------------------------------------------------------------------------
// CODIGOS DO NEXTI
// ----------------------------------------------------------------------------
// Estao na descricao dos campos da especificacao. Ficam aqui com nome para o
// resto do sistema nunca comparar numero solto.
const STATUS = { NAO_RESPONDIDO: 1, RESPONDIDO: 2, RESPONDIDO_OUTRO_DISPOSITIVO: 3, CANCELADO: 4 };
const STATUS_ROTULO = {
  1: "Não respondido", 2: "Respondido",
  3: "Respondido em outro dispositivo", 4: "Cancelado",
};
const TIPO = { COLABORADOR: 1, POSTO: 2 };
const COLETOR = { TERMINAL: 1, APLICATIVO: 2, AMBOS: 3 };

// "Respondido em outro dispositivo" conta como feito: a tarefa aconteceu, so
// foi registrada de outro lugar. Tratar como pendente cobraria de novo algo que
// ja foi entregue.
const foiRespondido = (statusId) =>
  statusId === STATUS.RESPONDIDO || statusId === STATUS.RESPONDIDO_OUTRO_DISPOSITIVO;

module.exports = {
  configurado, BASE, PAUSA_MS,
  paraDataNexti, deDataNexti,
  pegarToken, esquecerToken, chamar, tudoPaginado,
  postos, areas, clientes, checklistsDoPosto, respostasDoChecklist,
  STATUS, STATUS_ROTULO, TIPO, COLETOR, foiRespondido,
  ErroNexti,
};
