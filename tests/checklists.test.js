// O painel de checklists da operação.
//
// POR QUE ESTE TESTE EXISTE
// Este painel lê de um sistema de terceiro que não controlamos, e por isso ele
// tem duas obrigações que valem mais do que qualquer número na tela:
//
//   1. NÃO INVENTAR. A API do Nexti só entrega a visita CONCLUÍDA — conferido
//      contra o relatório deles, 422 de um lado e 422 do outro. O painel não
//      pode dar a entender que sabe o que faltou.
//
//   2. NÃO MENTIR SOBRE A IDADE DO DADO. Dado velho com aviso é útil; dado
//      velho calado faz a pessoa decidir achando que vê o agora. Se a busca no
//      Nexti falhou, a tela precisa saber disso.
//
// O teste sobe um Nexti de mentira que devolve os formatos documentados e
// verifica o caminho inteiro: buscar, guardar, não duplicar, agregar e avisar.
const CORE = "http://localhost:3000";
const CONEXAO = "postgres://postgres:teste@localhost:55987/unigestao";

// ANTES de qualquer require que puxe core/db.js: ele le DATABASE_URL uma vez
// so, no carregamento. Definir depois nao adianta — a conexao ja foi montada
// apontando para o padrao (5432), e o teste morre com ECONNREFUSED.
process.env.DATABASE_URL = CONEXAO;

const crypto = require("crypto");
const http = require("http");
const { Pool } = require("pg");
const auth = require("../core/auth.js");

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

const p2 = (n) => String(n).padStart(2, "0");
const iso = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const carimbo = (d, h, m) => `${iso(d)} ${p2(h)}:${p2(m)}:00`;

// Um Nexti de mentira que responde no formato documentado.
function subirNexti(porDia) {
  const pedidos = [];
  const s = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    pedidos.push(url.pathname + url.search);
    res.writeHead(200, { "Content-Type": "application/json" });
    if (url.pathname === "/security/oauth/token") {
      return res.end(JSON.stringify({ access_token: "tok", expires_in: 3600 }));
    }
    const ref = url.searchParams.get("referenceDate") || "";
    res.end(JSON.stringify({
      content: porDia[ref] || [], totalPages: 1, number: 0, last: true,
    }));
  });
  return new Promise((r) => s.listen(0, () => r({
    pedidos, porta: s.address().port, parar: () => new Promise((f) => s.close(f)),
  })));
}

(async () => {
  const pool = new Pool({ connectionString: CONEXAO });
  await pool.query("DELETE FROM nexti_visita");
  await pool.query("DELETE FROM nexti_sync");

  // ---- o módulo, apontado para o Nexti de mentira ----
  const hoje = new Date();
  const refHoje = `${p2(hoje.getDate())}${p2(hoje.getMonth() + 1)}${hoje.getFullYear()}`;
  const tarefa = (id, posto, quem, ini, fim) => ({
    id, workplaceId: 900 + (id % 5),
    workplace: { name: posto },
    userAccountId: 10 + (quem.length % 3),
    userAccount: { name: quem },
    checklist: { name: "VISITA DE ROTINA" },
    taskStages: [
      { stageName: "TASK_STARTED", stageDate: carimbo(hoje, ini, 0) },
      { stageName: "TASK_FINISHED", stageDate: carimbo(hoje, fim, 0) },
    ],
  });
  const doDia = {};
  doDia[refHoje] = [
    tarefa(1, "CONDOMINIO YARD - CONDOMINIO (Privado) - VIGILANTE", "SUELEN", 8, 9),
    tarefa(2, "CONDOMINIO YARD - CONDOMINIO (Privado) - PORTARIA", "SUELEN", 10, 10),
    tarefa(3, "EDIFICIO TOULON OFFICE CENTER (Privado) - ASG", "GUSTAVO", 14, 15),
  ];

  const falso = await subirNexti(doDia);
  process.env.NEXTI_URL = "http://localhost:" + falso.porta;
  process.env.NEXTI_CLIENT_ID = "id";
  process.env.NEXTI_CLIENT_SECRET = "seg";
  process.env.NEXTI_PAUSA_MS = "0";
  delete require.cache[require.resolve("../core/nexti.js")];
  delete require.cache[require.resolve("../core/checklists.js")];
  const checklists = require("../core/checklists.js");

  console.log("\n=== BUSCAR E GUARDAR ===");
  const r1 = await checklists.sincronizar(hoje, hoje);
  ok(r1.ok && r1.visitas === 3, `trouxe as 3 visitas do dia (veio ${r1.visitas})`);
  const n1 = await pool.query("SELECT count(*)::int AS n FROM nexti_visita");
  ok(n1.rows[0].n === 3, "gravou 3 linhas");

  const linha = await pool.query("SELECT * FROM nexti_visita WHERE id = 1");
  const v = linha.rows[0];
  ok(v.supervisor_nome === "SUELEN", "guardou o nome do supervisor, não só o id");
  ok(v.cliente_nome === "CONDOMINIO YARD - CONDOMINIO",
     "e separou o cliente do cargo no nome do posto");
  ok(v.minutos === 60, "calculou o tempo em posto a partir das etapas (60 min)");

  console.log("\n=== BUSCAR DE NOVO NÃO DUPLICA ===");
  // A sincronização precisa poder rodar quantas vezes for, sem sujar o
  // histórico: é o que permite atualizar o dia de hoje a cada 15 minutos.
  await pool.query("UPDATE nexti_sync SET sincronizado_em = NOW() - interval '1 hour'");
  const r2 = await checklists.sincronizar(hoje, hoje);
  const n2 = await pool.query("SELECT count(*)::int AS n FROM nexti_visita");
  ok(r2.visitas === 3 && n2.rows[0].n === 3, "buscou de novo e continuam 3 linhas, não 6");

  console.log("\n=== NÃO BUSCA O QUE AINDA ESTÁ FRESCO ===");
  // Se cada abertura de tela buscasse tudo, 10 pessoas olhando seriam 10x
  // chamadas ao fornecedor pelo mesmo dado.
  const antes = falso.pedidos.length;
  const r3 = await checklists.sincronizar(hoje, hoje);
  ok(r3.dias === 0, "dia recém-buscado não é buscado de novo");
  ok(falso.pedidos.length === antes, "e nenhuma chamada nova saiu para o Nexti");

  console.log("\n=== OS NÚMEROS DA TELA ===");
  const p = await checklists.painel(hoje, hoje);
  ok(p.totais.visitas === 3, "3 visitas no total");
  ok(p.totais.supervisores === 2, "2 supervisores");
  ok(p.totais.clientes === 2, "2 clientes (o mesmo cliente com 2 postos conta 1)");
  const suelen = p.supervisores.find((s) => s.supervisor_nome === "SUELEN");
  ok(suelen && suelen.visitas === 2, "a Suelen aparece com 2 visitas");
  ok(suelen.postos === 2, "em 2 postos");
  const yard = p.clientes.find((c) => c.cliente_nome === "CONDOMINIO YARD - CONDOMINIO");
  ok(yard && yard.visitas === 2, "o cliente com 2 postos soma 2 visitas");

  console.log("\n=== O COSTUME PRECISA DE HISTÓRICO ===");
  // Sem semanas suficientes, o painel se cala em vez de chutar uma meta.
  const semHistorico = await checklists.costumeDeHoje();
  ok(semHistorico.length === 0,
     "com uma semana só de dados, ninguém entra na comparação do dia");

  // Agora com histórico: mesma pessoa, mesmo dia da semana, 4 semanas atrás.
  for (let semana = 1; semana <= 4; semana++) {
    const d = new Date(hoje);
    d.setDate(d.getDate() - semana * 7);
    for (let i = 0; i < 4; i++) {
      await pool.query(
        `INSERT INTO nexti_visita (id, dia, posto_id, supervisor_id, supervisor_nome)
         VALUES ($1,$2,$3,$4,$5)`,
        [1000 + semana * 10 + i, iso(d), 900 + i, 16, "SUELEN"]
      );
    }
  }
  const comHistorico = await checklists.costumeDeHoje();
  const cSuelen = comHistorico.find((x) => x.supervisorNome === "SUELEN");
  ok(Boolean(cSuelen), "com 4 semanas, a Suelen entra na comparação");
  ok(cSuelen.costume === 4, "o costume dela neste dia da semana é 4");
  ok(cSuelen.semanas === 4, "apurado sobre 4 semanas");
  ok(comHistorico[0].hoje - comHistorico[0].costume <= 0,
     "quem está mais atrás do próprio costume aparece primeiro");

  console.log("\n=== A TELA SABE QUANDO O DADO FALHOU ===");
  await falso.parar();
  const ontem = new Date(hoje); ontem.setDate(ontem.getDate() - 1);
  const r4 = await checklists.sincronizar(ontem, ontem);
  ok(r4.falhas === 1, "com o Nexti fora do ar, a busca do dia falha");
  const estado = await checklists.frescor(ontem, ontem);
  ok(estado.diasComErro === 1, "e o painel registra o dia com erro");
  ok(Boolean(estado.exemploDeErro), "guardando o motivo, para a tela poder dizer qual foi");

  console.log("\n=== QUEM PODE VER ===");
  ok(checklists.podeVer({ super_admin: true }) === true, "administrador geral vê");
  ok(checklists.podeVer({ checklists_ver: true }) === true, "quem foi marcado vê");
  ok(checklists.podeVer({ super_admin: false, checklists_ver: false }) === false,
     "e quem não foi marcado NÃO vê — o painel não nasce liberado");
  ok(checklists.podeVer(null) === false, "sem usuário, não vê");

  console.log("\n=== A ROTA RECUSA QUEM NÃO PODE ===");
  const email = "chk.teste@uniseter.com";
  await pool.query("DELETE FROM usuarios WHERE email = $1", [email]);
  const id = "u" + crypto.randomBytes(9).toString("hex");
  await pool.query("INSERT INTO usuarios (id,nome,email,senha) VALUES ($1,$2,$3,$4)",
    [id, "Sem Acesso", email, auth.gerarHash("SenhaTeste@123")]);
  const entrou = await fetch(`${CORE}/api/login`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, senha: "SenhaTeste@123" }),
  });
  const cookie = (entrou.headers.get("set-cookie").match(/unigestao_sessao=([^;]+)/) || [])[1];
  const negado = await fetch(`${CORE}/api/checklists/painel`,
    { headers: { cookie: "unigestao_sessao=" + cookie } });
  ok(negado.status === 403, "sem a marcação, a API responde 403");
  const semLogin = await fetch(`${CORE}/api/checklists/painel`);
  ok(semLogin.status === 401, "e sem login, 401");

  // A PAGINA, e nao so a API.
  //
  // A primeira versao chamava paraOLogin() aqui — funcao que existe na Fachada
  // e NAO no Core. Sintaxe valida, deploy limpo, e 500 na cara de quem abrisse
  // o endereco. So a producao mostrou. Agora e o teste que mostra.
  const paginaSemLogin = await fetch(`${CORE}/checklists`, { redirect: "manual" });
  ok(paginaSemLogin.status < 400,
     `a pagina sem login redireciona em vez de estourar (veio ${paginaSemLogin.status})`);
  const paginaSemPermissao = await fetch(`${CORE}/checklists`, {
    headers: { cookie: "unigestao_sessao=" + cookie }, redirect: "manual",
  });
  ok(paginaSemPermissao.status < 400,
     `e sem a marcacao, tambem redireciona (veio ${paginaSemPermissao.status})`);

  await pool.query("DELETE FROM usuarios WHERE email = $1", [email]);
  await pool.query("DELETE FROM nexti_visita");
  await pool.query("DELETE FROM nexti_sync");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exit(falhas === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
