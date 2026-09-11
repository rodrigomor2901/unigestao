// O envio de e-mail do Core pelo Brevo.
//
// POR QUE ESTE TESTE EXISTE
// O Grupo trocou o SendGrid pelo Brevo e o Core ficou para tras, mandando com
// uma chave desativada. Todo cadastro novo saiu sem e-mail — e o administrador
// leu, em verde, como se fosse sucesso, um erro cru em ingles (11/09/2026).
//
// Este arquivo confere tres coisas, sem mandar e-mail de verdade (o fetch e de
// mentira):
//   1. o pedido sai no formato que o Brevo espera
//   2. cada recusa do Brevo vira uma frase que diz o que fazer
//   3. um Brevo mudo nao prende a tela — o envio tem prazo
//
// Roda sozinho, sem banco e sem servidor:  node tests/email-brevo.test.js
"use strict";

const path = require("path");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// O modulo le a chave na carga, entao o ambiente vem antes do require.
function carregar(env) {
  delete process.env.EMAIL_ARQUIVO;
  Object.assign(process.env, env);
  const arq = path.join(__dirname, "..", "core", "email.js");
  delete require.cache[require.resolve(arq)];
  return require(arq);
}

// Um Brevo de mentira: guarda o que recebeu e responde o que o teste mandar.
function brevoFalso(status, corpo) {
  const chamadas = [];
  global.fetch = async (url, opcoes) => {
    chamadas.push({ url, opcoes, corpo: JSON.parse(opcoes.body) });
    return { ok: status >= 200 && status < 300, status, text: async () => corpo || "" };
  };
  return chamadas;
}

(async () => {
  const fetchOriginal = global.fetch;

  console.log("\n=== O PEDIDO SAI NO FORMATO DO BREVO ===");
  {
    const email = carregar({ BREVO_API_KEY: "chave-de-teste", EMAIL_FROM: "naoresponda@uniseter.com.br" });
    const chamadas = brevoFalso(201, '{"messageId":"<x@brevo>"}');
    const r = await email.enviar("fulano@uniseter.com", "Seu acesso", "<p>oi</p>");

    ok(r.ok === true, "Brevo aceitou (201) -> o envio conta como feito");
    const c = chamadas[0];
    ok(c && c.url === "https://api.brevo.com/v3/smtp/email", "vai para o endereco do Brevo");
    ok(c && c.opcoes.headers["api-key"] === "chave-de-teste", "com a chave no cabecalho api-key");
    ok(c && c.corpo.sender.email === "naoresponda@uniseter.com.br" && c.corpo.sender.name === "UniGestão",
       "remetente do dominio autenticado, com o nome do portal");
    ok(c && c.corpo.to[0].email === "fulano@uniseter.com" && c.corpo.htmlContent === "<p>oi</p>",
       "destinatario e mensagem nos campos que o Brevo le");
    ok(email.modo() === "envio", "com a chave, o Core se declara em modo de envio");
  }

  console.log("\n=== CADA RECUSA VIRA UMA FRASE QUE DIZ O QUE FAZER ===");
  {
    const email = carregar({ BREVO_API_KEY: "chave-errada" });
    brevoFalso(401, '{"code":"unauthorized","message":"Key not found"}');
    const r = await email.enviar("fulano@uniseter.com", "x", "<p>x</p>");
    ok(r.ok === false && r.status === 401, "chave errada -> falha, com o status");
    ok(/BREVO_API_KEY/.test(r.erro) && !/Key not found/.test(r.erro),
       "e a frase aponta a chave no Railway, nao o ingles do Brevo  <-- o que se leu na tela");
  }
  {
    const email = carregar({ BREVO_API_KEY: "chave" });
    brevoFalso(400, '{"code":"invalid_parameter","message":"sender is not valid"}');
    const r = await email.enviar("fulano@uniseter.com", "x", "<p>x</p>");
    ok(/remetente/.test(r.erro), "remetente fora do dominio autenticado -> diz que e o remetente");
  }
  {
    const email = carregar({ BREVO_API_KEY: "chave" });
    brevoFalso(429, "{}");
    const r = await email.enviar("fulano@uniseter.com", "x", "<p>x</p>");
    ok(/limite/.test(r.erro), "limite diario estourado -> diz que acabou por hoje");
  }
  {
    const email = carregar({ BREVO_API_KEY: "" });
    const chamadas = brevoFalso(201, "");
    const r = await email.enviar("fulano@uniseter.com", "x", "<p>x</p>");
    ok(r.ok === false && chamadas.length === 0, "sem chave, nem tenta sair");
    ok(/BREVO_API_KEY/.test(r.erro), "e diz qual variavel falta");
  }

  console.log("\n=== BREVO MUDO NAO PRENDE A TELA ===");
  {
    const email = carregar({ BREVO_API_KEY: "chave" });
    let prazoPedido = false;
    global.fetch = async (url, opcoes) => {
      prazoPedido = Boolean(opcoes.signal);
      const erro = new Error("tempo"); erro.name = "TimeoutError"; throw erro;
    };
    const r = await email.enviar("fulano@uniseter.com", "x", "<p>x</p>");
    ok(prazoPedido, "o envio sai com prazo (signal)  <-- sem ele, 'Nova pessoa' ficaria girando");
    ok(r.ok === false && /não respondeu/.test(r.erro), "e o tempo esgotado vira falha explicada, nao excecao");
  }

  global.fetch = fetchOriginal;
  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exitCode = falhas === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
