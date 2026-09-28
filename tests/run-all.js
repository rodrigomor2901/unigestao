"use strict";

// Roda todos os testes em sequencia.
// Exige o Core no ar (node dev-local.js) e o PostgreSQL de desenvolvimento.
//   npm test

const { spawnSync } = require("child_process");
const path = require("path");

// modulo-operacional.test.js sobe o Lancamento de Extra de verdade e espera o
// cache de sessao da Fachada expirar (30s), entao demora mais que os outros.
const testes = [
  "permissao.test.js",
  "dois-fatores.test.js",
  "senha-provisoria.test.js",
  "senha-esqueci.test.js",
  "reenviar-convite.test.js",
  "bloqueio-login.test.js",
  "papel-admin.test.js",
  "papeis-de-disparo.test.js",
  "aviso-email.test.js",
  "email-brevo.test.js",
  "importacao-partida.test.js",
  "agenda.test.js",
  "mural.test.js",
  "mural-edicao.test.js",
  "tela-inicial.test.js",
  "destino-login.test.js",
  "shim-links.test.js",
  "modulo-externo.test.js",
  "barra-modal.test.js",
  "impressao.test.js",
  "nexti.test.js",
  "checklists.test.js",
  "chat.test.js",
  "chat-aviso.test.js",
  "chat-balao.test.js",
  "identidade-assinada.test.js",
  "sincronia-crm.test.js",
  "fachada.test.js",
  "modulo-operacional.test.js",
];
let falhou = false;

for (const t of testes) {
  console.log("\n############ " + t + " ############");
  const r = spawnSync(process.execPath, [path.join(__dirname, t)], { stdio: "inherit" });
  if (r.status !== 0) falhou = true;
}

console.log("\n" + (falhou ? "HOUVE FALHAS" : "TUDO VERDE"));
process.exit(falhou ? 1 : 0);
