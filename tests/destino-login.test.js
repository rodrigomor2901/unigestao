// A regra do "para onde ir depois de entrar".
//
// Quem clica em "Ver no sistema" num e-mail de notificacao chega ao login com
// ?ir=/tarefas/... e precisa voltar para la. Mas o parametro e digitavel por
// qualquer um: sem um corte firme, o portal viraria trampolim para levar gente
// a um site qualquer — com o dominio do login dando credibilidade ao golpe.
//
// A mesma regra vale nos dois lados (Fachada escreve, tela de login le), e por
// isso mora aqui, num lugar so, em vez de duas expressoes parecidas espalhadas.
const fs = require("fs");
const path = require("path");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// Le a regra COMO ELA ESTA no codigo, em vez de repetir a expressao aqui.
//
// A mesma regra existe em dois arquivos, e nao da para compartilhar: a Fachada
// e publicada com a propria pasta na raiz do container e nao alcanca core/ nem
// public/ (ver o teste em fachada.test.js). Entao o jeito de garantir que as
// duas copias concordam e ler as duas do disco e submeter as mesmas entradas.
//
// Isto tambem pega o erro de escape: uma das copias ja nasceu como
// /^/[^/\]/ — sintaxe invalida, que teria quebrado a tela de login inteira.
function regraDe(arquivo) {
  const fonte = fs.readFileSync(path.join(__dirname, "..", arquivo), "utf8");
  const m = fonte.match(/(\/\^\\\/\[[^\n]*?\/)\.test\(/);
  if (!m) throw new Error("nao achei a regra do destino em " + arquivo);
  const corpo = m[1].slice(1, -1);
  return new RegExp(corpo);
}

const CASOS = [
  ["/tarefas/tarefa/123", true,  "caminho interno normal"],
  ["/eventos/",           true,  "raiz de um modulo"],
  ["//evil.com",          false, "protocolo-relativo levaria para fora"],
  ["/\\evil.com",         false, "contrabarra: parte dos navegadores le como //"],
  ["https://evil.com",    false, "endereco completo"],
  ["javascript:alert(1)", false, "esquema javascript"],
  ["",                    false, "vazio"],
  ["tarefas",             false, "sem barra no comeco"],
];

for (const arquivo of ["fachada/server.js", "public/login.html"]) {
  console.log("\n=== " + arquivo + " ===");
  const re = regraDe(arquivo);
  for (const [entrada, esperado, porque] of CASOS) {
    ok(re.test(entrada) === esperado,
       JSON.stringify(entrada).padEnd(22) + (esperado ? "aceito" : "recusado") + " — " + porque);
  }
}

console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
process.exit(falhas === 0 ? 0 : 1);
