"use strict";

// ============================================================================
// Importar as pessoas de um modulo para o Core
// ----------------------------------------------------------------------------
// Usado uma vez por modulo, quando ele e plugado ao UniGestao.
//
// USO
//   1. No servico do MODULO, exporte as pessoas em JSON:
//        [{ "nome": "...", "email": "...", "papel": "..." }, ...]
//   2. Codifique em base64 e rode aqui, no servico do CORE:
//        node scripts/importar-usuarios.js <modulo> <json-em-base64>
//
//   Exemplo:  node scripts/importar-usuarios.js operacional eyJ...
//
// O base64 existe so para o JSON atravessar a linha de comando sem que aspas
// e acentos sejam mastigados pelo shell.
//
// O QUE ELE FAZ
//   - cria a pessoa no Core com uma senha aleatoria, marcada para troca
//     obrigatoria no primeiro acesso
//   - concede o modulo com o papel que ela ja tinha la dentro
//   - NAO mexe em quem ja existe: se o e-mail ja esta no Core, apenas concede
//     o modulo (ou corrige o papel) e mantem a senha atual
//   - NAO cria linha para super admin: ele ja enxerga todos os modulos
//
// A saida traz a lista de e-mails e senhas geradas, para repassar as pessoas.
// Ela aparece UMA VEZ — as senhas nao ficam guardadas em lugar nenhum.
// ============================================================================

const crypto = require("crypto");
const db = require("../core/db");
const auth = require("../core/auth");
const modulos = require("../core/modulos");

function senhaAleatoria() {
  // 12 caracteres, sem simbolos ambiguos para quem vai digitar
  return crypto.randomBytes(9).toString("base64url");
}

(async () => {
  const moduloId = String(process.argv[2] || "").trim();
  const b64 = String(process.argv[3] || "").trim();

  if (!moduloId || !b64) {
    console.error("uso: node scripts/importar-usuarios.js <modulo> <json-em-base64>");
    process.exit(1);
  }
  if (!modulos.existe(moduloId)) {
    console.error(`Modulo desconhecido ou inativo: ${moduloId}`);
    console.error("Ativos: " + modulos.listar().map(m => m.id).join(", "));
    process.exit(1);
  }

  let lista;
  try {
    lista = JSON.parse(Buffer.from(b64, "base64").toString("utf8"));
  } catch (e) {
    console.error("JSON invalido: " + e.message);
    process.exit(1);
  }
  if (!Array.isArray(lista) || !lista.length) {
    console.error("A lista veio vazia.");
    process.exit(1);
  }

  const criados = [];
  const jaExistiam = [];
  const recusados = [];

  for (const item of lista) {
    const nome = String(item.nome || "").trim();
    const email = String(item.email || "").trim().toLowerCase();
    const papel = String(item.papel || "").trim();

    if (!nome || !email) { recusados.push({ email, motivo: "sem nome ou e-mail" }); continue; }
    if (!modulos.papelValido(moduloId, papel)) {
      recusados.push({ email, motivo: `papel "${papel}" nao existe em ${moduloId}` });
      continue;
    }

    const achado = await db.query(
      "SELECT id, nome, super_admin FROM usuarios WHERE LOWER(email) = $1",
      [email]
    );

    if (achado.rows[0]) {
      const u = achado.rows[0];
      if (!u.super_admin) {
        await db.query(
          `INSERT INTO usuario_modulos (usuario_id, modulo, papel) VALUES ($1,$2,$3)
           ON CONFLICT (usuario_id, modulo) DO UPDATE SET papel = EXCLUDED.papel`,
          [u.id, moduloId, papel]
        );
      }
      jaExistiam.push({ email, nome: u.nome, papel, superAdmin: u.super_admin });
      continue;
    }

    const id = "u" + crypto.randomBytes(9).toString("hex");
    const senha = senhaAleatoria();
    await db.transaction(async (c) => {
      await c.query(
        `INSERT INTO usuarios (id, nome, email, senha, senha_temp) VALUES ($1,$2,$3,$4,TRUE)`,
        [id, nome, email, auth.gerarHash(senha)]
      );
      await c.query(
        "INSERT INTO usuario_modulos (usuario_id, modulo, papel) VALUES ($1,$2,$3)",
        [id, moduloId, papel]
      );
    });
    criados.push({ nome, email, papel, senha });
  }

  const larguraEmail = Math.max(20, ...criados.map(c => c.email.length));
  console.log("\n=========================================================");
  console.log(` IMPORTACAO PARA O MODULO: ${moduloId}`);
  console.log("=========================================================\n");

  if (criados.length) {
    console.log(`CRIADOS (${criados.length}) — senha provisoria, troca obrigatoria no 1o acesso:\n`);
    console.log("  " + "E-MAIL".padEnd(larguraEmail) + "  SENHA         PAPEL");
    console.log("  " + "-".repeat(larguraEmail) + "  ------------  ----------");
    for (const c of criados) {
      console.log("  " + c.email.padEnd(larguraEmail) + "  " + c.senha.padEnd(12) + "  " + c.papel);
    }
    console.log("\n  Estas senhas aparecem UMA VEZ e nao ficam guardadas em lugar nenhum.\n");
  }

  if (jaExistiam.length) {
    console.log(`JA EXISTIAM (${jaExistiam.length}) — senha mantida, modulo concedido:\n`);
    for (const j of jaExistiam) {
      console.log(`  ${j.email}  ->  ${j.superAdmin ? "administrador geral (ja enxerga tudo)" : j.papel}`);
    }
    console.log("");
  }

  if (recusados.length) {
    console.log(`RECUSADOS (${recusados.length}):\n`);
    for (const r of recusados) console.log(`  ${r.email || "(sem e-mail)"}  ->  ${r.motivo}`);
    console.log("");
  }

  await db.pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
