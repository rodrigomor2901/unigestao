// O mural: comunicados da empresa, com curtida, comentario, imagem, pop-up e
// historico de edicao.
//
// O que este teste protege, em ordem de importancia:
//   1. quem publica: administrador geral e quem for marcado como autor
//   2. quem apaga comentario: o autor dele, quem publicou, ou o admin
//   3. editar deixa rastro — quem, quando, e o que estava escrito antes
//   4. o pop-up aparece uma vez por pessoa e nao volta
//   5. curtir liga e desliga; lido e por pessoa
//   6. nada expira: o mural e historico
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const CORE = "http://localhost:3000";
const CONEXAO = "postgres://postgres:teste@localhost:55987/unigestao";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM login_tentativas");
  await pool.query("DELETE FROM avisos WHERE titulo LIKE 'MuralTeste%'");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'mural.%@uniseter.com'");

  async function criar(email, { superAdmin = false, autor = false } = {}) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await pool.query(
      `INSERT INTO usuarios (id,nome,email,senha,super_admin,mural_autor)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, "Mural " + email.split("@")[0], email, auth.gerarHash("SenhaTeste@123"), superAdmin, autor]
    );
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO sessoes (token,usuario_id,expira_em) VALUES ($1,$2,NOW() + INTERVAL '1 hour')",
      [token, id]
    );
    return { id, token };
  }
  const C = (t) => ({ headers: { cookie: "unigestao_sessao=" + t } });
  const J = (t) => ({ headers: { cookie: "unigestao_sessao=" + t, "Content-Type": "application/json" } });
  const post = (url, t, corpo) =>
    fetch(CORE + url, { method: "POST", ...J(t), body: JSON.stringify(corpo || {}) });

  const chefe = await criar("mural.chefe@uniseter.com", { superAdmin: true });
  const marketing = await criar("mural.marketing@uniseter.com", { autor: true });
  const gente = await criar("mural.gente@uniseter.com");

  console.log("\n=== QUEM PUBLICA ===");
  ok((await post("/api/mural", gente.token, { titulo: "MuralTeste nao" })).status === 403,
     "quem nao e admin nem autor -> 403");
  ok((await post("/api/mural", marketing.token, { titulo: "MuralTeste do marketing" })).status === 200,
     "quem foi marcado como autor publica");
  const doChefe = await (await post("/api/mural", chefe.token, {
    titulo: "MuralTeste do chefe", texto: "Texto original.", tipo: "mudanca" })).json();
  ok(doChefe.ok === true, "e o administrador geral tambem");

  const eu = await (await fetch(`${CORE}/api/eu`, C(gente.token))).json();
  ok(eu.usuario.podePublicarMural === false, "a tela sabe que essa pessoa nao publica");
  const euAutor = await (await fetch(`${CORE}/api/eu`, C(marketing.token))).json();
  ok(euAutor.usuario.podePublicarMural === true, "e sabe que a outra publica");

  console.log("\n=== TODO MUNDO LE, NADA EXPIRA ===");
  const lista = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  ok(lista.publicacoes.length >= 2, "quem nao publica enxerga o mural inteiro");
  ok(lista.publicacoes.some((p) => p.titulo === "MuralTeste do chefe"), "com as publicacoes recentes");
  ok(typeof lista.total === "number", "e a contagem total, para paginar o historico");

  console.log("\n=== CURTIR LIGA E DESLIGA ===");
  const c1 = await (await post(`/api/mural/${doChefe.id}/curtir`, gente.token)).json();
  ok(c1.curti === true && c1.curtidas === 1, "primeiro clique curte");
  const c2 = await (await post(`/api/mural/${doChefe.id}/curtir`, gente.token)).json();
  ok(c2.curti === false && c2.curtidas === 0, "segundo clique descurte");
  await post(`/api/mural/${doChefe.id}/curtir`, gente.token);
  const vista = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  const alvo = vista.publicacoes.find((p) => p.id === doChefe.id);
  ok(alvo.curti === true && alvo.curtidas === 1, "a lista mostra que ESTA pessoa curtiu");
  const vistaOutro = await (await fetch(`${CORE}/api/mural`, C(chefe.token))).json();
  ok(vistaOutro.publicacoes.find((p) => p.id === doChefe.id).curti === false,
     "e que a outra nao — curtida e de cada um");

  console.log("\n=== COMENTAR E APAGAR ===");
  await post(`/api/mural/${doChefe.id}/comentarios`, gente.token, { texto: "Combinado!" });
  await post(`/api/mural/${doChefe.id}/comentarios`, marketing.token, { texto: "Vou repassar." });
  const coments = await (await fetch(`${CORE}/api/mural/${doChefe.id}/comentarios`, C(gente.token))).json();
  ok(coments.comentarios.length === 2, "os dois comentarios aparecem");

  const meu = coments.comentarios.find((c) => c.texto === "Combinado!");
  const doOutro = coments.comentarios.find((c) => c.texto === "Vou repassar.");
  ok(meu.podeApagar === true, "cada um pode apagar o proprio comentario");
  ok(doOutro.podeApagar === false,
     "mas nao o dos outros — quem esta vendo aqui nao publicou o comunicado");

  // Quem publicou enxerga o botao em TODOS os comentarios do proprio
  // comunicado: e ela quem responde pelo que fica embaixo dele.
  const pelaOtica = await (await fetch(
    `${CORE}/api/mural/${doChefe.id}/comentarios`, C(chefe.token))).json();
  ok(pelaOtica.comentarios.every((c) => c.podeApagar === true),
     "para quem publicou, todos os comentarios sao apagaveis");

  const tentativa = await fetch(`${CORE}/api/mural/comentarios/${doOutro.id}`,
    { method: "DELETE", ...C(gente.token) });
  ok(tentativa.status === 403, "apagar comentario dos outros -> 403");

  const pelaAutora = await fetch(`${CORE}/api/mural/comentarios/${doOutro.id}`,
    { method: "DELETE", ...C(chefe.token) });
  ok(pelaAutora.status === 200,
     "quem publicou o comunicado limpa o que ficou embaixo dele");

  console.log("\n=== EDITAR DEIXA RASTRO ===");
  const semPermissao = await fetch(`${CORE}/api/mural/${doChefe.id}`, {
    method: "PATCH", ...J(marketing.token), body: JSON.stringify({ titulo: "MuralTeste sequestrado" }),
  });
  ok(semPermissao.status === 403, "um autor nao edita a publicacao do outro");

  const edicao = await fetch(`${CORE}/api/mural/${doChefe.id}`, {
    method: "PATCH", ...J(chefe.token),
    body: JSON.stringify({ titulo: "MuralTeste do chefe", texto: "Texto CORRIGIDO." }),
  });
  ok(edicao.status === 200, "quem publicou edita");

  const hist = await (await fetch(`${CORE}/api/mural/${doChefe.id}/edicoes`, C(gente.token))).json();
  ok(hist.edicoes.length === 1, "a edicao virou uma linha de historico");
  ok(hist.edicoes[0].texto_antes === "Texto original.", "guardando o texto de ANTES");
  ok(Boolean(hist.edicoes[0].editor), "com o nome de quem editou");
  ok(Boolean(hist.edicoes[0].editado_em), "e a data e hora");

  const listaEditada = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  ok(listaEditada.publicacoes.find((p) => p.id === doChefe.id).edicoes === 1,
     "a publicacao mostra que foi editada — quem leu antes percebe");

  console.log("\n=== POP-UP: UMA VEZ POR PESSOA ===");
  const comPopup = await (await post("/api/mural", chefe.token, {
    titulo: "MuralTeste urgente", texto: "Leia isto.", popup: true, popupDias: 3 })).json();

  const p1 = await (await fetch(`${CORE}/api/mural/popup`, C(gente.token))).json();
  ok(p1.publicacao && p1.publicacao.id === comPopup.id, "aparece para quem ainda nao viu");

  await post(`/api/mural/${comPopup.id}/lido`, gente.token, { popup: true });
  const p2 = await (await fetch(`${CORE}/api/mural/popup`, C(gente.token))).json();
  ok(p2.publicacao === null, "depois de fechado, nao volta");

  const p3 = await (await fetch(`${CORE}/api/mural/popup`, C(marketing.token))).json();
  ok(p3.publicacao && p3.publicacao.id === comPopup.id, "mas continua aparecendo para quem nao viu");

  const semPopup = await (await post("/api/mural", chefe.token, {
    titulo: "MuralTeste comum" })).json();
  const naoDevePopar = await pool.query("SELECT popup_ate FROM avisos WHERE id=$1", [semPopup.id]);
  ok(naoDevePopar.rows[0].popup_ate === null, "publicacao comum nao vira janela");

  console.log("\n=== LIDO E POR PESSOA ===");
  await post(`/api/mural/${semPopup.id}/lido`, gente.token, {});
  const depoisLido = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  ok(depoisLido.publicacoes.find((p) => p.id === semPopup.id).li === true, "marcou como lido");
  const outroAinda = await (await fetch(`${CORE}/api/mural`, C(marketing.token))).json();
  ok(outroAinda.publicacoes.find((p) => p.id === semPopup.id).li === false,
     "e continua nao lido para os outros");

  console.log("\n=== REMOVER ARQUIVA, NAO APAGA ===");
  await fetch(`${CORE}/api/mural/${semPopup.id}`, { method: "DELETE", ...C(chefe.token) });
  const semEle = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  ok(!semEle.publicacoes.some((p) => p.id === semPopup.id), "sai da tela");
  const noBanco = await pool.query("SELECT arquivado FROM avisos WHERE id=$1", [semPopup.id]);
  ok(noBanco.rows[0] && noBanco.rows[0].arquivado === true,
     "mas continua no banco — curtida e comentario das pessoas iriam junto");

  console.log("\n=== SEM LOGIN NAO LE ===");
  ok((await fetch(`${CORE}/api/mural`)).status === 401, "o mural exige login");

  await pool.query("DELETE FROM avisos WHERE titulo LIKE 'MuralTeste%'");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'mural.%@uniseter.com'");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
