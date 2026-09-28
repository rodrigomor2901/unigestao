"use strict";

// Os papeis de acesso restrito ao modulo de disparos da Precificacao.
//
// A lista de papeis daqui e um CONTRATO com o outro sistema: o Core manda o
// papel, e la ele e conferido contra o enum UserRole. Um nome que nao existe
// do outro lado nao da erro visivel -- a pessoa entra como "Consulta" e ve o
// sistema inteiro, que e o oposto do que o papel restrito deveria fazer.
// Ja aconteceu: a lista antiga era ("admin","editor","consulta") e os tres
// estavam errados.
//
// Este teste nao precisa de banco nem do Core no ar: le o cadastro de modulos.

const modulos = require("../core/modulos.js");

let falhas = 0;
function ok(c, m) { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; }

const RESTRITOS = ["DISPARO_COMERCIAL", "DISPARO_OPERACIONAL"];

console.log("=== OS PAPEIS DE DISPARO EXISTEM NA PRECIFICACAO ===");
for (const papel of RESTRITOS) {
  ok(modulos.papelValido("precificacao", papel),
     `"${papel}" pode ser atribuido no modulo de precificacao`);
}

console.log("\n=== E TEM NOME LEGIVEL NA TELA ===");
for (const papel of RESTRITOS) {
  const rotulo = modulos.rotuloDoPapel
    ? modulos.rotuloDoPapel("precificacao", papel)
    : (modulos.listar().find(m => m.id === "precificacao") || {}).rotulos?.[papel];
  ok(typeof rotulo === "string" && rotulo.length > 0 && rotulo !== papel,
     `"${papel}" aparece como "${rotulo}"`);
}

console.log("\n=== SEM MEXER NO QUE JA EXISTIA ===");
for (const papel of ["ADMIN", "MANAGER", "ANALYST", "VIEWER"]) {
  ok(modulos.papelValido("precificacao", papel), `"${papel}" continua valido`);
}
ok(modulos.papelDeAdmin("precificacao") === "ADMIN",
   "o administrador geral continua entrando como ADMIN, nao como papel restrito");

// Papel restrito nao e o primeiro da lista: papelDeAdmin cai no primeiro item
// quando o registro esta incoerente, e um restrito ali trancaria o
// administrador geral dentro dos disparos.
const lista = (modulos.listar().find(m => m.id === "precificacao") || {}).papeis || [];
ok(!RESTRITOS.includes(lista[0]),
   "o primeiro papel da lista nao e restrito (rede de seguranca do papelDeAdmin)");

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
process.exitCode = falhas === 0 ? 0 : 1;
