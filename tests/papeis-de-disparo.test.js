"use strict";

// O modulo de Disparos: mesma casa da Precificacao, outra porta.
//
// Os disparos nascem da precificacao e moram no banco dela, entao nao ha dois
// sistemas — ha dois ACESSOS para o mesmo. O que este arquivo protege e o que
// nao aparece em tela nenhuma quando quebra:
//
//   - o cartao do portal tem que dizer "Disparos", nao "Precificacao";
//   - os papeis daqui sao um CONTRATO com o outro sistema. Um nome que nao
//     existe do outro lado nao da erro: a pessoa entra e ve o sistema inteiro,
//     que e o oposto do que um acesso restrito deveria fazer. Ja aconteceu com
//     a Precificacao, cuja lista era ("admin","editor","consulta") — os tres
//     errados.
//
// Nao precisa de banco nem do Core no ar: le o cadastro de modulos.

const modulos = require("../core/modulos.js");

let falhas = 0;
function ok(c, m) { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; }

const disparos = modulos.listar().find((m) => m.id === "disparos");
const precificacao = modulos.listar().find((m) => m.id === "precificacao");

console.log("=== O MODULO EXISTE E TEM PORTA PROPRIA ===");
ok(Boolean(disparos), "o modulo de disparos esta ativo");
ok(disparos && disparos.base === "/disparos", "atende em /disparos");
ok(disparos && disparos.nome === "Disparos",
   'o cartao diz "Disparos" — antes dizia "Precificacao" e abria uma tela so');
ok(!modulos.ehExterno("disparos"),
   "e sistema nosso: recebe identidade assinada, como os demais");

console.log("\n=== OS DOIS PAPEIS ===");
for (const papel of ["comercial", "operacional"]) {
  ok(modulos.papelValido("disparos", papel), `"${papel}" pode ser atribuido`);
  const rotulo = modulos.rotuloDoPapel("disparos", papel);
  ok(typeof rotulo === "string" && rotulo !== papel, `"${papel}" aparece como "${rotulo}"`);
}
ok(!modulos.papelValido("disparos", "ADMIN"),
   "papel da Precificacao nao vale aqui — sao listas separadas");

console.log("\n=== APONTA PARA O MESMO SISTEMA ===");
// Sem isto o modulo existe no portal e responde "ainda nao foi conectado".
const antes = { d: process.env.URL_DISPAROS, p: process.env.URL_PRECIFICACAO };
delete process.env.URL_DISPAROS;
process.env.URL_PRECIFICACAO = "http://exemplo-precificacao";
delete require.cache[require.resolve("../core/modulos.js")];
const recarregado = require("../core/modulos.js");
ok(recarregado.get("disparos").interno === "http://exemplo-precificacao",
   "sem URL propria, cai na URL da precificacao — e o mesmo servico");
if (antes.d === undefined) delete process.env.URL_DISPAROS; else process.env.URL_DISPAROS = antes.d;
if (antes.p === undefined) delete process.env.URL_PRECIFICACAO; else process.env.URL_PRECIFICACAO = antes.p;
delete require.cache[require.resolve("../core/modulos.js")];

console.log("\n=== O ADMINISTRADOR GERAL NAO FICA TRANCADO ===");
ok(modulos.papelDeAdmin("disparos") === "comercial",
   "entra como comercial, que ve as duas versoes");
ok(modulos.papelDeAdmin("precificacao") === "ADMIN",
   "e a Precificacao continua ADMIN, inteira, pelo outro cartao");
// papelDeAdmin cai no PRIMEIRO papel quando o registro esta incoerente; um
// papel mais fechado nessa posicao trancaria o administrador geral.
ok(disparos && disparos.papeis[0] === "comercial",
   "o primeiro papel e o de maior alcance (rede de seguranca do papelDeAdmin)");

console.log("\n=== A PRECIFICACAO VOLTOU A TER SO OS PAPEIS DELA ===");
ok(precificacao && precificacao.papeis.length === 4,
   "quatro papeis, como antes");
for (const intruso of ["DISPARO_COMERCIAL", "DISPARO_OPERACIONAL"]) {
  ok(!modulos.papelValido("precificacao", intruso),
     `"${intruso}" saiu da lista da Precificacao — e um acesso, nao um nivel`);
}

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
process.exitCode = falhas === 0 ? 0 : 1;
