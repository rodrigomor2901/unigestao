// "Esqueci minha senha" — o caminho de volta para quem perdeu o acesso.
//
// POR QUE ESTE TESTE EXISTE
// Recuperacao de senha e a porta dos fundos de qualquer sistema: se ela tiver
// folga, nao adianta o resto estar trancado. As garantias que este arquivo
// guarda, uma por uma:
//
//   - a resposta e IGUAL exista o e-mail ou nao (senao vira uma consulta de
//     "quem trabalha nessa empresa", um e-mail por vez)
//   - o link vale UMA vez
//   - o link vencido nao vale
//   - o token guardado no banco e o HASH, nunca o token do e-mail
//   - trocar a senha derruba as sessoes abertas
//   - ha intervalo minimo entre pedidos — a cota do SendGrid e de 100/dia para
//     o grupo todo, e um script apertando o botao esgotaria o dia
//
// Os e-mails nao saem: em desenvolvimento cada mensagem vira uma linha em
// .emails-dev.jsonl (ver dev-local.js), e e de la que o teste tira o link.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const CORE = "http://localhost:3000";
const CONEXAO = "postgres://postgres:teste@localhost:55987/unigestao";
const CAIXA = path.join(__dirname, "..", ".emails-dev.jsonl");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const post = (rota, corpo) => fetch(`${CORE}${rota}`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(corpo),
});

// Ultimo e-mail escrito para um destinatario, e o link dentro dele.
function ultimoLinkPara(email) {
  if (!fs.existsSync(CAIXA)) return null;
  const linhas = fs.readFileSync(CAIXA, "utf8").trim().split("\n").filter(Boolean);
  for (let i = linhas.length - 1; i >= 0; i--) {
    const m = JSON.parse(linhas[i]);
    if (m.para !== email) continue;
    const achou = String(m.html).match(/\/redefinir\?token=([a-f0-9]{64})/);
    return achou ? { token: achou[1], html: m.html, assunto: m.assunto } : null;
  }
  return null;
}

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM login_attempts");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'esq.%@uniseter.com'");

  const email = "esq.ana@uniseter.com";
  const id = "u" + crypto.randomBytes(9).toString("hex");
  await pool.query(
    "INSERT INTO usuarios (id,nome,email,senha) VALUES ($1,$2,$3,$4)",
    [id, "Ana Souza", email, auth.gerarHash("SenhaAntiga@123")]
  );

  console.log("\n=== A RESPOSTA NAO DENUNCIA QUEM EXISTE ===");
  const existe = await post("/api/senha/esqueci", { email });
  const naoExiste = await post("/api/senha/esqueci", { email: "esq.ninguem@uniseter.com" });
  const c1 = await existe.json();
  const c2 = await naoExiste.json();
  ok(existe.status === naoExiste.status, "mesmo código de resposta nos dois casos");
  ok(c1.mensagem === c2.mensagem, "e exatamente a mesma mensagem");
  ok(JSON.stringify(c1) === JSON.stringify(c2), "a resposta inteira é indistinguível");

  console.log("\n=== O E-MAIL LEVA UM LINK, NAO UMA SENHA ===");
  const carta = ultimoLinkPara(email);
  ok(Boolean(carta && carta.token), "o e-mail saiu com um link de redefinição");
  ok(!/senha:/i.test(carta.html), "e não leva senha nenhuma escrita dentro");

  console.log("\n=== O BANCO GUARDA O HASH, NAO O TOKEN ===");
  const guardado = await pool.query(
    "SELECT token_hash FROM senha_reset WHERE usuario_id = $1", [id]
  );
  const hashEsperado = crypto.createHash("sha256").update(carta.token).digest("hex");
  ok(guardado.rows.length === 1, "uma linha de recuperação foi criada");
  ok(guardado.rows[0].token_hash === hashEsperado, "e o que está lá é o hash do token");
  ok(guardado.rows[0].token_hash !== carta.token,
     "quem ler o banco NÃO consegue montar o link do e-mail");

  console.log("\n=== INTERVALO MINIMO ENTRE PEDIDOS ===");
  // A cota de e-mail e do grupo todo; um botao sem trava esgota o dia.
  await post("/api/senha/esqueci", { email });
  const depois = await pool.query("SELECT count(*)::int AS n FROM senha_reset WHERE usuario_id = $1", [id]);
  ok(depois.rows[0].n === 1, "pedir de novo em seguida não gera um segundo link");

  console.log("\n=== O LINK ABRE E TROCA A SENHA ===");
  const confere = await (await fetch(
    `${CORE}/api/senha/redefinir/confere?token=${carta.token}`)).json();
  ok(confere.valido === true, "o link é reconhecido como válido");
  ok(!JSON.stringify(confere).includes(email),
     "e a conferência não revela de quem é a conta");

  // Uma sessao aberta antes da troca, para conferir que ela cai depois.
  const entrou = await post("/api/login", { email, senha: "SenhaAntiga@123" });
  const sessao = (entrou.headers.get("set-cookie").match(/unigestao_sessao=([^;]+)/) || [])[1];
  ok((await fetch(`${CORE}/api/eu`, { headers: { cookie: "unigestao_sessao=" + sessao } })).status === 200,
     "a sessão antiga está de pé antes da troca");

  const trocou = await post("/api/senha/redefinir", { token: carta.token, nova: "SenhaNova@456" });
  ok(trocou.status === 200, "a senha é redefinida pelo link");

  const comNova = await post("/api/login", { email, senha: "SenhaNova@456" });
  ok(comNova.status === 200, "a senha nova entra");
  const comVelha = await post("/api/login", { email, senha: "SenhaAntiga@123" });
  ok(comVelha.status === 401, "e a antiga não entra mais");

  console.log("\n=== E O QUE ESTAVA ABERTO CAI JUNTO ===");
  // Se a senha foi trocada porque alguem entrou na conta, deixar a sessao
  // dessa pessoa viva tornaria a troca inutil.
  ok((await fetch(`${CORE}/api/eu`, { headers: { cookie: "unigestao_sessao=" + sessao } })).status === 401,
     "a sessão aberta antes da troca foi encerrada");

  console.log("\n=== O LINK VALE UMA VEZ SO ===");
  const denovo = await post("/api/senha/redefinir", { token: carta.token, nova: "Outra@Senha789" });
  ok(denovo.status === 400, "usar o mesmo link de novo é recusado");
  ok((await post("/api/login", { email, senha: "Outra@Senha789" })).status === 401,
     "e a segunda senha não passou a valer");

  console.log("\n=== LINK VENCIDO E LINK INVENTADO ===");
  const t2 = crypto.randomBytes(32).toString("hex");
  await pool.query(
    `INSERT INTO senha_reset (token_hash, usuario_id, expira_em)
     VALUES ($1, $2, NOW() - interval '1 minute')`,
    [crypto.createHash("sha256").update(t2).digest("hex"), id]
  );
  ok((await post("/api/senha/redefinir", { token: t2, nova: "Qualquer@Senha1" })).status === 400,
     "link vencido é recusado");
  ok((await post("/api/senha/redefinir", { token: "naoexiste", nova: "Qualquer@Senha1" })).status === 400,
     "token inventado é recusado");
  ok((await post("/api/senha/redefinir", { token: carta.token, nova: "curta" })).status === 400,
     "senha curta é recusada");

  await pool.query("DELETE FROM usuarios WHERE email LIKE 'esq.%@uniseter.com'");
  await pool.query("DELETE FROM login_attempts");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
