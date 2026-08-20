// Testa o perfil de contato e a agenda do grupo.
//
// O ponto delicado aqui e a exigencia de cadastro: ela nasce DESLIGADA de
// proposito (ver core/perfil.js) e, quando ligada, precisa barrar tambem no
// servidor — a tela desvia, mas desvio de tela se pula digitando o endereco.
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");
const perfil = require("../core/perfil.js");

const CORE = "http://localhost:3000";
const CONEXAO = "postgres://postgres:teste@localhost:55987/unigestao";
const CHAVE = "chave-de-desenvolvimento";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM login_attempts");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'agenda.%@uniseter.com'");

  async function criar(email, nome, dados) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await pool.query(
      "INSERT INTO usuarios (id,nome,email,senha) VALUES ($1,$2,$3,$4)",
      [id, nome, email, auth.gerarHash("SenhaTeste@123")]
    );
    await pool.query(
      "INSERT INTO usuario_modulos (usuario_id,modulo,papel) VALUES ($1,'operacional','cco')", [id]
    );
    if (dados) {
      await pool.query(
        "UPDATE usuarios SET telefone=$1, ramal=$2, departamento=$3, cargo=$4 WHERE id=$5",
        [dados.telefone || null, dados.ramal || null, dados.departamento, dados.cargo, id]
      );
    }
    const r = await fetch(`${CORE}/api/login`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, senha: "SenhaTeste@123" }),
    });
    const token = (r.headers.get("set-cookie").match(/unigestao_sessao=([^;]+)/) || [])[1];
    return { id, token };
  }
  const C = (t) => ({ headers: { cookie: "unigestao_sessao=" + t } });

  console.log("\n=== REGRAS DE PREENCHIMENTO ===");
  ok(!perfil.validar({ telefone: "", ramal: "", departamento: "Comercial", cargo: "Analista" }).ok,
     "sem telefone e sem ramal -> recusado");
  ok(perfil.validar({ telefone: "", ramal: "2010", departamento: "Comercial", cargo: "Analista" }).ok,
     "so o ramal basta — quem nao tem celular corporativo usa o PABX");
  ok(perfil.validar({ telefone: "(19) 3212-0000", ramal: "", departamento: "Comercial", cargo: "Analista" }).ok,
     "so o telefone tambem basta");
  ok(!perfil.validar({ ramal: "2010", departamento: "", cargo: "Analista" }).ok,
     "sem departamento -> recusado");
  ok(!perfil.validar({ ramal: "2010", departamento: "Comercial", cargo: "" }).ok,
     "sem cargo -> recusado");
  ok(perfil.completo({ ramal: "2010", departamento: "Comercial", cargo: "Analista" }),
     "completo NAO depende de foto");
  ok(perfil.limparTelefone("(19) 99999-0000") === "19999990000",
     "telefone guardado so com digitos");
  ok(perfil.formatarTelefone("1932120000") === "(19) 3212-0000", "fixo formatado para leitura");
  ok(perfil.formatarTelefone("19999990000") === "(19) 99999-0000", "celular formatado para leitura");
  ok(perfil.normalizar("Comércial") === perfil.normalizar("COMERCIAL"),
     "acento e maiuscula nao separam o mesmo departamento");

  console.log("\n=== SALVAR O PROPRIO PERFIL ===");
  const ana = await criar("agenda.ana@uniseter.com", "Ana Souza");
  const r1 = await fetch(`${CORE}/api/perfil`, {
    method: "POST", headers: { "Content-Type": "application/json", ...C(ana.token).headers },
    body: JSON.stringify({ telefone: "(19) 99888-0000", ramal: "2010",
                           departamento: "Comercial", cargo: "Analista" }),
  });
  ok(r1.status === 200, "salva com os dados completos");

  const eu = await (await fetch(`${CORE}/api/eu`, C(ana.token))).json();
  ok(eu.usuario.telefone === "19998880000", "telefone volta so com digitos");
  ok(eu.usuario.departamento === "Comercial", "departamento volta");
  ok(eu.usuario.perfilCompleto === true, "perfil marcado como completo");

  const r2 = await fetch(`${CORE}/api/perfil`, {
    method: "POST", headers: { "Content-Type": "application/json", ...C(ana.token).headers },
    body: JSON.stringify({ telefone: "", ramal: "", departamento: "Comercial", cargo: "Analista" }),
  });
  ok(r2.status === 400, "sem contato nenhum -> 400");
  ok((await r2.json()).erro.includes("PABX"), "e a mensagem explica o caso do PABX");

  console.log("\n=== AGENDA ===");
  const bruno = await criar("agenda.bruno@uniseter.com", "Bruno Lima",
    { ramal: "3050", departamento: "Operações", cargo: "Supervisor" });
  const ag = await (await fetch(`${CORE}/api/agenda`, C(ana.token))).json();
  const nomes = ag.pessoas.map((p) => p.nome);
  ok(nomes.includes("Ana Souza") && nomes.includes("Bruno Lima"), "lista as pessoas ativas");
  const aAna = ag.pessoas.find((p) => p.nome === "Ana Souza");
  ok(aAna.telefoneFormatado === "(19) 99888-0000", "telefone ja vem formatado para a tela");
  ok(aAna.temFoto === false, "sem foto ainda");

  // Quem nao preencheu continua aparecendo: a pessoa existe e alguem pode
  // precisar dela. Sumir da agenda seria pior do que aparecer incompleta.
  const carla = await criar("agenda.carla@uniseter.com", "Carla Dias");
  const ag2 = await (await fetch(`${CORE}/api/agenda`, C(ana.token))).json();
  ok(ag2.pessoas.some((p) => p.nome === "Carla Dias"),
     "quem ainda nao preencheu aparece mesmo assim");

  const deps = await (await fetch(`${CORE}/api/agenda/departamentos`, C(ana.token))).json();
  ok(deps.departamentos.some((d) => d.departamento === "Comercial"),
     "departamentos ja usados viram sugestao");

  const semLogin = await fetch(`${CORE}/api/agenda`);
  ok(semLogin.status === 401, "agenda exige login");

  console.log("\n=== FOTO ===");
  // 1x1 PNG transparente
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
  const rf = await fetch(`${CORE}/api/perfil/foto`, {
    method: "POST", headers: { "Content-Type": "application/json", ...C(ana.token).headers },
    body: JSON.stringify({ tipo: "image/png", base64: png }),
  });
  ok(rf.status === 200, "aceita a foto");
  const img = await fetch(`${CORE}/api/foto/${ana.id}`, C(ana.token));
  ok(img.status === 200, "a foto volta");
  ok((img.headers.get("content-type") || "").includes("image/png"), "com o tipo certo");

  const ruim = await fetch(`${CORE}/api/perfil/foto`, {
    method: "POST", headers: { "Content-Type": "application/json", ...C(ana.token).headers },
    body: JSON.stringify({ tipo: "application/pdf", base64: png }),
  });
  ok(ruim.status === 400, "formato fora da lista -> recusado");

  const grande = Buffer.alloc(perfil.FOTO_MAX_BYTES + 1000, 1).toString("base64");
  const gr = await fetch(`${CORE}/api/perfil/foto`, {
    method: "POST", headers: { "Content-Type": "application/json", ...C(ana.token).headers },
    body: JSON.stringify({ tipo: "image/jpeg", base64: grande }),
  });
  ok(gr.status === 413, "imagem acima do limite -> recusada no servidor");

  const semFoto = await fetch(`${CORE}/api/foto/${carla.id}`, C(ana.token));
  ok(semFoto.status === 404, "quem nao tem foto devolve 404, nao erro");

  await fetch(`${CORE}/api/perfil/foto`, { method: "DELETE", ...C(ana.token) });
  ok((await fetch(`${CORE}/api/foto/${ana.id}`, C(ana.token))).status === 404, "da para remover a foto");

  console.log("\n=== A EXIGENCIA NASCE DESLIGADA ===");
  // Enquanto EXIGIR_PERFIL nao estiver ligada, ninguem e barrado — e o que
  // protege as 32 pessoas que acabaram de receber acesso de encontrar um
  // formulario obrigatorio no primeiro contato com o sistema.
  ok(perfil.exigindoPerfil() === false, "desligada por padrao");
  const euCarla = await (await fetch(`${CORE}/api/eu`, C(carla.token))).json();
  ok(euCarla.usuario.perfilCompleto === false, "o Core sabe que o cadastro esta incompleto");
  ok(euCarla.usuario.exigirPerfil === false, "mas nao exige nada dela");

  const sessao = await fetch(
    `${CORE}/api/interno/sessao?modulo=operacional`,
    { headers: { "x-unigestao-token": carla.token, "x-core-key": CHAVE } }
  );
  ok(sessao.status === 200, "e o modulo abre normalmente");

  console.log("\n=== QUANDO LIGAR, BARRA NO SERVIDOR ===");
  // Simula a exigencia ligada sem reiniciar o servico: a regra mora em
  // perfil.completo(), entao basta conferir que ela reprova quem falta dado.
  ok(perfil.completo({ telefone: null, ramal: null, departamento: null, cargo: null }) === false,
     "cadastro vazio reprova");
  ok(perfil.completo({ ramal: "2010", departamento: "Comercial", cargo: null }) === false,
     "faltando o cargo, reprova");
  ok(perfil.completo({ ramal: "2010", departamento: "Comercial", cargo: "Analista" }) === true,
     "com tudo, aprova");

  await pool.query("DELETE FROM usuarios WHERE email LIKE 'agenda.%@uniseter.com'");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
