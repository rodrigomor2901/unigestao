// O comunicador interno: conversa direta entre logins do UniGestao.
//
// O que este teste protege, em ordem de importancia:
//   1. ninguem le a conversa dos outros — nem trocando o numero no endereco,
//      nem pedindo o print, e nem sendo administrador geral
//   2. uma conversa por dupla, nao importa quem clicou primeiro
//   3. apagar ESCONDE, nao some: e o que sustenta a promessa do resgate
//   4. o resgate exige motivo escrito e fica registrado na auditoria
//   5. as nao lidas contam so o que o OUTRO mandou, e zeram ao abrir
//   6. link de fora nao entra como "conversar sobre isto"
const crypto = require("crypto");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

const CORE = "http://localhost:3000";
const CONEXAO = "postgres://postgres:teste@localhost:55987/unigestao";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// Um PNG de 1x1 pixel, para o teste de print.
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'chat.%@uniseter.com'");
  await pool.query("DELETE FROM auditoria WHERE acao = 'chat_resgatado'");

  async function criar(email, { superAdmin = false } = {}) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await pool.query(
      `INSERT INTO usuarios (id,nome,email,senha,super_admin,departamento_principal)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [id, "Chat " + email.split("@")[0].split(".")[1], email,
       auth.gerarHash("SenhaTeste@123"), superAdmin, "COMERCIAL"]
    );
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO sessoes (token,usuario_id,expira_em) VALUES ($1,$2,NOW() + INTERVAL '1 hour')",
      [token, id]
    );
    return { id, token, nome: "Chat " + email.split("@")[0].split(".")[1] };
  }

  const C = (t) => ({ headers: { cookie: "unigestao_sessao=" + t } });
  const J = (t) => ({ headers: { cookie: "unigestao_sessao=" + t, "Content-Type": "application/json" } });
  const get = (url, t) => fetch(CORE + url, C(t));
  const post = (url, t, corpo) =>
    fetch(CORE + url, { method: "POST", ...J(t), body: JSON.stringify(corpo || {}) });

  const ana = await criar("chat.ana@uniseter.com");
  const bruno = await criar("chat.bruno@uniseter.com");
  const curioso = await criar("chat.curioso@uniseter.com");
  const chefe = await criar("chat.chefe@uniseter.com", { superAdmin: true });

  // -------------------------------------------------------------------------
  console.log("\n=== QUEM ENXERGA O COMUNICADOR ===");
  // A regra de liberacao, testada direto: ela decide quem ve o recurso, e vale
  // poder conferi-la sem depender de subir o servidor com outra variavel.
  const regras = require("../core/chat.js");
  ok(regras.podeUsar({ email: "qualquer@uniseter.com" }, {}) === true,
     "sem a variavel CHAT_EMAILS, todo mundo ve o chat");
  const so3 = { CHAT_EMAILS: "rodrigo@uniseter.com, Ana@uniseter.com" };
  ok(regras.podeUsar({ email: "ana@uniseter.com" }, so3) === true,
     "com a lista, quem esta nela ve — e maiuscula no cadastro nao atrapalha");
  ok(regras.podeUsar({ email: "outro@uniseter.com" }, so3) === false,
     "e quem nao esta na lista nao ve  <-- e assim que se testa com 3 antes das 45");

  // -------------------------------------------------------------------------
  console.log("\n=== MANDAR E RECEBER ===");

  const enviada = await post(`/api/chat/com/${bruno.id}`, ana.token, { texto: "Bruno, chegou a escala?" });
  const dadosEnviada = await enviada.json();
  ok(enviada.status === 200 && dadosEnviada.ok === true, "a Ana manda mensagem para o Bruno");

  const vazia = await post(`/api/chat/com/${bruno.id}`, ana.token, { texto: "   " });
  ok(vazia.status === 400, "mensagem vazia nao passa");

  const conversaBruno = await (await get(`/api/chat/com/${ana.id}`, bruno.token)).json();
  ok(conversaBruno.mensagens.length === 1 &&
     conversaBruno.mensagens[0].texto === "Bruno, chegou a escala?",
     "o Bruno abre a conversa e ve o que a Ana escreveu");
  ok(conversaBruno.mensagens[0].minha === false,
     "e o sistema diz que a mensagem nao e dele — e assim que a tela sabe de que lado desenhar");

  // -------------------------------------------------------------------------
  console.log("\n=== UMA CONVERSA POR DUPLA ===");

  const daAna = await (await get(`/api/chat/com/${bruno.id}`, ana.token)).json();
  ok(daAna.conversaId === conversaBruno.conversaId,
     "A abrindo com B e B abrindo com A caem na MESMA conversa");

  const paraSiMesmo = await post(`/api/chat/com/${ana.id}`, ana.token, { texto: "oi eu" });
  ok(paraSiMesmo.status === 400, "conversa consigo mesma nao existe");

  const paraFantasma = await post("/api/chat/com/u-nao-existe", ana.token, { texto: "oi" });
  ok(paraFantasma.status === 404, "mandar para quem nao existe -> 404");

  // -------------------------------------------------------------------------
  console.log("\n=== NINGUEM LE A CONVERSA DOS OUTROS ===");

  const bisbilhota = await get(`/api/chat/com/${ana.id}`, curioso.token);
  const doCurioso = await bisbilhota.json();
  ok(doCurioso.conversaId !== conversaBruno.conversaId && doCurioso.mensagens.length === 0,
     "quem abre com a Ana ve a PROPRIA conversa com ela, nunca a que ela tem com o Bruno");

  const marcarAlheia = await post(`/api/chat/conversa/${conversaBruno.conversaId}/lido`, curioso.token, {});
  ok(marcarAlheia.status === 404,
     "trocar o numero da conversa no endereco nao da acesso  <-- o furo classico");

  const pessoasDoCurioso = await (await get("/api/chat/pessoas", curioso.token)).json();
  const anaNaLista = pessoasDoCurioso.pessoas.filter((p) => p.id === ana.id)[0];
  ok(anaNaLista && !anaNaLista.ultima,
     "a lista mostra a Ana, mas sem previa: a ultima mensagem dela com o Bruno nao vaza aqui");

  const semLogin = await fetch(`${CORE}/api/chat/pessoas`);
  ok(semLogin.status === 401, "sem sessao nao ha chat");

  // -------------------------------------------------------------------------
  console.log("\n=== NAO LIDAS ===");

  await post(`/api/chat/com/${bruno.id}`, ana.token, { texto: "e ai?" });
  const listaBruno = async () => {
    const d = await (await get("/api/chat/pessoas", bruno.token)).json();
    return d.pessoas.filter((p) => p.id === ana.id)[0];
  };
  let anaParaBruno = await listaBruno();
  ok(anaParaBruno.naoLidas === 1,
     "o Bruno tem 1 nao lida — a primeira ele ja tinha lido ao abrir a conversa");

  const minhas = await (await get("/api/chat/pessoas", ana.token)).json();
  const brunoParaAna = minhas.pessoas.filter((p) => p.id === bruno.id)[0];
  ok(brunoParaAna.naoLidas === 0, "o que eu mesma mandei nunca conta como nao lida");
  ok(brunoParaAna.ultima && brunoParaAna.ultima.minha === true,
     "a previa da lista diz que a ultima fala foi minha");

  await get(`/api/chat/com/${ana.id}`, bruno.token);
  anaParaBruno = await listaBruno();
  ok(anaParaBruno.naoLidas === 0, "abrir a conversa zera o contador");

  // -------------------------------------------------------------------------
  console.log("\n=== PRINT DE TELA ===");

  const comPrint = await (await post(`/api/chat/com/${bruno.id}`, ana.token, {
    texto: "olha o erro", imagem: PNG_1x1, imagemTipo: "image/png",
  })).json();
  ok(comPrint.mensagem.temImagem === true, "a Ana anexa um print");

  const printDoBruno = await get(`/api/chat/mensagem/${comPrint.mensagem.id}/imagem`, bruno.token);
  ok(printDoBruno.status === 200, "o Bruno, que participa da conversa, ve o print");

  const printDoCurioso = await get(`/api/chat/mensagem/${comPrint.mensagem.id}/imagem`, curioso.token);
  ok(printDoCurioso.status === 404,
     "quem nao participa nao ve o print, mesmo sabendo o numero da mensagem");

  const printDoChefe = await get(`/api/chat/mensagem/${comPrint.mensagem.id}/imagem`, chefe.token);
  ok(printDoChefe.status === 404,
     "e o administrador geral tambem nao ve pelo caminho comum  <-- so pelo resgate");

  const formatoRuim = await post(`/api/chat/com/${bruno.id}`, ana.token, {
    texto: "x", imagem: PNG_1x1, imagemTipo: "application/pdf",
  });
  ok(formatoRuim.status === 400, "so imagem entra como print");

  // -------------------------------------------------------------------------
  console.log("\n=== CONVERSAR SOBRE ISTO ===");

  const comAssunto = await (await post(`/api/chat/com/${bruno.id}`, ana.token, {
    texto: "consegue ver?", sobre: "Tarefa 4021 — troca de escala", link: "/tarefas/?id=4021",
  })).json();
  ok(comAssunto.mensagem.sobre === "Tarefa 4021 — troca de escala" &&
     comAssunto.mensagem.link === "/tarefas/?id=4021",
     "a mensagem carrega o item de onde a conversa nasceu");

  const linkDeFora = await (await post(`/api/chat/com/${bruno.id}`, ana.token, {
    texto: "clica aqui", sobre: "urgente", link: "//site-falso.com/entrar",
  })).json();
  ok(linkDeFora.mensagem.link === null,
     "endereco de fora e recusado: o UniGestao nao empresta credibilidade a link estranho");

  // -------------------------------------------------------------------------
  console.log("\n=== APAGAR ESCONDE, NAO SOME ===");

  const arrependida = await (await post(`/api/chat/com/${bruno.id}`, ana.token, {
    texto: "mandei errado, desculpa",
  })).json();

  const doOutro = await fetch(`${CORE}/api/chat/mensagem/${arrependida.mensagem.id}`,
                              { method: "DELETE", ...C(bruno.token) });
  ok(doOutro.status === 403, "o Bruno nao apaga mensagem que a Ana escreveu");

  const apagou = await fetch(`${CORE}/api/chat/mensagem/${arrependida.mensagem.id}`,
                             { method: "DELETE", ...C(ana.token) });
  ok(apagou.status === 200, "quem escreveu apaga");

  const depois = await (await get(`/api/chat/com/${ana.id}`, bruno.token)).json();
  const sumida = depois.mensagens.filter((m) => m.id === arrependida.mensagem.id)[0];
  ok(sumida && sumida.apagada === true && sumida.texto === "",
     "para o Bruno ela vira 'mensagem apagada', sem o texto");

  const noBanco = await pool.query("SELECT texto, apagada_em FROM mensagens WHERE id=$1",
                                   [arrependida.mensagem.id]);
  ok(noBanco.rows[0] && noBanco.rows[0].texto === "mandei errado, desculpa" &&
     noBanco.rows[0].apagada_em !== null,
     "mas no banco o texto CONTINUA  <-- sem isto, 'a diretoria pode resgatar' seria mentira");

  // -------------------------------------------------------------------------
  console.log("\n=== RESGATE: SO ADMIN, SO COM MOTIVO, SEMPRE REGISTRADO ===");

  const resgateDoCurioso = await post("/api/admin/chat/resgate", curioso.token,
    { aId: ana.id, bId: bruno.id, motivo: "queria dar uma olhada" });
  ok(resgateDoCurioso.status === 403, "quem nao e administrador geral nao resgata");

  const semMotivo = await post("/api/admin/chat/resgate", chefe.token,
    { aId: ana.id, bId: bruno.id, motivo: "x" });
  ok(semMotivo.status === 400, "nem o administrador resgata sem escrever o motivo");

  const resgate = await post("/api/admin/chat/resgate", chefe.token, {
    aId: ana.id, bId: bruno.id,
    motivo: "Pedido da diretoria em 03/09 — apuracao sobre o atendimento ao cliente X",
  });
  const conteudo = await resgate.json();
  ok(resgate.status === 200 && conteudo.mensagens.length >= 5, "o administrador resgata a conversa");

  const apagadaNoResgate = conteudo.mensagens.filter((m) => m.id === arrependida.mensagem.id)[0];
  ok(apagadaNoResgate && apagadaNoResgate.apagada === true &&
     apagadaNoResgate.texto === "mandei errado, desculpa",
     "o resgate mostra ate o que foi apagado, marcado como apagado");

  const registro = await pool.query(
    "SELECT usuario_id, alvo, detalhe FROM auditoria WHERE acao='chat_resgatado' ORDER BY id DESC LIMIT 1"
  );
  ok(registro.rows[0] && registro.rows[0].usuario_id === chefe.id,
     "ficou registrado QUEM resgatou");
  ok(registro.rows[0] && String(registro.rows[0].detalhe.motivo).indexOf("diretoria") >= 0,
     "e o motivo informado ficou junto  <-- e o que separa resgate de bisbilhotice");

  const semConversa = await (await post("/api/admin/chat/resgate", chefe.token, {
    aId: chefe.id, bId: curioso.id, motivo: "Pedido da diretoria — conferencia de rotina",
  })).json();
  ok(semConversa.mensagens.length === 0,
     "dupla que nunca conversou devolve vazio, e nao erro");

  // -------------------------------------------------------------------------
  console.log("\n=== O CANAL DO DEPARTAMENTO ===");
  // Todos os quatro foram criados em COMERCIAL (ver criar()). O canal e um so
  // por area, e quem esta nele e quem tem aquela area no cadastro — nao existe
  // lista de membros para sair do lugar.
  const canalDaAna = await (await get("/api/chat/pessoas", ana.token)).json();
  ok(canalDaAna.canais.length === 1 && canalDaAna.canais[0].nome === "COMERCIAL",
     "quem tem departamento ve o canal da area dele");
  ok(canalDaAna.canais[0].quantos === 4, "e o canal diz quanta gente ha na area");

  const noCanal = await (await post("/api/chat/canal", ana.token,
    { texto: "Pessoal, a proposta do cliente X saiu" })).json();
  ok(noCanal.ok === true, "a Ana escreve no canal");

  const lidoPeloBruno = await (await get("/api/chat/canal", bruno.token)).json();
  const doCanal = lidoPeloBruno.mensagens[lidoPeloBruno.mensagens.length - 1];
  ok(doCanal && doCanal.texto === "Pessoal, a proposta do cliente X saiu",
     "e o Bruno, da mesma area, le");
  ok(doCanal.autor === ana.nome,
     "com o nome de quem escreveu  <-- num canal, fala sem dono nao serve");
  ok(doCanal.minha === false, "e marcada como dos outros, para desenhar do lado certo");

  // Quem nao e da area nao ve o canal nem alcanca a conversa dele.
  await pool.query("UPDATE usuarios SET departamento_principal = 'CCO' WHERE id = $1",
                   [curioso.id]);
  const canalDoCurioso = await (await get("/api/chat/pessoas", curioso.token)).json();
  ok(canalDoCurioso.canais.length === 1 && canalDoCurioso.canais[0].nome === "CCO",
     "quem mudou de area passa a ver o canal da area NOVA");

  const espiando = await post(`/api/chat/conversa/${noCanal.conversaId}/lido`, curioso.token, {});
  ok(espiando.status === 404,
     "e nao alcanca o canal da area antiga, nem sabendo o numero da conversa");

  const semDepartamento = await criar("chat.solto@uniseter.com");
  await pool.query("UPDATE usuarios SET departamento_principal = NULL WHERE id = $1",
                   [semDepartamento.id]);
  const solto = await (await get("/api/chat/pessoas", semDepartamento.token)).json();
  ok(solto.canais.length === 0, "quem esta sem departamento no cadastro nao ve canal nenhum");
  const tentou = await post("/api/chat/canal", semDepartamento.token, { texto: "oi" });
  ok(tentou.status === 404, "e nem consegue escrever num  <-- em vez de escrever no vazio");

  // O canal tambem tem que ser resgatavel: senao a promessa da diretoria
  // valeria so para metade das conversas do sistema.
  const resgateDoCanal = await (await post("/api/admin/chat/resgate", chefe.token, {
    departamento: "COMERCIAL",
    motivo: "Pedido da diretoria — apuracao sobre a proposta do cliente X",
  })).json();
  ok(resgateDoCanal.mensagens.some((m) => m.texto.indexOf("proposta do cliente X") >= 0),
     "o administrador resgata o canal inteiro, com motivo registrado");

  console.log("\n=== SITUACAO: DISPONIVEL, OCUPADO, EM REUNIAO ===");
  const regrasSit = require("../core/chat.js");
  ok(regrasSit.statusValido("reuniao") === "reuniao", "'reuniao' e uma situacao valida");
  ok(regrasSit.statusValido("de ferias") === null, "situacao inventada nao entra");
  ok(regrasSit.comoAparece(false, "ocupado") === "offline",
     "quem marcou ocupado e fechou o navegador aparece OFFLINE  <-- estar fora vence a marcacao");
  ok(regrasSit.comoAparece(true, "ocupado") === "ocupado", "com o sistema aberto, vale o que ela marcou");
  ok(regrasSit.comoAparece(true, null) === "online", "sem marcar nada, e o automatico");
  ok(regrasSit.calaOAviso("reuniao") === true && regrasSit.calaOAviso(null) === false,
     "ocupado e em reuniao calam o aviso; disponivel nao");

  const marcou = await post("/api/chat/status", bruno.token, { status: "reuniao" });
  ok(marcou.status === 200, "o Bruno se marca em reuniao");
  await pool.query("UPDATE usuarios SET visto_em = NOW() WHERE id=$1", [bruno.id]);
  let comoVejo = await (await get("/api/chat/pessoas", ana.token)).json();
  let brunoVisto = comoVejo.pessoas.filter((p) => p.id === bruno.id)[0];
  ok(brunoVisto.situacao === "reuniao", "e a Ana ve 'em reuniao' na lista dela");

  const meuPainel = await (await get("/api/chat/pessoas", bruno.token)).json();
  ok(meuPainel.eu.situacao === "reuniao", "e o proprio Bruno ve a situacao dele na tela");

  await pool.query("UPDATE usuarios SET visto_em = NOW() - INTERVAL '10 minutes' WHERE id=$1", [bruno.id]);
  comoVejo = await (await get("/api/chat/pessoas", ana.token)).json();
  brunoVisto = comoVejo.pessoas.filter((p) => p.id === bruno.id)[0];
  ok(brunoVisto.situacao === "offline",
     "fechou o sistema: some o 'em reuniao'  <-- senao alguem espera resposta de quem nem esta la");

  // A marcacao vence sozinha: ninguem amanhece em reuniao por ter esquecido.
  await pool.query(
    "UPDATE usuarios SET visto_em = NOW(), chat_status_em = NOW() - INTERVAL '30 hours' WHERE id=$1",
    [bruno.id]
  );
  comoVejo = await (await get("/api/chat/pessoas", ana.token)).json();
  brunoVisto = comoVejo.pessoas.filter((p) => p.id === bruno.id)[0];
  ok(brunoVisto.situacao === "online",
     "marcacao de ontem nao vale hoje: volta para o automatico sozinha");

  await post("/api/chat/status", bruno.token, { status: null });
  comoVejo = await (await get("/api/chat/pessoas", ana.token)).json();
  brunoVisto = comoVejo.pessoas.filter((p) => p.id === bruno.id)[0];
  ok(brunoVisto.situacao === "online", "voltar para disponivel funciona");

  console.log("\n=== PRESENCA ===");

  await pool.query("UPDATE usuarios SET visto_em = NOW() WHERE id=$1", [bruno.id]);
  await pool.query("UPDATE usuarios SET visto_em = NOW() - INTERVAL '10 minutes' WHERE id=$1", [curioso.id]);
  const paraAna = await (await get("/api/chat/pessoas", ana.token)).json();
  const brunoOnline = paraAna.pessoas.filter((p) => p.id === bruno.id)[0];
  const curiosoOnline = paraAna.pessoas.filter((p) => p.id === curioso.id)[0];
  ok(brunoOnline.online === true, "quem deu sinal agora aparece online");
  ok(curiosoOnline.online === false, "quem sumiu ha 10 minutos aparece offline");

  await pool.end();
  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
