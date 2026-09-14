// O Core avisa o CRM de quem tem acesso a ele — sem esperar a primeira visita.
//
// POR QUE ESTE TESTE EXISTE
// O CRM so criava a pessoa quando ela abria o sistema. Cadastrar um vendedor no
// UniGestao nao bastava para passar um negocio para ele antes disso (13/09/2026).
//
// Confere, sem CRM de verdade (o fetch e de mentira):
//   1. quem entra na lista: conta ativa com o CRM marcado, ou super admin
//   2. o pacote sai assinado e o CRM consegue conferir
//   3. o pacote nao serve para outra coisa: adulterado, vencido, repetido, de
//      outro modulo, ou usado como bilhete de identidade
//   4. sem as variaveis, fica desligado — e nao quebra o cadastro
//
// Exige o PostgreSQL de desenvolvimento (nao precisa do Core no ar).
"use strict";

process.env.DATABASE_URL = process.env.DATABASE_URL
  || "postgres://postgres:teste@localhost:55987/unigestao";

const crypto = require("crypto");
const db = require("../core/db");
const sincroniaCrm = require("../core/sincronia-crm");
const sincronia = require("../integracao/sincronia");
const identidade = require("../integracao/identidade");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const ENV = { URL_CRM: "https://crm.exemplo/", UG_ASSINATURA_SEGREDO: "segredo-de-teste-sincronia" };

(async () => {
  await db.init();
  await db.query("DELETE FROM usuarios WHERE email LIKE 'sinc.%@uniseter.com'");

  async function criar(apelido, { ativo = true, superAdmin = false, crm = null, outro = null } = {}) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await db.query(
      `INSERT INTO usuarios (id, nome, email, senha, ativo, super_admin)
       VALUES ($1,$2,$3,'x',$4,$5)`,
      [id, "Sinc " + apelido, "sinc." + apelido + "@uniseter.com", ativo, superAdmin]
    );
    if (crm) await db.query("INSERT INTO usuario_modulos VALUES ($1,'crm',$2)", [id, crm]);
    if (outro) await db.query("INSERT INTO usuario_modulos VALUES ($1,$2,$3)", [id, outro[0], outro[1]]);
    return id;
  }

  const vendedor = await criar("vendedor", { crm: "vendedor" });
  const inativo = await criar("inativo", { ativo: false, crm: "vendedor" });
  const soTarefas = await criar("tarefas", { outro: ["tarefas", "executor"] });
  const chefe = await criar("chefe", { superAdmin: true });

  console.log("\n=== QUEM ENTRA NA LISTA ===");
  const doTeste = (await sincroniaCrm.montarLista()).filter((p) => p.email.startsWith("sinc."));
  const achar = (id) => doTeste.find((p) => p.id === id);
  ok(achar(vendedor) && achar(vendedor).papel === "vendedor", "vendedor com CRM marcado entra, com o papel dele");
  ok(!achar(inativo), "conta desativada fica de fora  <-- e o que faz o CRM desativar la");
  ok(!achar(soTarefas), "quem so tem outro modulo fica de fora");
  ok(achar(chefe) && achar(chefe).papel === "administrador",
     "super admin entra como 'administrador' — o nome do papel no CRM, nao 'admin'");

  console.log("\n=== O PACOTE SAI ASSINADO ===");
  let pedido = null;
  const fetchFalso = async (url, opcoes) => {
    pedido = { url, opcoes };
    return { ok: true, status: 200, text: async () => '{"vinculadas":4}' };
  };
  const r = await sincroniaCrm.enviar({ env: ENV, fetch: fetchFalso });
  ok(r.ok === true, "envio conta como feito quando o CRM responde 200");
  ok(pedido && pedido.url === "https://crm.exemplo/api/unigestao/pessoas", "vai para a rota de sincronia do CRM");
  const assinatura = pedido.opcoes.headers[sincronia.CABECALHO];
  const dados = sincronia.conferirPacote(pedido.opcoes.body, assinatura, "crm", { env: ENV });
  ok(dados && Array.isArray(dados.pessoas) && dados.pessoas.some((p) => p.id === vendedor),
     "o CRM confere a assinatura e le a lista");
  ok(pedido.opcoes.signal, "sai com prazo — CRM lento nao prende o Core");

  console.log("\n=== O PACOTE NAO SERVE PARA OUTRA COISA ===");
  const novo = () => sincronia.assinarPacote("crm", { pessoas: [{ id: "u1" }] }, { env: ENV });
  {
    const p = novo();
    ok(sincronia.conferirPacote(p.corpo, p.assinatura, "crm", { env: ENV }) !== null, "pacote integro passa");
    ok(sincronia.conferirPacote(p.corpo, p.assinatura, "crm", { env: ENV }) === null,
       "o mesmo pacote de novo nao passa (repeticao)");
  }
  {
    const p = novo();
    const adulterado = p.corpo.replace('"u1"', '"u2"');
    ok(sincronia.conferirPacote(adulterado, p.assinatura, "crm", { env: ENV }) === null,
       "corpo mexido nao passa");
  }
  {
    const p = novo();
    ok(sincronia.conferirPacote(p.corpo, p.assinatura, "crm",
       { env: { UG_ASSINATURA_SEGREDO: "outro-segredo" } }) === null, "outro segredo nao passa");
  }
  {
    const p = sincronia.assinarPacote("tarefas", { pessoas: [] }, { env: ENV });
    ok(sincronia.conferirPacote(p.corpo, p.assinatura, "crm", { env: ENV }) === null,
       "pacote para outro modulo nao passa no CRM");
  }
  {
    const antigo = sincronia.assinarPacote("crm", { pessoas: [] },
      { env: ENV, agoraMs: Date.now() - 5 * 60 * 1000 });
    ok(sincronia.conferirPacote(antigo.corpo, antigo.assinatura, "crm", { env: ENV }) === null,
       "pacote vencido nao passa");
  }
  {
    // A assinatura de sincronia usa chave derivada com outro rotulo: nao vale
    // como bilhete de identidade, mesmo vindo do mesmo segredo.
    const p = novo();
    const comoBilhete = Buffer.from(p.corpo).toString("base64url") + "." + p.assinatura;
    ok(identidade.verificar(comoBilhete, { env: ENV }) === null,
       "assinatura de sincronia nao vira bilhete de identidade");
  }

  console.log("\n=== SEM AS VARIAVEIS, DESLIGADO ===");
  let chamou = false;
  const semVar = await sincroniaCrm.enviar({ env: {}, fetch: async () => { chamou = true; } });
  ok(semVar.desligada === true && !chamou, "sem URL_CRM/segredo nao tenta sair");

  await db.query("DELETE FROM usuarios WHERE email LIKE 'sinc.%@uniseter.com'");
  await db.pool.end();
  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exitCode = falhas === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
