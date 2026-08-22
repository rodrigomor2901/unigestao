// O administrador geral precisa chegar em cada modulo com o NOME que aquele
// modulo usa para o papel de administrador.
//
// O caso que motivou este arquivo: o Core mandava "admin" para todo mundo. O
// CRM chama esse papel de "administrador", entao recusava o proprio
// administrador geral com "Acesso permitido apenas para Administrador."
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");
const modulos = require("../core/modulos.js");

const CORE = "http://localhost:3000";
const CHAVE = "chave-de-desenvolvimento";
const CONEXAO = process.env.DATABASE_URL || "postgres://postgres:teste@localhost:55987/unigestao";

let falhas = 0;
function ok(c, m) { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; }

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM login_attempts");
  await pool.query("DELETE FROM usuarios WHERE email = 'super.teste@uniseter.com'");

  const id = "u" + crypto.randomBytes(9).toString("hex");
  await pool.query(
    "INSERT INTO usuarios (id,nome,email,senha,super_admin) VALUES ($1,$2,$3,$4,TRUE)",
    [id, "Super Teste", "super.teste@uniseter.com", auth.gerarHash("SuperTeste@2026")]
  );

  const r = await fetch(CORE + "/api/login", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: "super.teste@uniseter.com", senha: "SuperTeste@2026" }),
  });
  const d = await r.json();

  // Super admin recem-criado ainda nao tem 2FA: o login pede para cadastrar.
  ok(d.configurar2FA === true, "administrador geral e obrigado a cadastrar 2FA");

  console.log("\n=== CADA MODULO TEM SEU NOME PARA O PAPEL DE ADMIN ===");
  for (const m of modulos.listar()) {
    const papel = modulos.papelDeAdmin(m.id);
    ok(m.papeis.includes(papel),
       `${m.id}: "${papel}" existe na lista de papeis do modulo`);
  }
  ok(modulos.papelDeAdmin("crm") === "administrador",
     'crm usa "administrador", nao "admin"  <-- o bug original');
  ok(modulos.papelDeAdmin("operacional") === "admin", "operacional usa \"admin\"");
  ok(modulos.papelDeAdmin("inexistente") === "admin", "modulo desconhecido cai no padrao");

  console.log("\n=== O CORE ENTREGA O NOME CERTO PARA A FACHADA ===");
  // Sessao gravada direto pelo pool DESTE teste, para nao depender do fluxo de
  // 2FA nem do pool interno do Core (que exige DATABASE_URL no processo).
  const token = crypto.randomBytes(32).toString("hex");
  await pool.query(
    "INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1,$2,NOW() + INTERVAL '1 hour')",
    [token, id]
  );
  for (const m of modulos.listar()) {
    const res = await fetch(`${CORE}/api/interno/sessao?modulo=${m.id}`, {
      headers: { "x-unigestao-token": token, "x-core-key": CHAVE },
    });
    const body = await res.json();

    // Sistema de terceiro nao entra nesta conta. Ele nao recebe identidade do
    // Core — nem para o administrador geral —, porque do outro lado nao ha um
    // modulo nosso para confiar nela. Ver tests/modulo-externo.test.js.
    if (modulos.ehExterno(m.id)) {
      ok(res.status === 400, `${m.id}: e de terceiro, entao a sessao e recusada`);
      continue;
    }

    ok(res.status === 200 && body.papel === modulos.papelDeAdmin(m.id),
       `${m.id}: recebe "${body.papel}" (esperado "${modulos.papelDeAdmin(m.id)}")`);
  }

  console.log("\n=== E A TELA INICIAL MOSTRA O MESMO ===");
  const eu = await fetch(CORE + "/api/eu", { headers: { "x-unigestao-token": token } });
  const de = await eu.json();
  for (const m of de.modulos) {
    ok(m.papel === modulos.papelDeAdmin(m.id), `card de ${m.id} mostra "${m.papel}"`);
  }

  await pool.query("DELETE FROM usuarios WHERE email = 'super.teste@uniseter.com'");
  await pool.query("DELETE FROM login_attempts");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  // Sem process.exit(): este arquivo faz muitas chamadas HTTP e encerrar a
  // forca, com sockets ainda fechando, derrubava o Node no Windows
  // ("UV_HANDLE_CLOSING") — o processo saia com erro mesmo com tudo verde.
  process.exitCode = falhas === 0 ? 0 : 1;
})().catch(e => { console.error(e); process.exitCode = 1; });
