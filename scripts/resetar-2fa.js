"use strict";

// ============================================================================
// Resetar a verificacao em duas etapas de alguem
// ----------------------------------------------------------------------------
// Serve para o caso em que a pessoa perdeu o celular, trocou de aparelho ou
// ficou com um cadastro de 2FA que nao existe mais no aplicativo dela.
//
// Depois de rodar, no proximo login o sistema mostra o QR Code de novo.
//
// USO
//   node scripts/resetar-2fa.js                        (lista quem tem 2FA ativo)
//   node scripts/resetar-2fa.js pessoa@uniseter.com    (reseta essa pessoa)
//
// No Railway: aba do servico `core` -> menu -> Run a command
//
// POR QUE ISTO EXISTE
// O administrador geral e obrigado a usar 2FA. Se ele perde o aplicativo e e o
// unico super admin, ninguem consegue destravar pela tela — nem ele. Este
// script e a saida de emergencia, e por isso roda no servidor, nao pela web.
// ============================================================================

const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

(async () => {
  if (!process.env.DATABASE_URL) {
    console.error("Faltou a variavel DATABASE_URL.");
    process.exit(1);
  }

  const email = (process.argv[2] || "").toLowerCase().trim();

  if (!email) {
    const r = await pool.query(
      `SELECT email, nome, super_admin, totp_ativo FROM usuarios
        WHERE totp_ativo = TRUE ORDER BY nome`
    );
    if (!r.rows.length) {
      console.log("Ninguem tem 2FA ativo no momento.");
    } else {
      console.log("Pessoas com 2FA ativo:\n");
      for (const u of r.rows) {
        console.log(`  ${u.email}${u.super_admin ? "   (administrador geral)" : ""}`);
      }
      console.log("\nPara resetar:  node scripts/resetar-2fa.js <e-mail>");
    }
    await pool.end();
    return;
  }

  const r = await pool.query(
    `UPDATE usuarios SET totp_secret = NULL, totp_ativo = FALSE
      WHERE LOWER(email) = $1 RETURNING id, nome, email, super_admin`,
    [email]
  );

  if (!r.rows[0]) {
    console.error(`Nao existe usuario com o e-mail ${email}.`);
    await pool.end();
    process.exit(1);
  }

  const u = r.rows[0];
  // Derruba as sessoes abertas e qualquer login pela metade
  await pool.query("DELETE FROM sessoes WHERE usuario_id = $1", [u.id]);
  await pool.query("DELETE FROM login_2fa_pendente WHERE usuario_id = $1", [u.id]);
  // Limpa tambem o bloqueio por IP, que costuma ter enchido nas tentativas
  await pool.query("DELETE FROM login_attempts");

  await pool.query(
    "INSERT INTO auditoria (usuario_id, email, acao, detalhe) VALUES ($1,$2,$3,$4)",
    [u.id, u.email, "2fa_resetado_por_script", JSON.stringify({ origem: "scripts/resetar-2fa.js" })]
  );

  console.log(`2FA resetado para ${u.nome} <${u.email}>.`);
  console.log("No proximo login o QR Code sera exibido de novo para cadastrar o aplicativo.");
  await pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
