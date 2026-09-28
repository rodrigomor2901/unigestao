"use strict";

// As DUAS tabelas de modulos precisam concordar.
//
// O cadastro (core/modulos.js) diz o que aparece no portal e quem pode entrar.
// A Fachada (fachada/server.js) tem a propria tabela, com os destinos — ela e
// publicada sozinha, com a pasta na raiz do container, e nao alcanca o core.
//
// Quando as duas discordam, o modulo aparece no portal e a pessoa que clica
// recebe "Cannot GET /<modulo>/": a Fachada nao reconhece o prefixo, entao
// manda a requisicao para o Core, que nao tem essa tela. Aconteceu com o
// modulo de disparos em 28/09/2026 — passou nos testes, passou no deploy, e so
// apareceu clicando.
//
// Este teste le o codigo-fonte da Fachada porque o arquivo sobe o servidor ao
// ser carregado: da para conferir a tabela sem abrir porta nenhuma.

const fs = require("fs");
const path = require("path");
const modulos = require("../core/modulos.js");

let falhas = 0;
function ok(c, m) { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; }

const fonte = fs.readFileSync(path.join(__dirname, "..", "fachada", "server.js"), "utf8");

// So o bloco da tabela, para nao casar com o nome do modulo em comentario.
const bloco = (fonte.match(/const MODULOS = \{[\s\S]*?\n\};/) || [""])[0];
ok(bloco.length > 0, "a tabela de modulos da Fachada foi encontrada");

console.log("\n=== TODO MODULO DO PORTAL TEM ROTA NA FACHADA ===");
for (const m of modulos.listar()) {
  // Sistema de terceiro nao passa pela Fachada: abre no endereco do fornecedor.
  if (modulos.ehExterno(m.id)) {
    console.log(`  --     ${m.id}: e de terceiro, nao precisa de rota`);
    continue;
  }
  ok(new RegExp("(^|\\n)\\s*" + m.id + "\\s*:").test(bloco),
     `${m.id}: a Fachada sabe encaminhar /${m.id}`);
}

console.log("\n=== A BASE DO CADASTRO BATE COM O PREFIXO DA ROTA ===");
// A Fachada usa o id como prefixo da URL. Se o cadastro declarar uma base
// diferente, o menu aponta para um lugar que nao existe.
for (const m of modulos.listar()) {
  if (modulos.ehExterno(m.id)) continue;
  ok(m.base === "/" + m.id, `${m.id}: base "${m.base}" e o proprio id`);
}

console.log("\n=== DISPAROS ACOMPANHA A PRECIFICACAO ===");
// A Precificacao e partida em dois servicos: a tela num, a API noutro. Sem a
// mesma divisao, o navegador chamaria a API no dominio dela, fora da Fachada,
// e os cabecalhos de identidade nunca chegariam la.
const trechoDisparos = (bloco.match(/\n\s*disparos:\s*\{[\s\S]*?\n\s*\},/) || [""])[0];
ok(/URL_PRECIFICACAO\b/.test(trechoDisparos),
   "sem URL propria, a tela cai no destino da precificacao");
ok(/URL_PRECIFICACAO_API\b/.test(trechoDisparos),
   "e a API tambem — e o mesmo servico partido em dois");

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
process.exitCode = falhas === 0 ? 0 : 1;
