// Testa a importacao partida em dois dias (--somente=novos).
//
// Ela existe porque o plano do SendGrid tem limite diario: quando a lista de
// um modulo nao cabe num dia so, o primeiro dia leva quem ainda nao tem conta
// e o segundo leva o resto. O que nao pode acontecer, em nenhum dos dois:
//   - alguem receber duas vezes
//   - alguem ficar sem receber
//   - o segundo comando reenviar para quem ja foi atendido no primeiro
//
// Nenhum e-mail sai: o script roda com EMAIL_ARQUIVO, que grava em arquivo.
const { execFileSync } = require("child_process");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const RAIZ = path.join(__dirname, "..");
const SCRIPT = path.join(RAIZ, "scripts", "importar-usuarios.js");
const CAIXA = path.join(os.tmpdir(), "ug-teste-importacao.jsonl");
const CONEXAO = "postgres://postgres:teste@localhost:55987/unigestao";

const LISTA = [
  { nome: "Partida Ja Existia", email: "partida.velho@uniseter.com", papel: "coordenador" },
  { nome: "Partida Novo Um", email: "partida.novo1@uniseter.com", papel: "executor" },
  { nome: "Partida Novo Dois", email: "partida.novo2@uniseter.com", papel: "gerente" },
];

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };
const caixa = () => fs.existsSync(CAIXA)
  ? fs.readFileSync(CAIXA, "utf8").split("\n").filter(Boolean).map(JSON.parse) : [];
const limpar = () => fs.writeFileSync(CAIXA, "", "utf8");

function importar(args) {
  const b64 = Buffer.from(JSON.stringify(LISTA), "utf8").toString("base64");
  return execFileSync(process.execPath, [SCRIPT, "tarefas", b64, ...args], {
    cwd: RAIZ,
    env: { ...process.env, DATABASE_URL: CONEXAO, EMAIL_ARQUIVO: CAIXA },
    encoding: "utf8",
  });
}

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'partida.%@uniseter.com'");

  // Uma pessoa que ja entrava no UniGestao antes desta importacao — o caso das
  // 12 que ja usavam outro modulo quando a Gestao de Tarefas foi plugada.
  await pool.query(
    "INSERT INTO usuarios (id,nome,email,senha,senha_temp) VALUES ($1,$2,$3,$4,FALSE)",
    ["upartida001", "Partida Ja Existia", "partida.velho@uniseter.com",
     auth.gerarHash("SenhaTeste@123")]
  );

  console.log("\n=== DIA 1 — so quem ainda nao tem conta ===");
  limpar();
  const s1 = importar(["--somente=novos", "--enviar"]);
  const c1 = caixa();
  ok(/CRIADOS \(2\)/.test(s1), "criou as 2 contas novas");
  ok(/ADIADOS \(1\)/.test(s1), "adiou quem ja tinha conta");
  ok(c1.length === 2, "saiu e-mail para 2 pessoas, nao 3");
  ok(c1.every((m) => /acesso ao UniGest/i.test(m.assunto)), "os dois sao de conta nova");
  ok(!c1.some((m) => m.para === "partida.velho@uniseter.com"), "o adiado nao recebeu nada");

  const semModulo = await pool.query(
    "SELECT 1 FROM usuario_modulos WHERE usuario_id = 'upartida001' AND modulo = 'tarefas'");
  ok(semModulo.rowCount === 0,
     "o adiado tambem NAO ganhou o modulo — senao o dia 2 nao teria o que avisar");

  console.log("\n=== DIA 2 — o resto ===");
  limpar();
  const s2 = importar(["--enviar"]);
  const c2 = caixa();
  ok(/JA EXISTIAM \(3\)/.test(s2), "agora as 3 ja existem");
  ok(c2.length === 1, "saiu e-mail para 1 pessoa so");
  ok(c2[0] && c2[0].para === "partida.velho@uniseter.com", "e foi para quem tinha sido adiado");
  ok(c2[0] && /Novo m.dulo/i.test(c2[0].assunto), "com a mensagem de modulo novo");
  ok(c2[0] && !/senha provis/i.test(c2[0].html), "sem senha nenhuma no corpo");

  const comModulo = await pool.query(
    "SELECT papel FROM usuario_modulos WHERE usuario_id = 'upartida001' AND modulo = 'tarefas'");
  ok(comModulo.rows[0] && comModulo.rows[0].papel === "coordenador",
     "com o papel que ele ja tinha no modulo");

  console.log("\n=== RODAR DE NOVO POR ENGANO ===");
  limpar();
  importar(["--enviar"]);
  ok(caixa().length === 0, "repetir o comando nao manda e-mail para ninguem");

  await pool.query("DELETE FROM usuarios WHERE email LIKE 'partida.%@uniseter.com'");
  try { fs.unlinkSync(CAIXA); } catch (e) {}
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e.stdout || e.message); process.exit(1); });
