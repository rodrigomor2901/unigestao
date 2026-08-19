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
// OPCOES
//   --previa=<email>   nao importa nada: manda uma mensagem de exemplo para
//                      esse endereco, para conferir como chega na caixa de
//                      entrada antes de disparar para todo mundo
//   --enviar           alem de importar, manda o e-mail de acesso a cada
//                      pessoa. Sem isso, as senhas so aparecem na tela — que
//                      era o unico jeito antes deste sistema saber enviar.
//   --somente=novos    importa so quem ainda nao tem conta no Core; quem ja
//                      tem fica intocado para uma rodada seguinte. Existe por
//                      causa do limite diario de e-mail do SendGrid, que pode
//                      nao caber a lista inteira num dia so.
//
// Sem --enviar a saida traz a lista de e-mails e senhas geradas, para repassar
// a mao. Ela aparece UMA VEZ: as senhas nao ficam guardadas em lugar nenhum.
// ============================================================================

const crypto = require("crypto");
const db = require("../core/db");
const auth = require("../core/auth");
const modulos = require("../core/modulos");
const correio = require("../core/email");

function senhaAleatoria() {
  // 12 caracteres, sem simbolos ambiguos para quem vai digitar
  return crypto.randomBytes(9).toString("base64url");
}

const ARGS = process.argv.slice(2);
const opcao = (nome) => {
  const a = ARGS.find((x) => x.startsWith("--" + nome + "="));
  return a ? a.slice(nome.length + 3).trim() : "";
};
const ENVIAR = ARGS.includes("--enviar");
const PREVIA = opcao("previa");

// --somente=novos importa APENAS quem ainda nao tem conta no Core, e nem
// encosta em quem ja tem. Serve para partir a importacao em dois dias quando o
// limite diario de e-mail nao cabe a lista inteira.
//
// Rodar de novo depois, sem a opcao, completa o servico sem repetir ninguem:
// quem foi criado no primeiro dia ja tem o modulo, e o script so avisa quem
// ganhou algo novo.
const SOMENTE_NOVOS = opcao("somente") === "novos";
const soArgs = ARGS.filter((x) => !x.startsWith("--"));

(async () => {
  const moduloId = String(soArgs[0] || "").trim();
  const b64 = String(soArgs[1] || "").trim();

  // Previa: nao toca no banco e nao importa ninguem. Serve para ver as duas
  // mensagens chegando de verdade antes de disparar para uma lista inteira —
  // e-mail enviado nao volta atras.
  if (PREVIA) {
    // "rascunho" serve: a mensagem vai para o arquivo em vez do mundo, que e
    // exatamente o que se quer ao ensaiar. So "desligado" impede.
    if (correio.modo() === "desligado") {
      console.error("Nao ha para onde mandar: falta SENDGRID_API_KEY (ou EMAIL_ARQUIVO).");
      process.exit(1);
    }
    const nomeModulo = modulos.get(moduloId) ? modulos.get(moduloId).nome : "Módulo de Exemplo";
    const exemplo = [{ nome: nomeModulo, papelRotulo: "Exemplo" }];
    // So a mensagem de conta nova. As duas usam a mesma moldura e o mesmo
    // botao, entao mandar as duas gastaria dois creditos para conferir a mesma
    // coisa — e o plano do SendGrid tem limite diario.
    const r1 = await correio.avisarContaNova({
      nome: "Exemplo", email: PREVIA, senha: "EstaSenhaEUmExemplo", modulos: exemplo,
    });
    console.log("previa para " + PREVIA + ":");
    console.log("  conta nova ..: " + (r1.ok ? "enviado" : "FALHOU — " + r1.erro));
    console.log("\nNada foi importado. Confira a caixa de entrada antes de rodar de verdade.");
    process.exit(r1.ok ? 0 : 1);
  }

  if (!moduloId || !b64) {
    console.error("uso: node scripts/importar-usuarios.js <modulo> <json-em-base64> [--enviar]");
    console.error("     node scripts/importar-usuarios.js <modulo> --previa=<email>");
    process.exit(1);
  }
  // A trava e contra criar dezenas de contas cuja senha ninguem receberia — as
  // senhas nao ficam guardadas para reenviar depois. Em "rascunho" a mensagem
  // ainda existe (vai para o arquivo), entao so "desligado" e motivo para parar.
  if (ENVIAR && correio.modo() === "desligado") {
    console.error("--enviar pedido, mas nao ha para onde mandar (falta SENDGRID_API_KEY).");
    console.error("Nada foi importado — corrija a configuracao antes, para nao criar");
    console.error("dezenas de contas cuja senha ninguem vai receber.");
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
  const adiados = [];

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

    if (achado.rows[0] && SOMENTE_NOVOS) {
      adiados.push({ email, nome: achado.rows[0].nome, papel });
      continue;
    }

    if (achado.rows[0]) {
      const u = achado.rows[0];
      // Saber se o modulo e NOVO para essa pessoa decide se ela recebe aviso:
      // quem ja tinha o modulo nao ganhou nada e nao pode ser avisada de nada.
      let moduloNovo = false;
      if (!u.super_admin) {
        const tinha = await db.query(
          "SELECT 1 FROM usuario_modulos WHERE usuario_id = $1 AND modulo = $2",
          [u.id, moduloId]
        );
        moduloNovo = tinha.rowCount === 0;
        await db.query(
          `INSERT INTO usuario_modulos (usuario_id, modulo, papel) VALUES ($1,$2,$3)
           ON CONFLICT (usuario_id, modulo) DO UPDATE SET papel = EXCLUDED.papel`,
          [u.id, moduloId, papel]
        );
      }
      jaExistiam.push({ email, nome: u.nome, papel, superAdmin: u.super_admin, moduloNovo });
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

  if (adiados.length) {
    console.log(`ADIADOS (${adiados.length}) — ja tem conta no Core; nada foi alterado neles.`);
    console.log("  Rode de novo sem --somente=novos para conceder o modulo e avisa-los.");
    console.log("");
  }

  if (recusados.length) {
    console.log(`RECUSADOS (${recusados.length}):\n`);
    for (const r of recusados) console.log(`  ${r.email || "(sem e-mail)"}  ->  ${r.motivo}`);
    console.log("");
  }

  if (ENVIAR) {
    const rotulo = modulos.rotuloDoPapel.bind(null, moduloId);
    const nomeDoModulo = modulos.get(moduloId).nome;
    const falhas = [];
    let enviados = 0;

    console.log("=== ENVIANDO OS AVISOS ===\n");

    // Quem acabou de ganhar conta: recebe a senha provisoria.
    for (const c of criados) {
      const r = await correio.avisarContaNova({
        nome: c.nome, email: c.email, senha: c.senha,
        modulos: [{ nome: nomeDoModulo, papelRotulo: rotulo(c.papel) }],
      });
      if (r.ok) enviados++;
      else falhas.push({ email: c.email, erro: r.erro, tipo: "conta nova" });
    }

    // Quem ja entrava no UniGestao: so o aviso do modulo, sem senha nenhuma.
    // Super admin fica de fora: ele ja enxergava este modulo antes da importacao.
    for (const j of jaExistiam.filter((x) => x.moduloNovo)) {
      const r = await correio.avisarModuloNovo({
        nome: j.nome, email: j.email,
        modulos: [{ nome: nomeDoModulo, papelRotulo: rotulo(j.papel) }],
      });
      if (r.ok) enviados++;
      else falhas.push({ email: j.email, erro: r.erro, tipo: "modulo novo" });
    }

    console.log(`  enviados: ${enviados}`);
    if (falhas.length) {
      console.log(`  FALHARAM: ${falhas.length} — estas pessoas precisam ser avisadas a mao:\n`);
      for (const f of falhas) console.log(`    ${f.email}  (${f.tipo})  ->  ${f.erro}`);
    }
    console.log("");
  } else if (criados.length) {
    console.log("Nenhum e-mail foi enviado (rode com --enviar para isso).\n");
  }

  await db.pool.end();
})().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
