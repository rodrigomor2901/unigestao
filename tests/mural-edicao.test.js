// Editar uma publicacao do mural — TUDO, e nao so titulo e texto.
//
// POR QUE ESTE TESTE EXISTE
// A edicao mexia em titulo, texto, tipo e fixado, mas o pop-up e a imagem
// ficavam presos no que foram no dia da publicacao. Quem quisesse tirar um
// pop-up tinha que arquivar e republicar — perdendo curtidas, comentarios e o
// historico de edicao. Aconteceu com o comunicado do chat (08/09).
//
// Exige o Core no ar e o PostgreSQL de desenvolvimento.
const { Pool } = require("pg");
const crypto = require("crypto");
const auth = require("../core/auth.js");

const CORE = "http://localhost:3000";

(async () => {
  const pool = new Pool({ connectionString: "postgres://postgres:teste@localhost:55987/unigestao" });
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'edicao.%@uniseter.com'");
  // Some com qualquer pop-up antigo: /api/mural/popup devolve UM so, o mais
  // antigo — e um aviso esquecido de outro teste esconderia o deste.
  await pool.query("DELETE FROM avisos WHERE titulo LIKE 'EDICAO TESTE%' OR titulo LIKE 'POPUP TESTE%'");

  async function criar(email, autorMural) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await pool.query(
      "INSERT INTO usuarios (id,nome,email,senha,mural_autor) VALUES ($1,$2,$3,$4,$5)",
      [id, "Edicao " + email.split(".")[1].split("@")[0], email,
       auth.gerarHash("SenhaTeste@123"), autorMural]
    );
    const t = crypto.randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO sessoes (token,usuario_id,expira_em) VALUES ($1,$2,NOW()+INTERVAL '1 hour')",
      [t, id]
    );
    return { id, token: t };
  }

  const autor = await criar("edicao.autor@uniseter.com", true);
  const gente = await criar("edicao.gente@uniseter.com", false);

  const J = (t) => ({ headers: { cookie: "unigestao_sessao=" + t, "Content-Type": "application/json" } });
  const chamar = (url, metodo, token, corpo) =>
    fetch(CORE + url, { method: metodo, ...J(token), body: JSON.stringify(corpo || {}) });

  let falhas = 0;
  const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

  // ---- publica com pop-up ---------------------------------------------------
  const pub = await (await chamar("/api/mural", "POST", autor.token, {
    titulo: "EDICAO TESTE — comunicado", texto: "primeira versao",
    tipo: "aviso", popup: true, popupDias: 7,
  })).json();
  ok(pub.ok === true, "publica com pop-up ligado");

  const vePopup = async (token) => {
    const d = await (await fetch(CORE + "/api/mural/popup",
      { headers: { cookie: "unigestao_sessao=" + token } })).json();
    return Boolean(d.publicacao && String(d.publicacao.id) === String(pub.id));
  };
  ok(await vePopup(gente.token), "e o pop-up chega para as pessoas");

  // ---- edita mudando TUDO ---------------------------------------------------
  const salvou = await chamar("/api/mural/" + pub.id, "PATCH", autor.token, {
    titulo: "EDICAO TESTE — corrigido", texto: "segunda versao",
    tipo: "mudanca", fixado: true, popup: false,
  });
  ok(salvou.status === 200, "a edicao aceita tipo, fixado e pop-up");

  const linha = await pool.query(
    "SELECT titulo, texto, tipo, fixado, popup_ate FROM avisos WHERE id=$1", [pub.id]
  );
  const a = linha.rows[0];
  ok(a.titulo === "EDICAO TESTE — corrigido" && a.texto === "segunda versao",
     "titulo e texto mudaram");
  ok(a.tipo === "mudanca" && a.fixado === true, "tipo e 'fixar no topo' tambem");
  ok(a.popup_ate === null,
     "e o pop-up foi DESLIGADO  <-- era o que so dava para desfazer republicando");

  ok((await vePopup(gente.token)) === false, "as pessoas param de receber o pop-up");

  // ---- religar e mostrar de novo -------------------------------------------
  await chamar("/api/mural/" + pub.id + "/lido", "POST", gente.token, { popup: true });
  await chamar("/api/mural/" + pub.id, "PATCH", autor.token, {
    titulo: "EDICAO TESTE — corrigido", texto: "segunda versao",
    tipo: "mudanca", fixado: true, popup: true, popupDias: 3,
  });
  ok((await vePopup(gente.token)) === false,
     "religar o pop-up nao reabre para quem ja tinha fechado");

  await chamar("/api/mural/" + pub.id, "PATCH", autor.token, {
    titulo: "EDICAO TESTE — corrigido", texto: "segunda versao",
    tipo: "mudanca", fixado: true, popup: true, popupDias: 3, mostrarDeNovo: true,
  });
  ok(await vePopup(gente.token),
     "mas 'mostrar de novo' reabre  <-- para quando a publicacao saiu errada");

  // ---- quem nao publica, nao edita -----------------------------------------
  const doOutro = await chamar("/api/mural/" + pub.id, "PATCH", gente.token, {
    titulo: "invadido", texto: "x", tipo: "aviso",
  });
  ok(doOutro.status === 403, "quem nao e autor nem admin continua sem editar");

  const edicoes = await pool.query("SELECT count(*)::int n FROM aviso_edicao WHERE aviso_id=$1",
                                   [pub.id]);
  ok(edicoes.rows[0].n >= 3, "cada edicao deixou rastro do que estava escrito antes");

  // Limpa o que criou. Aqui isso NAO e cortesia: /api/mural/popup devolve o
  // pop-up mais antigo que a pessoa ainda nao fechou, entao um comunicado
  // esquecido por este teste faz o teste do mural falhar na rodada seguinte —
  // e a falha aparece longe daqui, num arquivo que ninguem tocou.
  await pool.query("DELETE FROM avisos WHERE titulo LIKE 'EDICAO TESTE%'");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'edicao.%@uniseter.com'");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  // `process.exitCode`, e nao `process.exit()`: sair a forca logo depois de
  // fechar o pool derruba o Node no Windows (UV_HANDLE_CLOSING) e o processo
  // termina com codigo de erro mesmo com todos os testes passando — o que faz
  // a suite inteira parecer quebrada por um motivo que nao existe.
  process.exitCode = falhas === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
