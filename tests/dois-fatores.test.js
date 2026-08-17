// Testa o login de quem JA tem 2FA ativo.
//
// O caso que motivou este arquivo: digitar o codigo errado descartava o token
// de login, e a tentativa seguinte — mesmo com o codigo certo — falhava com
// "Sessao de login expirada". Um erro de digitacao obrigava a refazer tudo.
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const CORE = "http://localhost:3000";
const CONEXAO = process.env.DATABASE_URL || "postgres://postgres:teste@localhost:55987/unigestao";

let falhas = 0;
function ok(c, m) { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; }

// Gera o codigo TOTP valido para um segredo, sem depender do modulo testado
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
function codigoDe(segredo) {
  let bits = "";
  for (const c of segredo) bits += B32.indexOf(c).toString(2).padStart(5, "0");
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(Math.floor(Date.now() / 30000)));
  const h = crypto.createHmac("sha1", Buffer.from(bytes)).update(buf).digest();
  const off = h[h.length - 1] & 0x0f;
  const n = ((h[off] & 0x7f) << 24) | ((h[off + 1] & 0xff) << 16) |
            ((h[off + 2] & 0xff) << 8) | (h[off + 3] & 0xff);
  return String(n % 1000000).padStart(6, "0");
}

async function post(rota, corpo) {
  const r = await fetch(CORE + rota, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(corpo),
  });
  return { status: r.status, d: await r.json().catch(() => ({})), headers: r.headers };
}

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM usuarios WHERE email = 'dois.fatores@uniseter.com'");

  const segredo = auth.gerarSegredoTOTP();
  const id = "u" + crypto.randomBytes(9).toString("hex");
  await pool.query(
    "INSERT INTO usuarios (id,nome,email,senha,totp_secret,totp_ativo) VALUES ($1,$2,$3,$4,$5,TRUE)",
    [id, "Dois Fatores", "dois.fatores@uniseter.com", auth.gerarHash("SenhaTeste@123"), segredo]
  );

  const entrar = () => post("/api/login", { email: "dois.fatores@uniseter.com", senha: "SenhaTeste@123" });

  console.log("\n=== CAMINHO FELIZ ===");
  const l1 = await entrar();
  ok(l1.status === 200 && l1.d.requer2FA === true, "usuario com 2FA ativo cai na etapa do codigo");
  ok(Boolean(l1.d.tempToken), "recebe o token temporario");

  const c1 = await post("/api/login/2fa", { tempToken: l1.d.tempToken, codigo: codigoDe(segredo) });
  ok(c1.status === 200 && c1.d.ok === true, "codigo correto entra");
  ok(/unigestao_sessao=/.test(c1.headers.get("set-cookie") || ""), "cookie de sessao emitido");

  console.log("\n=== ERRAR O CODIGO NAO PODE DERRUBAR O LOGIN ===");
  const l2 = await entrar();
  const e1 = await post("/api/login/2fa", { tempToken: l2.d.tempToken, codigo: "000000" });
  ok(e1.status === 401, "codigo errado -> 401");
  ok(/Restam|Resta /.test(e1.d.erro), "mensagem informa quantas tentativas restam");
  ok(e1.d.recomecar !== true, "nao manda refazer o login por causa de um erro");

  const e2 = await post("/api/login/2fa", { tempToken: l2.d.tempToken, codigo: "111111" });
  ok(e2.status === 401, "segundo codigo errado -> 401");

  const acerto = await post("/api/login/2fa", { tempToken: l2.d.tempToken, codigo: codigoDe(segredo) });
  ok(acerto.status === 200 && acerto.d.ok === true,
     "codigo CERTO depois de dois erros entra normalmente  <-- o bug original");

  console.log("\n=== O TOKEN E DE USO UNICO ===");
  const reuso = await post("/api/login/2fa", { tempToken: l2.d.tempToken, codigo: codigoDe(segredo) });
  ok(reuso.status === 401 && reuso.d.recomecar === true, "token ja usado nao serve de novo");

  console.log("\n=== LIMITE DE TENTATIVAS ===");
  const l3 = await entrar();
  let ultima = null;
  for (let i = 0; i < auth.MAX_TENTATIVAS_2FA; i++) {
    ultima = await post("/api/login/2fa", { tempToken: l3.d.tempToken, codigo: "000000" });
  }
  ok(ultima.d.recomecar === true, `apos ${auth.MAX_TENTATIVAS_2FA} erros, o login recomeca`);
  const depois = await post("/api/login/2fa", { tempToken: l3.d.tempToken, codigo: codigoDe(segredo) });
  ok(depois.status === 401, "token esgotado nao aceita nem o codigo certo");

  console.log("\n=== A PENDENCIA VIVE NO BANCO (sobrevive a reinicio) ===");
  const l4 = await entrar();
  const naTabela = await pool.query("SELECT usuario_id FROM login_2fa_pendente WHERE token = $1", [l4.d.tempToken]);
  ok(naTabela.rows.length === 1, "token temporario gravado em login_2fa_pendente");
  ok(naTabela.rows[0].usuario_id === id, "aponta para a pessoa certa");
  await post("/api/login/2fa", { tempToken: l4.d.tempToken, codigo: codigoDe(segredo) });
  const limpou = await pool.query("SELECT 1 FROM login_2fa_pendente WHERE token = $1", [l4.d.tempToken]);
  ok(limpou.rows.length === 0, "pendencia apagada depois do login concluido");

  // O bloqueio por IP conta os codigos errados; limpa para nao atrapalhar os outros testes
  await pool.query("DELETE FROM login_attempts");
  await pool.query("DELETE FROM usuarios WHERE email = 'dois.fatores@uniseter.com'");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
