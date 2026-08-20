// O mural: avisos da empresa na tela inicial.
//
// O que este teste protege, em ordem de importancia:
//   1. so o administrador geral publica; todo mundo le
//   2. aviso vencido some sozinho da tela das pessoas
//   3. "novo" e por pessoa — some depois que ELA viu, nao depois que
//      qualquer um viu
//   4. aviso nasce com prazo; sem prazo so quando alguem fixa de proposito
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const CORE = "http://localhost:3000";
const CONEXAO = "postgres://postgres:teste@localhost:55987/unigestao";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM login_attempts");
  await pool.query("DELETE FROM avisos WHERE titulo LIKE 'MuralTeste%'");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'mural.%@uniseter.com'");

  async function criar(email, superAdmin) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await pool.query(
      "INSERT INTO usuarios (id,nome,email,senha,super_admin) VALUES ($1,$2,$3,$4,$5)",
      [id, "Mural " + email, email, auth.gerarHash("SenhaTeste@123"), !!superAdmin]
    );
    // Super admin do Core exige 2FA no login; para o teste, entra direto pela
    // sessao — o que se quer exercitar aqui e a permissao, nao o login.
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO sessoes (token,usuario_id,expira_em) VALUES ($1,$2,NOW() + INTERVAL '1 hour')",
      [token, id]
    );
    return { id, token };
  }
  const C = (t) => ({ headers: { cookie: "unigestao_sessao=" + t } });
  const J = (t) => ({ headers: { cookie: "unigestao_sessao=" + t, "Content-Type": "application/json" } });

  const chefe = await criar("mural.chefe@uniseter.com", true);
  const gente = await criar("mural.gente@uniseter.com", false);

  console.log("\n=== QUEM PODE PUBLICAR ===");
  const negado = await fetch(`${CORE}/api/admin/mural`, {
    method: "POST", ...J(gente.token),
    body: JSON.stringify({ titulo: "MuralTeste indevido" }),
  });
  ok(negado.status === 403, "quem nao e administrador geral nao publica");

  const criado = await fetch(`${CORE}/api/admin/mural`, {
    method: "POST", ...J(chefe.token),
    body: JSON.stringify({ titulo: "MuralTeste recesso", texto: "Fechado dia 24.", tipo: "evento" }),
  });
  ok(criado.status === 200, "o administrador geral publica");

  console.log("\n=== TODO MUNDO LE ===");
  const lista = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  const meu = lista.avisos.find((a) => a.titulo === "MuralTeste recesso");
  ok(Boolean(meu), "o aviso aparece para quem nao e admin");
  ok(meu.tipo === "evento", "com o tipo escolhido");
  ok(meu.autor && meu.autor.includes("Mural"), "e com o nome de quem publicou");

  console.log("\n=== PRAZO ===");
  const noBanco = await pool.query(
    "SELECT fim_em, fixado FROM avisos WHERE titulo = 'MuralTeste recesso'");
  ok(noBanco.rows[0].fim_em !== null,
     "aviso comum nasce COM prazo — sem prazo ele vira paisagem e o mural morre");
  ok(noBanco.rows[0].fixado === false, "e nao nasce fixado");

  await fetch(`${CORE}/api/admin/mural`, {
    method: "POST", ...J(chefe.token),
    body: JSON.stringify({ titulo: "MuralTeste fixado", fixado: true }),
  });
  const fix = await pool.query("SELECT fim_em, fixado FROM avisos WHERE titulo = 'MuralTeste fixado'");
  ok(fix.rows[0].fim_em === null && fix.rows[0].fixado === true,
     "sem prazo so quando alguem fixa de proposito");

  const ordem = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  ok(ordem.avisos[0].titulo === "MuralTeste fixado", "o fixado fica no topo");

  console.log("\n=== VENCIDO SOME SOZINHO ===");
  await pool.query(
    "UPDATE avisos SET fim_em = NOW() - INTERVAL '1 day' WHERE titulo = 'MuralTeste recesso'");
  const depois = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  ok(!depois.avisos.some((a) => a.titulo === "MuralTeste recesso"),
     "aviso vencido sai da tela das pessoas sem ninguem precisar limpar");

  const noAdmin = await (await fetch(`${CORE}/api/admin/mural`, C(chefe.token))).json();
  const vencido = noAdmin.avisos.find((a) => a.titulo === "MuralTeste recesso");
  ok(Boolean(vencido) && vencido.vencido === true,
     "mas continua na lista do admin, marcado, para reaproveitar ou apagar");

  console.log("\n=== O 'NOVO' E DE CADA PESSOA ===");
  const antes = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  ok(antes.avisos.every((a) => a.novo === true), "quem nunca abriu ve tudo como novo");

  await fetch(`${CORE}/api/mural/visto`, { method: "POST", ...C(gente.token) });
  const depoisDeVer = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  ok(depoisDeVer.avisos.every((a) => a.novo === false), "depois de ver, deixa de ser novo");

  const paraOutro = await (await fetch(`${CORE}/api/mural`, C(chefe.token))).json();
  ok(paraOutro.avisos.every((a) => a.novo === true),
     "e continua novo para quem ainda nao abriu — o 'visto' e por pessoa");

  await fetch(`${CORE}/api/admin/mural`, {
    method: "POST", ...J(chefe.token),
    body: JSON.stringify({ titulo: "MuralTeste posterior" }),
  });
  const novoDepois = await (await fetch(`${CORE}/api/mural`, C(gente.token))).json();
  const recem = novoDepois.avisos.find((a) => a.titulo === "MuralTeste posterior");
  ok(recem && recem.novo === true, "aviso publicado depois volta a ser novo para quem ja tinha visto");

  console.log("\n=== TITULO VAZIO NAO PUBLICA ===");
  const semTitulo = await fetch(`${CORE}/api/admin/mural`, {
    method: "POST", ...J(chefe.token), body: JSON.stringify({ titulo: "  " }),
  });
  ok(semTitulo.status === 400, "titulo em branco -> 400");

  console.log("\n=== SEM LOGIN NAO LE ===");
  ok((await fetch(`${CORE}/api/mural`)).status === 401, "o mural exige login");

  await pool.query("DELETE FROM avisos WHERE titulo LIKE 'MuralTeste%'");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'mural.%@uniseter.com'");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
