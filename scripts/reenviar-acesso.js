"use strict";

// ============================================================================
// Reenviar o acesso de uma conta, opcionalmente para outro endereco
// ----------------------------------------------------------------------------
// USO
//   node scripts/reenviar-acesso.js <email-do-login>
//   node scripts/reenviar-acesso.js <email-do-login> --para=outro@endereco
//
// Gera uma senha provisoria nova, marca a conta para troca obrigatoria no
// proximo acesso e manda o e-mail de acesso.
//
// POR QUE `--para` EXISTE
// Contas funcionais — recepcao, financeiro@, contasapagar@ — tem como login uma
// caixa que ninguem abre. O e-mail de acesso delas foi entregue num lugar onde
// ninguem ia ver, e quem realmente usa a conta ficou sem a senha. Com --para, o
// aviso vai para uma pessoa de verdade e o corpo continua mostrando o login
// correto, que e o que ela precisa digitar.
//
// A senha antiga deixa de valer no momento em que este comando roda. Se a conta
// estiver em uso, quem estava usando vai precisar da senha nova.
// ============================================================================

const crypto = require("crypto");
const db = require("../core/db");
const auth = require("../core/auth");
const modulos = require("../core/modulos");
const correio = require("../core/email");

function senhaAleatoria() {
  return crypto.randomBytes(9).toString("base64url");
}

const ARGS = process.argv.slice(2);
const opcao = (nome) => {
  const a = ARGS.find((x) => x.startsWith("--" + nome + "="));
  return a ? a.slice(nome.length + 3).trim() : "";
};
const login = String(ARGS.find((x) => !x.startsWith("--")) || "").toLowerCase().trim();
const PARA = opcao("para").toLowerCase();

(async () => {
  if (!login) {
    console.error("uso: node scripts/reenviar-acesso.js <email-do-login> [--para=outro@endereco]");
    process.exit(1);
  }
  if (correio.modo() === "desligado") {
    console.error("Nao ha para onde mandar: falta SENDGRID_API_KEY.");
    console.error("Nada foi alterado — a senha atual continua valendo.");
    process.exit(1);
  }

  const r = await db.query(
    "SELECT id, nome, email, ativo FROM usuarios WHERE LOWER(email) = $1", [login]
  );
  const u = r.rows[0];
  if (!u) {
    console.error(`Nenhuma conta com o login ${login}.`);
    process.exit(1);
  }
  if (!u.ativo) {
    console.error(`A conta ${login} esta desativada. Reative antes de reenviar o acesso.`);
    process.exit(1);
  }

  const mods = await db.query(
    "SELECT modulo, papel FROM usuario_modulos WHERE usuario_id = $1", [u.id]
  );
  const lista = mods.rows
    .filter((m) => modulos.existe(m.modulo))
    .map((m) => ({
      nome: modulos.get(m.modulo).nome,
      papelRotulo: modulos.rotuloDoPapel(m.modulo, m.papel),
    }));

  const senha = senhaAleatoria();
  await db.query(
    "UPDATE usuarios SET senha = $1, senha_temp = TRUE WHERE id = $2",
    [auth.gerarHash(senha), u.id]
  );

  const destino = PARA || u.email;
  const envio = await correio.avisarContaNova({
    nome: u.nome, email: u.email, senha, modulos: lista, para: destino,
  });

  console.log(`conta.......: ${u.nome} <${u.email}>`);
  console.log(`modulos.....: ${lista.map((m) => m.nome).join(", ") || "(nenhum)"}`);
  console.log(`enviado para: ${destino}${PARA ? "  (diferente do login, a pedido)" : ""}`);
  console.log(`resultado...: ${envio.ok ? "enviado" : "FALHOU — " + envio.erro}`);
  if (!envio.ok) {
    console.log("");
    console.log("A senha JA FOI trocada. Como o e-mail nao saiu, esta conta ficou");
    console.log("sem ninguem sabendo a senha nova — rode de novo assim que o envio voltar.");
  }
  console.log("\nA senha anterior deixou de valer agora.");
  process.exit(envio.ok ? 0 : 1);
})().catch((e) => { console.error(e.message); process.exit(1); });
