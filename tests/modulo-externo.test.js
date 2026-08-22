// Sistema de TERCEIRO no portal: aparece, mas nao entra.
//
// POR QUE ESTE TESTE EXISTE
// Os seis sistemas do Grupo trocaram a autenticacao propria pela identidade do
// Core (integracao/unigestao.js) — da para fazer isso porque o codigo e nosso.
// O Nexti e do fornecedor, roda na nuvem dele, e nada disso vale la.
//
// O risco que este arquivo guarda e um so: alguem, mais tarde, achar que
// "modulo e modulo" e apontar a Fachada para o endereco de fora. Se isso
// acontecesse, a chave interna (CORE_INTERNAL_KEY) e os cabecalhos de
// identidade sairiam da rede privada do Railway em direcao a um servidor de
// terceiro. Por isso o Core RECUSA dar sessao a um modulo externo, e o teste
// abaixo e o que impede essa recusa de ser removida sem querer.
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");
const modulos = require("../core/modulos.js");

const CORE = "http://localhost:3000";
const CONEXAO = "postgres://postgres:teste@localhost:55987/unigestao";
const CHAVE = "chave-de-desenvolvimento";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM login_attempts");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'ext.%@uniseter.com'");

  async function criar(email, nome, acessos) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await pool.query("INSERT INTO usuarios (id,nome,email,senha) VALUES ($1,$2,$3,$4)",
      [id, nome, email, auth.gerarHash("SenhaTeste@123")]);
    for (const [m, p] of acessos) {
      await pool.query("INSERT INTO usuario_modulos (usuario_id,modulo,papel) VALUES ($1,$2,$3)",
        [id, m, p]);
    }
    const r = await fetch(`${CORE}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, senha: "SenhaTeste@123" }),
    });
    const token = (r.headers.get("set-cookie").match(/unigestao_sessao=([^;]+)/) || [])[1];
    return { id, token };
  }
  const C = (t) => ({ headers: { cookie: "unigestao_sessao=" + t } });

  console.log("\n=== O REGISTRO SABE QUEM E DE FORA ===");
  ok(modulos.ehExterno("nexti") === true, "o Nexti e marcado como sistema de terceiro");
  ok(modulos.ehExterno("crm") === false, "e um sistema nosso nao e");
  const nexti = modulos.get("nexti");
  ok(!nexti.interno && !nexti.base,
     "sistema de terceiro nao tem endereco interno nem caminho na Fachada");
  ok(/^https:\/\//.test(nexti.externo), "o endereco dele e absoluto e https");

  // A Fachada tem o proprio registro, e e ele que vira rota. Se `nexti`
  // aparecesse la, /nexti passaria a ser encaminhado — exatamente o que nao
  // pode acontecer.
  const fonteFachada = require("fs").readFileSync(
    require("path").join(__dirname, "..", "fachada", "server.js"), "utf8");
  const mapa = fonteFachada.slice(fonteFachada.indexOf("const MODULOS = {"));
  ok(!mapa.slice(0, mapa.indexOf("};")).includes("nexti"),
     "e a Fachada NAO tem rota para ele — /nexti nao existe no portal");

  console.log("\n=== O CARTAO APARECE PARA QUEM TEM ACESSO ===");
  const ana = await criar("ext.ana@uniseter.com", "Ana Souza", [["nexti", "acesso"]]);
  const eu = await (await fetch(`${CORE}/api/eu`, C(ana.token))).json();
  const cartao = eu.modulos.find((m) => m.id === "nexti");
  ok(Boolean(cartao), "quem recebeu acesso ve o cartao");
  ok(cartao.externo === "https://uniseter.nexti.com/", "com o endereco do fornecedor");
  ok(cartao.papelRotulo === "Acesso", "e o rotulo do papel unico");

  const bruno = await criar("ext.bruno@uniseter.com", "Bruno Lima", [["crm", "vendedor"]]);
  const euB = await (await fetch(`${CORE}/api/eu`, C(bruno.token))).json();
  ok(!euB.modulos.some((m) => m.id === "nexti"),
     "e quem nao recebeu nao ve — o cartao nao nasce liberado para todo mundo");

  console.log("\n=== MAS O PORTAL NAO DA IDENTIDADE PARA FORA ===");
  const sessao = await fetch(`${CORE}/api/interno/sessao?modulo=nexti`,
    { headers: { "x-unigestao-token": ana.token, "x-core-key": CHAVE } });
  ok(sessao.status === 400, "pedir sessao para o sistema de terceiro e recusado");
  const corpo = await sessao.json();
  ok(!JSON.stringify(corpo).includes(ana.id),
     "e a recusa nao vaza nem o id da pessoa");

  // O mesmo pedido, para um modulo nosso, continua funcionando: a recusa acima
  // e sobre ser externo, nao um bloqueio geral que quebrou o resto.
  const doCrm = await fetch(`${CORE}/api/interno/sessao?modulo=crm`,
    { headers: { "x-unigestao-token": bruno.token, "x-core-key": CHAVE } });
  ok(doCrm.status === 200, "um modulo nosso segue recebendo a identidade normalmente");

  console.log("\n=== ADMIN GERAL CONSEGUE CONCEDER ===");
  await pool.query("UPDATE usuarios SET super_admin = TRUE WHERE id = $1", [bruno.id]);
  const lista = await (await fetch(`${CORE}/api/admin/modulos`, C(bruno.token))).json();
  const noAdmin = lista.find((m) => m.id === "nexti");
  ok(Boolean(noAdmin), "o sistema de terceiro aparece na tela do Admin Geral");
  ok(noAdmin.papeis.length === 1 && noAdmin.papeis[0].valor === "acesso",
     "com um papel so: quem manda la dentro e o login do fornecedor");
  ok(noAdmin.externo === "https://uniseter.nexti.com/",
     "e a tela recebe o endereco para poder avisar que o acesso e por fora");

  await pool.query("DELETE FROM usuarios WHERE email LIKE 'ext.%@uniseter.com'");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
