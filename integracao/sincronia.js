"use strict";

// ============================================================================
// UniGestao — pacote de sincronia assinado (Core -> modulo)
// ----------------------------------------------------------------------------
// O bilhete de identidade (identidade.js) diz QUEM ESTA PEDINDO, a cada
// requisicao de uma pessoa. Este arquivo cobre o outro sentido: o Core avisando
// um modulo, por conta propria, de quem EXISTE — sem ninguem estar navegando.
//
// POR QUE ISSO EXISTE
// O CRM so conhecia a pessoa depois da primeira visita dela. Ate la ela nao
// aparecia em lista nenhuma, e nao dava para passar um negocio a um vendedor
// recem-contratado antes de ele abrir o sistema (13/09/2026).
//
// COMO SE CONFIA NO PACOTE
// O corpo inteiro e lacrado por HMAC, com prazo curto, numero unico e o modulo
// de destino dentro — igual ao bilhete. A chave e DERIVADA do mesmo segredo de
// assinatura com outro rotulo ("ug-sincronia-v1"): assim um pacote de sincronia
// nunca serve como bilhete de identidade, nem o contrario, mesmo os dois vindo
// do mesmo segredo.
//
// Copia byte a byte no modulo que recebe (CRM: sincronia.js na raiz).
// ============================================================================

const crypto = require("crypto");

const CABECALHO = "x-ug-sincronia";
const VERSAO = 1;
const VALIDADE_S = 60;
const TOLERANCIA_S = 30;
const ROTULO = "ug-sincronia-v1";

// A base e a mesma que o identidade.js usa: o segredo dedicado, ou — so no
// ambiente local, onde ninguem cadastra segredo — a derivada da CORE_INTERNAL_KEY.
function chaveDeSincronia(env = process.env) {
  const dedicada = env.UG_ASSINATURA_SEGREDO || "";
  let base;
  if (dedicada) {
    base = Buffer.from(dedicada, "utf8");
  } else if (env.CORE_INTERNAL_KEY) {
    base = crypto.createHmac("sha256", env.CORE_INTERNAL_KEY).update("ug-identidade-v1").digest();
  } else {
    return null;
  }
  return crypto.createHmac("sha256", base).update(ROTULO).digest();
}

const selo = (texto, chave) =>
  crypto.createHmac("sha256", chave).update(texto, "utf8").digest("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

// Devolve { corpo, assinatura } — o corpo vai como texto EXATO no POST, porque
// a assinatura e sobre esses bytes. Reformatar o JSON no caminho invalida.
function assinarPacote(modulo, dados, opcoes = {}) {
  const chave = chaveDeSincronia(opcoes.env);
  if (!chave) return null;
  const agora = Math.floor((opcoes.agoraMs || Date.now()) / 1000);
  const corpo = JSON.stringify({
    v: VERSAO,
    mod: String(modulo),
    iat: agora,
    exp: agora + VALIDADE_S,
    jti: crypto.randomBytes(12).toString("hex"),
    dados,
  });
  return { corpo, assinatura: selo(corpo, chave) };
}

// Numeros de pacote ja usados, para um pacote capturado nao ser reapresentado
// dentro do prazo. Memoria do processo — basta para encurtar a janela.
const vistos = new Map();

// Devolve `dados` ou null. Qualquer duvida e null.
function conferirPacote(corpo, assinatura, modulo, opcoes = {}) {
  const chave = chaveDeSincronia(opcoes.env);
  if (!chave || typeof corpo !== "string" || !assinatura) return null;

  const a = Buffer.from(String(assinatura));
  const b = Buffer.from(selo(corpo, chave));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

  let p;
  try {
    p = JSON.parse(corpo);
  } catch (e) {
    return null;
  }
  if (!p || p.v !== VERSAO || p.mod !== modulo) return null;

  const agora = Math.floor((opcoes.agoraMs || Date.now()) / 1000);
  if (!Number.isFinite(p.exp) || agora > p.exp + TOLERANCIA_S) return null;
  if (!Number.isFinite(p.iat) || p.iat > agora + TOLERANCIA_S) return null;

  for (const [k, ate] of vistos) if (ate < agora) vistos.delete(k);
  if (!p.jti || vistos.has(p.jti)) return null;
  vistos.set(p.jti, p.exp + TOLERANCIA_S);

  return p.dados;
}

module.exports = { assinarPacote, conferirPacote, chaveDeSincronia, CABECALHO };
