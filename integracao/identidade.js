"use strict";

// ============================================================================
// UniGestao — identidade assinada
// ----------------------------------------------------------------------------
// A Fachada ASSINA quem e a pessoa; o modulo CONFERE a assinatura antes de
// acreditar em qualquer coisa. Este arquivo tem os dois lados, para nao existir
// a chance de um evoluir sem o outro: a Fachada usa `assinar`, os modulos usam
// `verificar` (copiado dentro do unigestao.js deles).
//
// POR QUE ISSO EXISTE
// Antes, o modulo recebia a identidade em cabecalhos soltos (`x-ug-id`,
// `x-ug-papel`, `x-ug-super`) e a unica tranca era um segredo compartilhado que
// vinha JUNTO, no `x-ug-key`. Tres consequencias ruins:
//
//   1. o segredo VIAJAVA em toda requisicao, para todo modulo — qualquer log,
//      qualquer modulo comprometido, qualquer proxy no caminho passava a poder
//      forjar identidade para todos os outros;
//   2. quem tivesse o segredo montava um administrador em um `curl`, so mudando
//      `x-ug-papel` e `x-ug-super`;
//   3. os cabecalhos nao tinham validade nem dono: valiam para sempre e para
//      qualquer modulo.
//
// Com a assinatura, os campos andam juntos e lacrados: mexer em um invalida o
// conjunto. O bilhete vale dois minutos, vale para UM modulo, e tem numero
// unico — entao nao serve para guardar e usar depois.
//
// O QUE ISTO **NAO** RESOLVE, e e honesto dizer: a assinatura e simetrica. Quem
// tiver o segredo de assinatura consegue emitir bilhete valido. O ganho e que o
// segredo NAO VIAJA — desde 01/09/2026 a Fachada nao manda mais o `x-ug-key`, e
// a chave de assinatura e o UG_ASSINATURA_SEGREDO, que so existe nas variaveis
// de cada servico — e que o bilhete tem dono e prazo. Nao e uma chave publica:
// para isso seria preciso assinatura assimetrica, com a Fachada guardando a
// chave privada e os modulos so a publica.
// ============================================================================

const crypto = require("crypto");

const VERSAO = 1;
const CABECALHO = "x-ug-identidade";

// Dois minutos. Curto porque o bilhete e emitido por requisicao: nao existe
// motivo para durar mais do que a propria requisicao demora. Quanto mais curto,
// menos vale a pena capturar um.
const VALIDADE_S = 120;

// Relogios de servicos diferentes nao batem no milissegundo. Meio minuto cobre
// a diferenca sem alargar de verdade a validade.
const TOLERANCIA_S = 30;

// A chave de assinatura. Se UG_ASSINATURA_SEGREDO existir, e ela — e ai o
// segredo que assina NAO e o mesmo que viaja no x-ug-key, que e o desenho bom.
// Sem ela, deriva da CORE_INTERNAL_KEY: assim a correcao entra sem depender de
// cadastrar variavel em cinco servicos no mesmo dia. Derivar, e nao usar a
// chave crua, evita que o mesmo valor sirva para dois propositos diferentes.
function chaveDeAssinatura(env = process.env) {
  const dedicada = env.UG_ASSINATURA_SEGREDO || "";
  if (dedicada) return Buffer.from(dedicada, "utf8");

  const base = env.CORE_INTERNAL_KEY || "";
  if (!base) return null;
  return crypto.createHmac("sha256", base).update("ug-identidade-v1").digest();
}

// Quais chaves o VERIFICADOR aceita.
//
// Havendo segredo dedicado, so ele vale — e essa e a diferenca que fecha o
// assunto: a chave derivada da CORE_INTERNAL_KEY deixa de ser aceita, entao
// quem tiver o segredo que viajava no `x-ug-key` nao consegue mais emitir
// bilhete. Durante a troca (01/09/2026) as duas valeram ao mesmo tempo, de
// proposito, para dar para cadastrar a nova um servico por vez; terminada a
// troca, a sobreposicao vira exatamente o furo que ela ajudou a fechar.
//
// Sem segredo dedicado sobra a derivada. Isso mantem o ambiente local rodando
// (`dev-local.js` nao cadastra segredo nenhum) e um servico que nunca recebeu a
// variavel continua funcionando — desde que a Fachada tambem nao a tenha. Se so
// um dos lados tiver, o bilhete e recusado: barulhento, e nao silenciosamente
// permissivo.
function chavesQueAceito(env = process.env) {
  const dedicada = env.UG_ASSINATURA_SEGREDO || "";
  if (dedicada) return [Buffer.from(dedicada, "utf8")];

  const base = env.CORE_INTERNAL_KEY || "";
  if (!base) return [];
  return [crypto.createHmac("sha256", base).update("ug-identidade-v1").digest()];
}

const b64url = (buf) => Buffer.from(buf).toString("base64")
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const deB64url = (txt) => Buffer.from(
  String(txt).replace(/-/g, "+").replace(/_/g, "/"), "base64");

function selo(corpoCodificado, chave) {
  return b64url(crypto.createHmac("sha256", chave).update(corpoCodificado).digest());
}

// ---------------------------------------------------------------------------
// Lado da Fachada
// ---------------------------------------------------------------------------

// `modulo` entra no bilhete de proposito: sem isso, um bilhete pego numa
// requisicao para o CRM serviria para entrar na Precificacao como a mesma
// pessoa. Com isso, cada bilhete so vale na porta para a qual foi emitido.
function assinar(dados, opcoes = {}) {
  const chave = opcoes.chave || chaveDeAssinatura(opcoes.env);
  if (!chave) return null;

  const agora = Math.floor((opcoes.agoraMs || Date.now()) / 1000);
  const corpo = {
    v: VERSAO,
    id: String(dados.id || ""),
    nome: String(dados.nome || ""),
    email: String(dados.email || ""),
    papel: String(dados.papel || ""),
    // Onde a pessoa esta lotada. Vai assinado junto com o resto porque decide
    // acesso do outro lado: a Gestao de Tarefas poe a pessoa na equipe de mesmo
    // nome, e equipe la define o que se enxerga.
    dep: String(dados.departamento || ""),
    super: Boolean(dados.superAdmin),
    mod: String(dados.modulo || ""),
    iat: agora,
    exp: agora + (opcoes.validadeS || VALIDADE_S),
    jti: crypto.randomBytes(12).toString("hex"),
  };
  const codificado = b64url(JSON.stringify(corpo));
  return codificado + "." + selo(codificado, chave);
}

// ---------------------------------------------------------------------------
// Lado do modulo
// ---------------------------------------------------------------------------

// Devolve o corpo do bilhete, ou null. NUNCA devolve "quase valido": qualquer
// duvida — formato, assinatura, prazo, modulo errado, repetido — e null, e quem
// chamou trata como visitante anonimo.
//
// `vistos` guarda os numeros de bilhete ja usados, para um bilhete capturado
// nao poder ser reapresentado dentro dos dois minutos de validade. E memoria do
// processo: em servico com varias instancias, cada uma tem a sua. Ainda assim
// vale — encurta muito a janela de reuso — e nao ha estado compartilhado para
// manter.
const vistos = new Map();
const TETO_VISTOS = 5000;

function limparVistos(agora) {
  for (const [k, ate] of vistos) if (ate < agora) vistos.delete(k);
  // Se ainda estiver cheio, a protecao contra repeticao cede — nunca o
  // atendimento. Bloquear requisicao legitima por falta de memoria seria trocar
  // um problema raro por uma queda geral.
  if (vistos.size > TETO_VISTOS) vistos.clear();
}

function verificar(cru, opcoes = {}) {
  // `chaves` (lista) e o caminho normal; `chave` (uma so) continua aceito para
  // quem chama de fora com uma chave especifica em maos — os testes, por exemplo.
  const chaves = opcoes.chaves
    || (opcoes.chave ? [opcoes.chave] : chavesQueAceito(opcoes.env));
  if (!chaves.length || !cru) return null;

  const partes = String(cru).split(".");
  if (partes.length !== 2) return null;

  const [codificado, assinaturaRecebida] = partes;
  const a = Buffer.from(assinaturaRecebida);

  // Basta UMA das chaves aceitas bater. Percorre todas mesmo depois de achar,
  // para o tempo de resposta nao contar quantas foram tentadas.
  let confere = false;
  for (const chave of chaves) {
    const b = Buffer.from(selo(codificado, chave));
    // Comparacao de tempo constante: comparar com === vaza, pelo tempo de
    // resposta, quantos caracteres iniciais estao certos.
    if (a.length === b.length && crypto.timingSafeEqual(a, b)) confere = true;
  }
  if (!confere) return null;

  let corpo;
  try {
    corpo = JSON.parse(deB64url(codificado).toString("utf8"));
  } catch (e) {
    return null;
  }
  if (!corpo || corpo.v !== VERSAO || !corpo.id) return null;

  const agora = Math.floor((opcoes.agoraMs || Date.now()) / 1000);
  if (!Number.isFinite(corpo.exp) || agora > corpo.exp + TOLERANCIA_S) return null;
  if (!Number.isFinite(corpo.iat) || corpo.iat > agora + TOLERANCIA_S) return null;

  // O modulo so aceita bilhete emitido para ele. Sem UG_MODULO configurado a
  // conferencia nao acontece — o bilhete continua valido, so nao esta preso a
  // uma porta. Configurar e o certo; nao configurar nao derruba ninguem.
  const meuModulo = opcoes.modulo !== undefined
    ? opcoes.modulo
    : ((opcoes.env || process.env).UG_MODULO || "");
  if (meuModulo && corpo.mod && corpo.mod !== meuModulo) return null;

  if (opcoes.semRepeticao !== false && corpo.jti) {
    limparVistos(agora);
    if (vistos.has(corpo.jti)) return null;
    vistos.set(corpo.jti, corpo.exp + TOLERANCIA_S);
  }

  return corpo;
}

module.exports = {
  assinar, verificar, chaveDeAssinatura, chavesQueAceito,
  CABECALHO, VERSAO, VALIDADE_S, TOLERANCIA_S,
};
