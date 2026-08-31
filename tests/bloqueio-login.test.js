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

  console.log("\n=== O ENDERECO DE REDE NAO PODE SER ESCOLHIDO POR QUEM CHAMA ===");
  // Achado do teste de seguranca: ipDe lia o X-Forwarded-For e ficava com o
  // PRIMEIRO valor — o pedaco que quem chama escreve. Com isso o teto por local
  // (MAX_POR_IP) nunca fechava: bastava mandar um endereco novo a cada
  // tentativa. E a auditoria guardava endereco inventado, que e pior: da a
  // impressao de que se sabe de onde veio o ataque.
  //
  // Duas travas, testadas separadamente:
  //   1. ipDe usa o endereco que o Express apurou, nunca o texto cru;
  //   2. o Express so acredita no cabecalho quando o vizinho da conexao esta
  //      numa faixa privada — a rede interna da Railway, onde so a Fachada
  //      chega ao Core.
  const forjado = {
    ip: "203.0.113.9",                                  // o que o Express apurou
    headers: { "x-forwarded-for": "1.2.3.4, 203.0.113.9" }, // 1.2.3.4 e invencao
    socket: { remoteAddress: "::1" },
  };
  ok(auth.ipDe(forjado) === "203.0.113.9",
     "vale o endereco apurado pelo Express, nao o que veio escrito na frente");
  ok(auth.ipDe(forjado) !== "1.2.3.4",
     "o valor da esquerda do X-Forwarded-For e ignorado  <-- era o furo");

  const semExpress = { headers: { "x-forwarded-for": "1.2.3.4" },
                       socket: { remoteAddress: "10.0.0.7" } };
  ok(auth.ipDe(semExpress) === "10.0.0.7",
     "fora do Express, sobra o endereco real da conexao — nunca o cabecalho");

  // A lista de vizinhos confiaveis e a mesma que o server.js entrega ao
  // Express; aqui ela e submetida ao mesmo juiz que o Express usa.
  const confia = require("proxy-addr").compile(auth.PROXY_CONFIAVEL);
  ok(confia("fd12::3", 0) === true,
     "a rede privada da Railway e confiavel — e por onde a Fachada fala");
  ok(confia("127.0.0.1", 0) === true, "a propria maquina tambem (dev e testes)");
  ok(confia("203.0.113.9", 0) === false,
     "um endereco publico NAO e confiavel: se o Core for exposto, o cabecalho de fora nao vale");
  ok(!auth.PROXY_CONFIAVEL.some((x) => typeof x === "number"),
     "a confianca e por faixa de endereco, nao por contagem de saltos");

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
