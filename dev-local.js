"use strict";

// ============================================================================
// Ambiente de desenvolvimento local — sobe Core e Fachada juntos.
// Requer um PostgreSQL local. Para levantar um com Docker:
//
//   docker run -d --name unigestao-pg -e POSTGRES_PASSWORD=teste \
//     -e POSTGRES_DB=unigestao -p 55987:5432 postgres:16-alpine
//
// Depois:  node dev-local.js   e abra  http://localhost:8080
// Em producao nada disto e usado: as variaveis vem do painel do Railway.
// ============================================================================

const { fork } = require("child_process");
const path = require("path");

const env = {
  ...process.env,
  DATABASE_URL: process.env.DATABASE_URL || "postgres://postgres:teste@localhost:55987/unigestao",
  NODE_ENV: "development",
  CORE_INTERNAL_KEY: process.env.CORE_INTERNAL_KEY || "chave-de-desenvolvimento",
  BOOTSTRAP_NOME: "Rodrigo Moraes",
  BOOTSTRAP_EMAIL: "rodrigo.moraes@uniseter.com",
  BOOTSTRAP_SENHA: "Uniseter@2026",
  SESSAO_HORAS: "10",
};

const core = fork(path.join(__dirname, "server.js"), [], {
  env: { ...env, PORT: "3000" },
  stdio: "inherit",
});

const fachada = fork(path.join(__dirname, "fachada", "server.js"), [], {
  env: {
    ...env,
    PORT: "8080",
    URL_CORE: "http://localhost:3000",
    // Em desenvolvimento espera-se o Lancamento de Extra na 3200. Em producao
    // quem manda e a variavel do Railway, definida no servico da Fachada.
    URL_OPERACIONAL: process.env.URL_OPERACIONAL || "http://localhost:3200",
    URL_CRM: process.env.URL_CRM || "http://localhost:3300",
    URL_DOCUMENTOS: process.env.URL_DOCUMENTOS || "http://localhost:3400",
  },
  stdio: "inherit",
});

function encerrar() {
  core.kill();
  fachada.kill();
  process.exit(0);
}
process.on("SIGINT", encerrar);
process.on("SIGTERM", encerrar);
