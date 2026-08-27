"use strict";

// ============================================================================
// Por que o login no Nexti esta falhando?
// ----------------------------------------------------------------------------
//     railway ssh --service core "node scripts/nexti-login.js"
//
// NUNCA IMPRIME A CREDENCIAL. Mostra tamanho e se ha espaco sobrando — o
// bastante para achar erro de copiar e colar sem expor o segredo em log.
//
// POR QUE ELE EXISTE
// A documentacao do Nexti manda as credenciais na query string:
//     /security/oauth/token?grant_type=client_credentials&client_id=&client_secret=
//
// So que "/security/oauth/token" e a assinatura do Spring Security OAuth, que
// por padrao exige as credenciais no cabecalho HTTP Basic (RFC 6749 §2.3.1) e
// responde 401 a quem as manda por query string. Ou seja: a documentacao pode
// estar descrevendo o que era, nao o que e.
//
// Este script tenta as DUAS formas, uma vez cada, e mostra o que voltou. Duas
// tentativas, nao um laco: login errado repetido e a receita para a conta ser
// bloqueada do outro lado.
//
// As tres explicacoes possiveis para o 401, e como distingui-las:
//   - forma errada de mandar  -> a outra tentativa funciona
//   - credencial errada       -> as duas falham com invalid_client
//   - API nao liberada no contrato -> as duas falham; ai e pergunta comercial
// ============================================================================

const BASE = process.env.NEXTI_URL || "https://api.nexti.com";
const ID = process.env.NEXTI_CLIENT_ID || "";
const SEGREDO = process.env.NEXTI_CLIENT_SECRET || "";

function conferirValor(nome, v) {
  if (!v) return console.log(`  ${nome}: AUSENTE`);
  const limpo = v.trim();
  const avisos = [];
  if (limpo !== v) avisos.push("TEM ESPACO/QUEBRA DE LINHA SOBRANDO");
  if (/^["']|["']$/.test(limpo)) avisos.push("TEM ASPAS — provavelmente coladas junto");
  console.log(`  ${nome}: ${v.length} caracteres` +
              (avisos.length ? "  <<< " + avisos.join(" e ") : "  (sem espaco sobrando)"));
}

async function tentar(rotulo, montar) {
  console.log("");
  console.log("--- " + rotulo + " ---");
  const { url, opcoes } = montar();
  let r;
  try {
    r = await fetch(url, opcoes);
  } catch (e) {
    return console.log("  nao conectou: " + e.message);
  }
  const corpo = await r.text();
  console.log("  HTTP " + r.status);
  const desafio = r.headers.get("www-authenticate");
  if (desafio) console.log("  WWW-Authenticate: " + desafio);
  // O corpo de um endpoint de token nao carrega segredo nosso — carrega o
  // motivo da recusa, que e o que interessa. Em caso de sucesso, so mostramos
  // que veio token, nunca o token.
  if (r.ok) {
    let d = {};
    try { d = JSON.parse(corpo); } catch (e) {}
    console.log("  FUNCIONOU. Veio access_token: " + (d.access_token ? "sim" : "NAO") +
                (d.expires_in ? `, vale ${d.expires_in}s` : "") +
                (d.token_type ? `, tipo ${d.token_type}` : ""));
    return true;
  }
  console.log("  resposta: " + corpo.slice(0, 300).replace(/\s+/g, " "));
  return false;
}

(async () => {
  console.log("=== A CREDENCIAL EM SI ===");
  conferirValor("NEXTI_CLIENT_ID    ", ID);
  conferirValor("NEXTI_CLIENT_SECRET", SEGREDO);
  if (!ID || !SEGREDO) process.exit(1);

  const id = ID.trim(), segredo = SEGREDO.trim();
  const basico = Buffer.from(`${id}:${segredo}`).toString("base64");

  // 1) Como a documentacao manda.
  const comoDocumentado = await tentar(
    "1. query string  (como a documentacao do Nexti manda)",
    () => ({
      url: `${BASE}/security/oauth/token?grant_type=client_credentials` +
           `&client_id=${encodeURIComponent(id)}&client_secret=${encodeURIComponent(segredo)}`,
      opcoes: { method: "POST" },
    })
  );

  // 2) Como manda o padrao OAuth2, que e o que o Spring espera.
  const comoPadrao = comoDocumentado ? null : await tentar(
    "2. cabecalho Basic  (o padrao OAuth2 / Spring Security)",
    () => ({
      url: `${BASE}/security/oauth/token`,
      opcoes: {
        method: "POST",
        headers: {
          Authorization: "Basic " + basico,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: "grant_type=client_credentials",
      },
    })
  );

  console.log("");
  console.log("=== CONCLUSAO ===");
  if (comoDocumentado) {
    console.log("  A forma documentada funciona. O 401 de antes era outra coisa.");
  } else if (comoPadrao) {
    console.log("  E a forma de mandar: o Nexti quer HTTP Basic, nao query string.");
    console.log("  A documentacao dele esta desatualizada nesse ponto.");
    console.log("  -> ajustar pegarToken() em core/nexti.js para usar Basic.");
  } else {
    console.log("  As DUAS formas falharam. Entao nao e a forma de mandar.");
    console.log("  Sobram duas explicacoes:");
    console.log("    a) a credencial esta errada (regerar em Configuracoes > API de Integracao)");
    console.log("    b) a API nao esta liberada no contrato de voces");
    console.log("  A resposta acima costuma dizer qual. Se disser so 'invalid_client',");
    console.log("  e pergunta para o suporte do Nexti.");
  }
})().catch((e) => { console.error("ERRO:", e && e.message); process.exit(1); });
