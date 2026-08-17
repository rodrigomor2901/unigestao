// Senha provisoria tem que ser trocada antes de qualquer modulo abrir.
//
// O script de importacao promete "troca obrigatoria no primeiro acesso".
// Sem estas verificacoes a promessa era falsa: o campo senha_temp existia,
// mas nada impedia a pessoa de usar o sistema com a senha que recebeu pronta.
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const CORE = "http://localhost:3000";
const CHAVE = "chave-de-desenvolvimento";
const CONEXAO = process.env.DATABASE_URL || "postgres://postgres:teste@localhost:55987/unigestao";

let falhas = 0;
function ok(c, m) { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; }

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM login_attempts");
  await pool.query("DELETE FROM usuarios WHERE email = 'provisoria@uniseter.com'");

  const id = "u" + crypto.randomBytes(9).toString("hex");
  await pool.query(
    "INSERT INTO usuarios (id,nome,email,senha,senha_temp) VALUES ($1,$2,$3,$4,TRUE)",
    [id, "Senha Provisoria", "provisoria@uniseter.com", auth.gerarHash("Provisoria@2026")]
  );
  await pool.query(
    "INSERT INTO usuario_modulos (usuario_id,modulo,papel) VALUES ($1,'operacional','cco')",
    [id]
  );

  async function entrar(senha) {
    const r = await fetch(CORE + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: "provisoria@uniseter.com", senha }),
    });
    const d = await r.json();
    const token = (r.headers.get("set-cookie") || "").match(/unigestao_sessao=([^;]+)/);
    return { status: r.status, d, token: token ? token[1] : null };
  }

  console.log("\n=== ENTRA, MAS NAO PASSA DA TELA DE SENHA ===");
  const l1 = await entrar("Provisoria@2026");
  ok(l1.status === 200, "a senha provisoria permite entrar");
  ok(l1.d.senhaTemp === true, "o login avisa que a senha e provisoria");

  const h = { "x-unigestao-token": l1.token, "x-core-key": CHAVE };
  const modulo = await fetch(CORE + "/api/interno/sessao?modulo=operacional", { headers: h });
  const dm = await modulo.json();
  ok(modulo.status === 401, "modulo recusado enquanto a senha for provisoria  <-- o que faltava");
  ok(dm.senhaTemp === true, "a recusa diz o motivo");

  const eu = await fetch(CORE + "/api/eu", { headers: { "x-unigestao-token": l1.token } });
  const de = await eu.json();
  ok(de.usuario.senhaTemp === true, "/api/eu sinaliza para a tela exigir a troca");

  console.log("\n=== DEPOIS DE TROCAR, LIBERA ===");
  const curta = await fetch(CORE + "/api/senha", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-unigestao-token": l1.token },
    body: JSON.stringify({ atual: "Provisoria@2026", nova: "curta" }),
  });
  ok(curta.status === 400, "senha nova curta demais e recusada");

  const errada = await fetch(CORE + "/api/senha", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-unigestao-token": l1.token },
    body: JSON.stringify({ atual: "nao-e-essa", nova: "MinhaSenhaBoa@2026" }),
  });
  ok(errada.status === 401, "sem acertar a senha atual nao troca");

  const troca = await fetch(CORE + "/api/senha", {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-unigestao-token": l1.token },
    body: JSON.stringify({ atual: "Provisoria@2026", nova: "MinhaSenhaBoa@2026" }),
  });
  ok(troca.status === 200, "troca aceita");

  const agora = await fetch(CORE + "/api/interno/sessao?modulo=operacional", { headers: h });
  ok(agora.status === 200, "modulo liberado apos a troca, na mesma sessao");

  const l2 = await entrar("MinhaSenhaBoa@2026");
  ok(l2.status === 200 && l2.d.senhaTemp === false, "novo login ja entra sem aviso de provisoria");
  const antiga = await entrar("Provisoria@2026");
  ok(antiga.status === 401, "a senha provisoria deixa de funcionar");

  await pool.query("DELETE FROM usuarios WHERE email = 'provisoria@uniseter.com'");
  await pool.query("DELETE FROM login_attempts");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch(e => { console.error(e); process.exit(1); });
