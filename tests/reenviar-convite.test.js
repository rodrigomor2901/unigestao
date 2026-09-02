// O convite pode ser reenviado quando a pessoa nao recebe o e-mail.
//
// POR QUE ESTE TESTE EXISTE
// O Core guarda so o HASH da senha — a senha original nao existe mais em lugar
// nenhum para ser reenviada. Entao "reenviar convite" tem obrigatoriamente que
// gerar uma senha nova, e o que importa provar e o que acontece em volta disso:
// a senha velha para de valer, a nova entra, a pessoa volta a ser obrigada a
// trocar no primeiro acesso, e ninguem alem de administrador geral consegue
// disparar isso — seria uma maneira silenciosa de tomar a conta de alguem.
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const CORE = "http://localhost:3000";
const CONEXAO = process.env.DATABASE_URL || "postgres://postgres:teste@localhost:55987/unigestao";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const EMAILS = ["convite.admin@uniseter.com", "convite.pessoa@uniseter.com", "convite.outro@uniseter.com"];

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM login_tentativas");
  await pool.query("DELETE FROM usuarios WHERE email = ANY($1)", [EMAILS]);

  async function criar(email, nome, extra = {}) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await pool.query(
      `INSERT INTO usuarios (id, nome, email, senha, senha_temp, super_admin, ativo)
       VALUES ($1,$2,$3,$4,FALSE,$5,$6)`,
      [id, nome, email, auth.gerarHash("SenhaCerta@123"), !!extra.superAdmin, extra.ativo !== false]
    );
    return id;
  }

  async function entrar(email, senha) {
    const r = await fetch(CORE + "/api/login", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, senha }),
    });
    const d = await r.json().catch(() => ({}));
    const m = (r.headers.get("set-cookie") || "").match(/unigestao_sessao=([^;]+)/);
    return { status: r.status, d, cookie: m ? m[1] : null };
  }

  const reenviar = (id, cookie) => fetch(
    CORE + "/api/admin/usuarios/" + id + "/reenviar-convite",
    { method: "POST", headers: { "Content-Type": "application/json",
                                 cookie: "unigestao_sessao=" + cookie },
      body: JSON.stringify({ avisar: false }) }
  );

  const idAdmin = await criar(EMAILS[0], "Admin Geral", { superAdmin: true });
  const idPessoa = await criar(EMAILS[1], "Pessoa Que Nao Recebeu");
  const idOutro = await criar(EMAILS[2], "Pessoa Comum");

  // A sessao do administrador e gravada direto na tabela, como em
  // papel-admin.test.js: administrador geral e obrigado a cadastrar 2FA no
  // login, e o assunto deste teste nao e o 2FA.
  async function sessaoDireta(id) {
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO sessoes (token, usuario_id, expira_em) VALUES ($1,$2,NOW() + INTERVAL '1 hour')",
      [token, id]
    );
    return token;
  }

  const admin = { cookie: await sessaoDireta(idAdmin) };
  const outro = await entrar(EMAILS[2], "SenhaCerta@123");

  console.log("\n=== SO ADMINISTRADOR GERAL REENVIA ===");
  // Reenviar troca a senha de outra pessoa. Nas maos erradas, e um jeito
  // silencioso de tomar a conta de alguem.
  const semLogin = await fetch(CORE + "/api/admin/usuarios/" + idPessoa + "/reenviar-convite",
                               { method: "POST" });
  ok(semLogin.status === 401, "sem sessao, 401");

  const comum = await reenviar(idPessoa, outro.cookie);
  ok(comum.status === 403, "pessoa comum logada leva 403  <-- trocaria a senha de outro");

  const aindaEntra = await entrar(EMAILS[1], "SenhaCerta@123");
  ok(aindaEntra.status === 200, "e a senha da vitima continua valendo — nada foi trocado");

  console.log("\n=== O REENVIO GERA SENHA NOVA E DERRUBA A ANTIGA ===");
  const r = await reenviar(idPessoa, admin.cookie);
  const corpo = await r.json();
  ok(r.status === 200, "administrador geral consegue reenviar");
  ok(typeof corpo.senha === "string" && corpo.senha.length >= 10,
     "a resposta traz a senha nova, para o administrador passar por outro caminho");
  ok(corpo.senha !== "SenhaCerta@123", "e ela nao e a antiga");

  const comAVelha = await entrar(EMAILS[1], "SenhaCerta@123");
  ok(comAVelha.status === 401, "a senha antiga para de valer");

  const comANova = await entrar(EMAILS[1], corpo.senha);
  ok(comANova.status === 200, "e a nova entra");
  ok(comANova.d.senhaTemp === true,
     "marcada como provisoria: a pessoa troca no primeiro acesso, como num convite novo");

  console.log("\n=== A SESSAO ABERTA COM A SENHA VELHA CAI ===");
  // Senha nova com sessao velha viva seria contradicao: o convite reenviado e
  // um recomeco.
  const antesDoReenvio = await entrar(EMAILS[2], "SenhaCerta@123");
  await reenviar(idOutro, admin.cookie);
  const usandoSessaoVelha = await fetch(CORE + "/api/eu",
    { headers: { cookie: "unigestao_sessao=" + antesDoReenvio.cookie } });
  ok(usandoSessaoVelha.status === 401, "a sessao aberta antes do reenvio nao vale mais");

  console.log("\n=== QUEM ESTA INATIVO NAO RECEBE CONVITE ===");
  // Reenviar para desativado prometeria um acesso que a Fachada vai barrar.
  await pool.query("UPDATE usuarios SET ativo = FALSE WHERE id = $1", [idPessoa]);
  const inativo = await reenviar(idPessoa, admin.cookie);
  ok(inativo.status === 400, "recusa com 400");
  ok((await inativo.json()).erro.toLowerCase().includes("inativo"),
     "e diz o motivo, em vez de falhar calado");

  console.log("\n=== FICA NA AUDITORIA ===");
  const trilha = await pool.query(
    "SELECT acao, alvo FROM auditoria WHERE acao = 'convite_reenviado' AND alvo = $1", [idOutro]);
  ok(trilha.rows.length >= 1, "o reenvio e registrado — troca de senha de terceiro nao pode ser invisivel");

  await pool.query("DELETE FROM usuarios WHERE email = ANY($1)", [EMAILS]);
  await pool.query("DELETE FROM login_tentativas");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
