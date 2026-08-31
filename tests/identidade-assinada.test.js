// A identidade que a Fachada entrega ao modulo precisa ser ASSINADA — e o
// modulo so pode acreditar nela depois de conferir a assinatura.
//
// POR QUE ESTE TESTE EXISTE
// O desenho antigo mandava a identidade em cabecalhos soltos (`x-ug-id`,
// `x-ug-papel`, `x-ug-super`) e validava tudo com um segredo que vinha JUNTO,
// no `x-ug-key`. Quem tivesse esse segredo montava um administrador num curl,
// so trocando dois cabecalhos — e o segredo viajava em toda requisicao, para
// todo modulo, entao bastava um modulo comprometido, ou um log, para vazar.
//
// O que este arquivo prova, na ordem em que um ataque tentaria:
//   1. cabecalho forjado sem assinatura nao autentica
//   2. assinatura errada nao autentica
//   3. bilhete vencido nao autentica
//   4. bilhete valido autentica
//   5. NAO da para virar administrador mexendo em papel/super
//   6. bilhete de um modulo nao vale em outro
//   7. bilhete nao pode ser reapresentado
//   8. a copia da Fachada e igual a canonica (senao um lado evolui sozinho)
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const RAIZ = path.join(__dirname, "..");
const identidade = require(path.join(RAIZ, "integracao", "identidade.js"));

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const ENV = { CORE_INTERNAL_KEY: "chave-de-desenvolvimento" };

// O modulo de verdade (integracao/unigestao.js) le process.env na carga, entao
// aqui ele e carregado com o ambiente ja montado — e recarregado quando o teste
// precisa de outro ambiente.
function carregarModulo(env = {}) {
  const guardado = { ...process.env };
  Object.assign(process.env, ENV, env);
  const alvo = require.resolve(path.join(RAIZ, "integracao", "unigestao.js"));
  delete require.cache[alvo];
  delete require.cache[require.resolve(path.join(RAIZ, "integracao", "identidade.js"))];
  const mod = require(alvo);
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, guardado);
  return mod;
}

// Uma requisicao de mentira, so com o que o middleware le.
const req = (headers) => ({ headers });

// Roda o middleware e devolve o req.usuario resultante.
function quemE(mod, headers) {
  const r = req(headers);
  mod.identificar(r, {}, () => {});
  return r.usuario;
}

(async () => {
  const ug = carregarModulo();

  console.log("\n=== 1. CABECALHOS FORJADOS, SEM ASSINATURA, NAO AUTENTICAM ===");
  // Este e o ataque do relatorio: um curl com os cabecalhos na mao.
  const forjado = {
    "x-ug-id": "u-invasor",
    "x-ug-nome": "Invasor",
    "x-ug-email": "invasor@exemplo.com",
    "x-ug-papel": "admin",
    "x-ug-super": "1",
  };
  ok(quemE(ug, forjado) === null,
     "identidade em cabecalhos soltos e IGNORADA por completo");

  ok(quemE(ug, { ...forjado, "x-ug-key": ENV.CORE_INTERNAL_KEY }) === null,
     "e nem com a chave interna correta ela passa  <-- era o furo");

  ok(quemE(ug, {}) === null, "sem cabecalho nenhum, ninguem entra");

  console.log("\n=== 2. ASSINATURA INVALIDA NAO AUTENTICA ===");
  const bom = identidade.assinar(
    { id: "u1", nome: "Fulana", email: "fulana@uniseter.com", papel: "cco",
      superAdmin: false, modulo: "operacional" }, { env: ENV });

  const [corpo, assinatura] = bom.split(".");
  ok(quemE(ug, { "x-ug-identidade": corpo + ".", }) === null, "assinatura vazia nao passa");
  ok(quemE(ug, { "x-ug-identidade": corpo + "." + "a".repeat(assinatura.length) }) === null,
     "assinatura trocada por outra do mesmo tamanho nao passa");
  ok(quemE(ug, { "x-ug-identidade": corpo }) === null, "bilhete sem assinatura nao passa");
  ok(quemE(ug, { "x-ug-identidade": "nada disso" }) === null, "texto qualquer nao passa");

  // Assinado com OUTRO segredo: e o caso de quem tenta emitir bilhete por fora.
  const deOutraChave = identidade.assinar(
    { id: "u-invasor", papel: "admin", superAdmin: true, modulo: "operacional" },
    { env: { CORE_INTERNAL_KEY: "outro-segredo-qualquer" } });
  ok(quemE(ug, { "x-ug-identidade": deOutraChave }) === null,
     "bilhete assinado com outro segredo nao passa");

  console.log("\n=== 3. BILHETE VENCIDO NAO AUTENTICA ===");
  const velho = identidade.assinar(
    { id: "u1", papel: "cco", modulo: "operacional" },
    { env: ENV, agoraMs: Date.now() - 10 * 60 * 1000 });
  ok(quemE(ug, { "x-ug-identidade": velho }) === null,
     "dez minutos depois o bilhete nao vale mais");

  // E o contrario tambem: bilhete emitido no futuro e recusado. Sem isso,
  // bastaria adiantar o relogio para fabricar validade longa.
  const doFuturo = identidade.assinar(
    { id: "u1", papel: "cco", modulo: "operacional" },
    { env: ENV, agoraMs: Date.now() + 60 * 60 * 1000 });
  ok(quemE(ug, { "x-ug-identidade": doFuturo }) === null,
     "bilhete com data la na frente tambem e recusado");

  console.log("\n=== 4. BILHETE VALIDO AUTENTICA ===");
  const u = quemE(ug, { "x-ug-identidade": bom });
  ok(u !== null, "identidade assinada e aceita");
  ok(u && u.id === "u1", "com o id que veio assinado");
  ok(u && u.nome === "Fulana", "o nome");
  ok(u && u.email === "fulana@uniseter.com", "o e-mail");
  ok(u && u.papel === "cco" && u.nivel === "cco",
     "o papel — e `nivel` continua espelhando, como os sistemas esperam");
  ok(u && u.superAdmin === false, "e super admin falso");

  console.log("\n=== 5. NAO DA PARA VIRAR ADMINISTRADOR MEXENDO NOS CABECALHOS ===");
  // O ponto central do relatorio: papel e super-admin nao sao mais campos
  // avulsos que dao para trocar. Eles andam LACRADOS com o resto.
  // Bilhete NOVO: o `bom` ja foi apresentado ali em cima, e bilhete usado nao
  // vale de novo (secao 7). Reaproveitar aqui testaria a repeticao, nao a
  // elevacao.
  const outroBom = identidade.assinar(
    { id: "u1", nome: "Fulana", email: "fulana@uniseter.com", papel: "cco",
      superAdmin: false, modulo: "operacional" }, { env: ENV });
  const tentandoSubir = quemE(ug, {
    "x-ug-identidade": outroBom,     // bilhete legitimo de um 'cco'
    "x-ug-papel": "admin",           // ... com os cabecalhos antigos mentindo
    "x-ug-super": "1",
    "x-ug-key": ENV.CORE_INTERNAL_KEY,
  });
  ok(tentandoSubir && tentandoSubir.papel === "cco",
     "o papel continua o do bilhete, nao o do cabecalho solto");
  ok(tentandoSubir && tentandoSubir.superAdmin === false,
     "e super admin continua falso  <-- a elevacao que o relatorio apontou");

  // Mexer DENTRO do bilhete tambem nao adianta: a assinatura cobre o corpo.
  const corpoMexido = JSON.parse(
    Buffer.from(corpo.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
  corpoMexido.papel = "admin";
  corpoMexido.super = true;
  const remontado = Buffer.from(JSON.stringify(corpoMexido)).toString("base64")
    .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  ok(quemE(ug, { "x-ug-identidade": remontado + "." + assinatura }) === null,
     "editar o conteudo do bilhete invalida a assinatura");

  console.log("\n=== 6. BILHETE DE UM MODULO NAO VALE EM OUTRO ===");
  // Sem isto, um bilhete capturado numa requisicao ao CRM abriria a
  // Precificacao como a mesma pessoa.
  const ugCrm = carregarModulo({ UG_MODULO: "crm" });
  ok(quemE(ugCrm, { "x-ug-identidade": bom }) === null,
     "bilhete emitido para 'operacional' nao vale no 'crm'");
  const doCrm = identidade.assinar(
    { id: "u1", papel: "vendedor", modulo: "crm" }, { env: ENV });
  ok(quemE(ugCrm, { "x-ug-identidade": doCrm }) !== null,
     "e o bilhete do proprio modulo vale");

  console.log("\n=== 7. BILHETE NAO SE APRESENTA DUAS VEZES ===");
  const umaVez = identidade.assinar(
    { id: "u1", papel: "cco", modulo: "operacional" }, { env: ENV });
  ok(quemE(ug, { "x-ug-identidade": umaVez }) !== null, "a primeira vez passa");
  ok(quemE(ug, { "x-ug-identidade": umaVez }) === null,
     "a segunda nao — bilhete capturado nao se reusa dentro da validade");

  console.log("\n=== 8. A FLAG DE COMPATIBILIDADE E EXPLICITA E VEM DESLIGADA ===");
  // Ela existe para destravar uma virada presa, nao para ficar ligada.
  const fonte = fs.readFileSync(
    path.join(RAIZ, "integracao", "unigestao.js"), "utf8");
  ok(/UG_LEGACY_HEADERS_ENABLED === "true"/.test(fonte),
     "so o texto exato 'true' liga o modo antigo");
  const ugLegado = carregarModulo({ UG_LEGACY_HEADERS_ENABLED: "true" });
  ok(quemE(ugLegado, { ...forjado, "x-ug-key": ENV.CORE_INTERNAL_KEY }) !== null,
     "ligada, o modo antigo volta a aceitar cabecalhos soltos (e por isso fica desligada)");
  ok(quemE(ugLegado, forjado) === null,
     "mesmo ligada, sem a chave interna nao entra");
  const ugFlagErrada = carregarModulo({ UG_LEGACY_HEADERS_ENABLED: "1" });
  ok(quemE(ugFlagErrada, { ...forjado, "x-ug-key": ENV.CORE_INTERNAL_KEY }) === null,
     "'1' nao liga: valor ambiguo em variavel de ambiente nao pode abrir a porta");

  console.log("\n=== 9. A COPIA DA FACHADA E IGUAL A CANONICA ===");
  // A Fachada e publicada com a propria pasta na raiz do container e nao
  // alcanca nada de fora dela — por isso existe uma copia. Se as duas puderem
  // divergir, um dia a Fachada assina de um jeito e o modulo confere de outro,
  // e ninguem entra em lugar nenhum.
  const canonico = fs.readFileSync(path.join(RAIZ, "integracao", "identidade.js"));
  const daFachada = fs.readFileSync(path.join(RAIZ, "fachada", "identidade.js"));
  ok(canonico.equals(daFachada),
     "fachada/identidade.js e byte a byte igual a integracao/identidade.js");

  console.log("\n=== 10. SEM SEGREDO NENHUM, NADA E ASSINADO NEM ACEITO ===");
  // Servico mal configurado tem que ficar mudo, nunca permissivo.
  ok(identidade.assinar({ id: "u1" }, { env: {} }) === null,
     "sem chave, a Fachada nao emite bilhete");
  ok(identidade.verificar(bom, { env: {} }) === null,
     "sem chave, o modulo nao aceita bilhete nenhum");

  console.log("\n=== 11. A CHAVE DE ASSINATURA NAO E A CHAVE QUE VIAJA ===");
  // Derivada, e nao a CORE_INTERNAL_KEY crua: assim o valor que trafega no
  // x-ug-key nao e o mesmo que assina.
  const derivada = identidade.chaveDeAssinatura(ENV);
  ok(Buffer.isBuffer(derivada) && derivada.length === 32, "a chave derivada tem 32 bytes");
  ok(!derivada.equals(Buffer.from(ENV.CORE_INTERNAL_KEY, "utf8")),
     "e nao e a CORE_INTERNAL_KEY copiada");
  const dedicada = identidade.chaveDeAssinatura({
    ...ENV, UG_ASSINATURA_SEGREDO: "segredo-proprio-de-assinatura" });
  ok(dedicada.equals(Buffer.from("segredo-proprio-de-assinatura", "utf8")),
     "UG_ASSINATURA_SEGREDO, quando existe, tem precedencia");

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
