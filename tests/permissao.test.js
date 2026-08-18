// Teste de ponta a ponta da regra de acesso por modulo.
const CORE = "http://localhost:3000";
const CHAVE = "chave-de-desenvolvimento";
let falhas = 0;

function ok(cond, msg) {
  console.log((cond ? "  OK   " : "  FALHA") + "  " + msg);
  if (!cond) falhas++;
}

async function j(url, opc) {
  const r = await fetch(url, opc);
  let d = null;
  try { d = await r.json(); } catch (e) {}
  return { status: r.status, d, headers: r.headers };
}

(async () => {
  // 1. login do super admin (precisa do 2FA, entao usamos o token direto do banco)
  //    Em vez disso, criamos o usuario de teste pela API usando a sessao do admin.
  //    Para simplificar, falamos direto com o banco via a API interna do proprio Core.
  const { Pool } = require("pg");
  const pool = new Pool({ connectionString: "postgres://postgres:teste@localhost:55987/unigestao" });

  // limpa execucoes anteriores. O bloqueio por IP e estado global compartilhado
  // entre os arquivos de teste: sem zerar aqui, sobras de uma rodada anterior
  // fazem os logins deste arquivo voltarem 429 e o teste falha sem motivo.
  await pool.query("DELETE FROM login_attempts");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'teste.%@uniseter.com'");

  const crypto = require("crypto");
  const auth = require("../core/auth.js");

  const id = "u" + crypto.randomBytes(9).toString("hex");
  await pool.query(
    "INSERT INTO usuarios (id,nome,email,senha,super_admin) VALUES ($1,$2,$3,$4,FALSE)",
    [id, "Teste Supervisor", "teste.supervisor@uniseter.com", auth.gerarHash("SenhaTeste@123")]
  );
  await pool.query(
    "INSERT INTO usuario_modulos (usuario_id,modulo,papel) VALUES ($1,'operacional','supervisor')",
    [id]
  );

  console.log("\n=== LOGIN ===");
  const login = await j(CORE + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "teste.supervisor@uniseter.com", senha: "SenhaTeste@123" }),
  });
  ok(login.status === 200, "login com senha correta -> 200");
  ok(!login.d.requer2FA, "usuario comum nao e obrigado a usar 2FA");

  const setCookie = login.headers.get("set-cookie") || "";
  const token = (setCookie.match(/unigestao_sessao=([^;]+)/) || [])[1];
  ok(Boolean(token), "cookie de sessao emitido");

  const errado = await j(CORE + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "teste.supervisor@uniseter.com", senha: "senha-errada" }),
  });
  ok(errado.status === 401, "senha errada -> 401");

  console.log("\n=== ACESSO POR MODULO ===");
  const h = { "x-unigestao-token": token, "x-core-key": CHAVE };

  const liberado = await j(CORE + "/api/interno/sessao?modulo=operacional", { headers: h });
  ok(liberado.status === 200, "modulo liberado -> 200");
  ok(liberado.d && liberado.d.papel === "supervisor", "papel devolvido e 'supervisor' (nao 'admin')");
  ok(liberado.d && liberado.d.superAdmin === false, "nao e super admin");

  // Modulo que ainda nao foi plugado: a resposta correta e 404 (desconhecido),
  // e nao 403. Escolhido a partir do registro, nunca fixo no teste — antes isto
  // apontava para "documentos", e o teste quebrou no dia em que ele foi ativado.
  const modulos = require("../core/modulos.js");
  const inativo = Object.keys(modulos.MODULOS).find((id) => !modulos.MODULOS[id].ativo);
  if (inativo) {
    const inexistente = await j(CORE + "/api/interno/sessao?modulo=" + inativo, { headers: h });
    ok(inexistente.status === 404, `modulo ainda nao conectado (${inativo}) -> 404`);
  } else {
    ok(true, "todos os modulos ja estao conectados — nada a verificar aqui");
  }

  console.log("\n=== BLOQUEIOS ===");
  const semChave = await j(CORE + "/api/interno/sessao?modulo=operacional", {
    headers: { "x-unigestao-token": token, "x-core-key": "chave-errada" },
  });
  ok(semChave.status === 401, "chave interna errada -> 401");

  const semToken = await j(CORE + "/api/interno/sessao?modulo=operacional", {
    headers: { "x-core-key": CHAVE },
  });
  ok(semToken.status === 401, "sem token de sessao -> 401");

  const admApi = await j(CORE + "/api/admin/usuarios", { headers: { "x-unigestao-token": token } });
  ok(admApi.status === 403, "usuario comum no Admin Geral -> 403");

  console.log("\n=== DESATIVACAO ===");
  await pool.query("UPDATE usuarios SET ativo=FALSE WHERE id=$1", [id]);
  const depois = await j(CORE + "/api/interno/sessao?modulo=operacional", { headers: h });
  ok(depois.status === 401, "usuario desativado perde o acesso na hora");

  console.log("\n=== MIGRACAO DE SENHA (formatos antigos) ===");
  const bcrypt = require("bcryptjs");
  const idT = "u" + crypto.randomBytes(9).toString("hex");
  const hashBcrypt = "bcrypt:" + bcrypt.hashSync("SenhaAntiga@1", 10);
  await pool.query(
    "INSERT INTO usuarios (id,nome,email,senha) VALUES ($1,$2,$3,$4)",
    [idT, "Teste Tarefas", "teste.tarefas@uniseter.com", hashBcrypt]
  );
  const l2 = await j(CORE + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "teste.tarefas@uniseter.com", senha: "SenhaAntiga@1" }),
  });
  ok(l2.status === 200, "senha em bcrypt (Gestao de Tarefas) permite login");
  const novoHash = (await pool.query("SELECT senha FROM usuarios WHERE id=$1", [idT])).rows[0].senha;
  ok(novoHash.startsWith("pbkdf2-sha256:"), "senha regravada no formato novo automaticamente");

  const idE = "u" + crypto.randomBytes(9).toString("hex");
  const sha = crypto.createHash("sha256").update("SenhaEventos").digest("hex");
  await pool.query(
    "INSERT INTO usuarios (id,nome,email,senha) VALUES ($1,$2,$3,$4)",
    [idE, "Teste Eventos", "teste.eventos@uniseter.com", "sha256:" + sha]
  );
  const l3 = await j(CORE + "/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "teste.eventos@uniseter.com", senha: "SenhaEventos" }),
  });
  ok(l3.status === 401 && l3.d.precisaRedefinir === true,
     "senha legada insegura (Eventos) e recusada e pede redefinicao");

  await pool.query("DELETE FROM usuarios WHERE email LIKE 'teste.%@uniseter.com'");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
