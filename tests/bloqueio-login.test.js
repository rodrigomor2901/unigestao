// Errar a senha bloqueia QUEM? Só quem errou, ou o escritório inteiro?
//
// POR QUE ESTE TESTE EXISTE
// Em 26/08/2026 três pessoas ficaram sem entrar no portal ao mesmo tempo —
// Rodrigo, Lais e Cristina —, e nenhuma delas tinha errado a senha oito vezes.
// A auditoria mostrou cinco erros de senha em duas horas, de duas contas
// diferentes, todos vindos do MESMO endereço de rede: o do escritório.
//
// Eram dois defeitos somados:
//
//   1. o contador era por IP, e as 44 pessoas saem pelo mesmo endereço
//      público — um contador só para todo mundo;
//
//   2. quando a janela de 15 minutos vencia, o contador voltava para 1 mas a
//      decisão de bloquear era tomada com o valor ANTERIOR. Um contador parado
//      em 9 fazia a PRIMEIRA senha errada depois do intervalo bloquear na
//      hora. Foi o que pegou a Lais: bloqueada com o contador marcando 1.
//
// Os dois casos estão abaixo. Se alguém voltar a contar por IP, ou reintroduzir
// a decisão pelo contador velho, é aqui que aparece.
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const CORE = "http://localhost:3000";
const CONEXAO = "postgres://postgres:teste@localhost:55987/unigestao";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const tentar = (email, senha) => fetch(`${CORE}/api/login`, {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email, senha }),
});

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM login_tentativas");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'blq.%@uniseter.com'");

  async function criar(email) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await pool.query("INSERT INTO usuarios (id,nome,email,senha) VALUES ($1,$2,$3,$4)",
      [id, email, email, auth.gerarHash("SenhaCerta@123")]);
    return id;
  }
  const rodrigo = "blq.rodrigo@uniseter.com";
  const lais = "blq.lais@uniseter.com";
  await criar(rodrigo);
  await criar(lais);

  console.log("\n=== ERRAR A SENHA NAO DERRUBA O COLEGA ===");
  // Os testes saem todos do mesmo endereco — exatamente como o escritorio.
  for (let i = 0; i < auth.MAX_POR_CONTA; i++) await tentar(rodrigo, "errada");

  const doRodrigo = await tentar(rodrigo, "SenhaCerta@123");
  ok(doRodrigo.status === 429, "quem errou " + auth.MAX_POR_CONTA + " vezes fica travado");
  ok((await doRodrigo.json()).erro.includes("nesta conta"),
     "e a mensagem diz que é a conta dele, não o local");

  const daLais = await tentar(lais, "SenhaCerta@123");
  ok(daLais.status === 200,
     "e a colega, no MESMO endereço de rede, entra normalmente  <-- o bug de 26/08");

  console.log("\n=== O CONTADOR VELHO NAO BLOQUEIA MAIS SOZINHO ===");
  // Reproduz a armadilha: contador alto e parado, janela ja vencida. Antes,
  // a proxima tentativa errada bloqueava na hora, com o contador em 1.
  const cristina = "blq.cristina@uniseter.com";
  await criar(cristina);
  await pool.query(
    `INSERT INTO login_tentativas (chave, count, first_at)
     VALUES ($1, $2, NOW() - interval '3 hours')`,
    ["conta:" + cristina, auth.MAX_POR_CONTA - 1]
  );

  const primeiraErrada = await tentar(cristina, "errada");
  ok(primeiraErrada.status === 401, "a tentativa errada é recusada, como deve ser");

  const logoDepois = await tentar(cristina, "SenhaCerta@123");
  ok(logoDepois.status === 200,
     "mas UMA senha errada depois do intervalo não bloqueia  <-- o bug da Lais");

  const linha = await pool.query(
    "SELECT count FROM login_tentativas WHERE chave = $1", ["conta:" + cristina]);
  ok(!linha.rows[0], "e entrar zera o contador da conta");

  console.log("\n=== O TETO POR LOCAL CONTINUA EXISTINDO ===");
  // Ele nao sumiu — so subiu para um numero que um escritorio inteiro nao
  // alcanca sem querer. E a defesa contra script, nao contra dedo pesado.
  ok(auth.MAX_POR_IP > auth.MAX_POR_CONTA * 4,
     "o teto do local (" + auth.MAX_POR_IP + ") é bem maior que o da conta (" +
     auth.MAX_POR_CONTA + ")");

  const ip = await pool.query(
    "SELECT count FROM login_tentativas WHERE chave LIKE 'ip:%'");
  ok(ip.rows.length >= 1, "as tentativas erradas continuam somando no contador do local");

  console.log("\n=== QUEM ENTRA LIMPA SO A PROPRIA CONTA ===");
  // Se entrar limpasse tambem o contador do local, bastaria uma entrada valida
  // qualquer para zerar a protecao contra script.
  const aindaTemIp = await pool.query(
    "SELECT count(*)::int AS n FROM login_tentativas WHERE chave LIKE 'ip:%'");
  ok(aindaTemIp.rows[0].n >= 1, "o contador do local sobrevive a um login bem-sucedido");

  await pool.query("DELETE FROM usuarios WHERE email LIKE 'blq.%@uniseter.com'");
  await pool.query("DELETE FROM login_tentativas");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
