// A barra do portal pode cobrir o modal de um modulo?
//
// POR QUE ESTE TESTE EXISTE
// A barra nasceu com z-index 9999 — o reflexo de "quero que fique por cima de
// tudo". So que "tudo" incluiu os modais dos proprios modulos: no Precificacao,
// a barra tapava o topo da janela de editar cargo e o titulo do formulario
// sumia atras dela.
//
// Modal e modal: enquanto esta aberto, ele cobre a barra do portal. Para isso a
// barra precisa ficar ABAIXO dos modais e ACIMA do conteudo que rola — uma
// faixa estreita, medida no codigo dos seis sistemas (a tabela esta em
// fachada/server.js, junto do BARRA_CSS).
//
// Este teste guarda os dois lados dessa faixa. Se alguem voltar a subir a
// barra, o modal do Precificacao quebra de novo — e e este arquivo que avisa,
// em vez de a pessoa descobrir usando.
const fs = require("fs");
const path = require("path");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// O menor z-index de modal entre os seis sistemas. O Precificacao usa `z-50`
// do Tailwind em 26 telas; os outros ficam bem acima disso.
const MODAL_MAIS_BAIXO = 50;
// O maior z-index de coisa que NAO e modal e que tambem gruda no topo: a barra
// de acoes do Disparo, no Precificacao.
const GRUDADO_MAIS_ALTO = 40;

const fonte = fs.readFileSync(path.join(__dirname, "..", "fachada", "server.js"), "utf8");

(async () => {
  console.log("\n=== A BARRA FICA NA FAIXA CERTA ===");

  const css = (fonte.match(/const BARRA_CSS = `([\s\S]*?)`;/) || [])[1];
  ok(Boolean(css), "achei o CSS da barra em fachada/server.js");

  const regra = (css.match(/#ug-barra\{([^}]*)\}/) || [])[1] || "";
  const z = Number((regra.match(/z-index:\s*(\d+)/) || [])[1]);

  ok(Number.isFinite(z), `a barra declara um z-index (${z})`);
  ok(z < MODAL_MAIS_BAIXO,
     `${z} < ${MODAL_MAIS_BAIXO}: o modal de um modulo cobre a barra, como deve`);
  ok(z > GRUDADO_MAIS_ALTO,
     `${z} > ${GRUDADO_MAIS_ALTO}: a barra nao some sob o cabecalho proprio do modulo`);

  // Grudada no topo ela precisa ficar; o que mudou foi so a altura na pilha.
  ok(/position:\s*sticky/.test(regra), "e continua grudada no topo ao rolar a pagina");

  console.log("\n=== E O MOTIVO FICA ESCRITO ===");
  // Um numero solto no CSS vira alvo facil de "arredondar para 9999" na proxima
  // vez. A tabela ao lado dele e o que explica por que 45 e nao outro.
  const antes = fonte.slice(0, fonte.indexOf("const BARRA_CSS"));
  const comentario = antes.slice(-2000);
  ok(comentario.includes("Precificacao"),
     "o comentario cita os sistemas de onde os limites saíram");
  ok(/50/.test(comentario) && /40/.test(comentario),
     "e os dois limites aparecem escritos");

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
