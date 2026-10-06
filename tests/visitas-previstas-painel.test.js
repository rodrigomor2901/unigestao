// Enviar a agenda de visitas e ver o previsto × realizado.
//
// (A "agenda de visitas" nao tem nada a ver com a Agenda de Contatos do portal,
// testada em tests/agenda.test.js: aqui e o roteiro dos supervisores.)
//
// POR QUE ESTE TESTE EXISTE
// O painel de checklists sempre mostrou o que FOI feito. O que estava previsto
// nao vem da API do Nexti — ela tem 386 enderecos e nenhum e o roteiro
// (apurado em 06/10/2026). Entao o previsto sobe por planilha, e e esse
// caminho inteiro que este teste cobre: subir o arquivo, virar roteiro,
// cruzar com o realizado e aparecer na tela.
//
// O que ele protege, em ordem de estrago:
//   1. quem nao pode ver o painel nao pode mandar agenda nem ler os numeros;
//   2. planilha errada volta com instrucao, e nao com "erro interno";
//   3. o cruzamento nao transforma visita feita em falta.
//
// Exige o Core no ar e o PostgreSQL de desenvolvimento.
"use strict";

const { Pool } = require("pg");
const crypto = require("crypto");
const auth = require("../core/auth.js");
const { relatorioDe, planilhaDe } = require("./planilha-de-mentira.js");

const CORE = "http://localhost:3000";

let falhas = 0;
const ok = (c, m) => { console.log((c ? "  OK   " : "  FALHA") + "  " + m); if (!c) falhas++; };

// Quintas de setembro/2026 — duas semanas seguidas fazem um roteiro.
const QUINTAS = ["03/09/2026", "10/09/2026", "17/09/2026", "24/09/2026"];

(async () => {
  const pool = new Pool({ connectionString: "postgres://postgres:teste@localhost:55987/unigestao" });
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'agenda.%@uniseter.com'");
  await pool.query("DELETE FROM nexti_visita WHERE posto_nome LIKE 'POSTO DE ENSAIO%'");
  await pool.query("DELETE FROM agenda_envio");

  async function pessoa(email, veChecklists) {
    const id = "u" + crypto.randomBytes(9).toString("hex");
    await pool.query(
      "INSERT INTO usuarios (id,nome,email,senha,checklists_ver) VALUES ($1,$2,$3,$4,$5)",
      [id, "Agenda " + email.split(".")[1].split("@")[0], email,
       auth.gerarHash("SenhaTeste@123"), veChecklists]
    );
    const token = crypto.randomBytes(32).toString("hex");
    await pool.query(
      "INSERT INTO sessoes (token,usuario_id,expira_em) VALUES ($1,$2,NOW()+INTERVAL '1 hour')",
      [token, id]
    );
    return { id, token };
  }

  const gestora = await pessoa("agenda.gestora@uniseter.com", true);
  const estranha = await pessoa("agenda.estranha@uniseter.com", false);

  const cab = (t) => ({ cookie: "unigestao_sessao=" + t });
  const enviar = (token, buf, nome) =>
    fetch(CORE + "/api/checklists/agenda", {
      method: "POST",
      headers: { ...cab(token), "Content-Type": "application/json" },
      body: JSON.stringify({ arquivo: buf.toString("base64"), nome: nome || "agenda.xls" }),
    });
  const previsto = (token, mes) =>
    fetch(CORE + "/api/checklists/previsto?mes=" + mes, { headers: cab(token) });

  // ---- o realizado, do jeito que a API do Nexti deixa no banco --------------
  // Visita no dia combinado, visita no dia seguinte, e um posto nunca visitado.
  let idVisita = 900000;
  const registrar = (dia, posto, supervisor) => pool.query(
    `INSERT INTO nexti_visita (id, dia, posto_nome, cliente_nome, supervisor_nome, checklist_nome)
     VALUES ($1,$2,$3,$4,$5,'VISITA DE ROTINA')`,
    [++idVisita, dia, posto, "CLIENTE DE ENSAIO", supervisor]
  );
  await registrar("2026-09-03", "POSTO DE ENSAIO ALFA - PORTARIA", "ZULEICA ENSAIO");
  // A segunda quinta foi cumprida na SEXTA: continua sendo a visita da semana.
  await registrar("2026-09-11", "POSTO DE ENSAIO ALFA - PORTARIA", "ZULEICA ENSAIO");
  await registrar("2026-09-17", "POSTO DE ENSAIO ALFA - PORTARIA", "ZULEICA ENSAIO");
  await registrar("2026-09-24", "POSTO DE ENSAIO ALFA - PORTARIA", "ZULEICA ENSAIO");

  console.log("\n=== SO QUEM VE O PAINEL MEXE NA AGENDA ===");
  {
    const planilha = relatorioDe(QUINTAS.map((d) => ({
      supervisor: "ZULEICA ENSAIO", posto: "POSTO DE ENSAIO ALFA - PORTARIA",
      cliente: "CLIENTE DE ENSAIO", agendada: d,
    })));
    const r = await enviar(estranha.token, planilha);
    ok(r.status === 403, "quem nao tem o painel nao envia agenda");
    const l = await previsto(estranha.token, "2026-09");
    ok(l.status === 403, "nem le os numeros");
  }

  console.log("\n=== PLANILHA ERRADA EXPLICA O QUE FAZER ===");
  {
    const r = await enviar(gestora.token, Buffer.from("isto aqui nao e planilha nenhuma"));
    const d = await r.json();
    ok(r.status === 400 && /planilha/i.test(d.erro || ""),
       "arquivo que nao e planilha: recusado com frase de gente");

    const outra = planilhaDe([["Nome", "Telefone"], ["Fulana", "9999"]]);
    const d2 = await (await enviar(gestora.token, outra)).json();
    ok(/Relação de visitas/.test(d2.erro || ""),
       "planilha de outra coisa: diz qual relatorio era para subir");

    const curta = relatorioDe([{ supervisor: "ZULEICA ENSAIO", posto: "POSTO DE ENSAIO ALFA - PORTARIA",
                                 agendada: "03/09/2026" }]);
    const d3 = await (await enviar(gestora.token, curta)).json();
    ok(/duas semanas/.test(d3.erro || ""),
       "periodo curto demais: explica que sem repeticao nao da para saber o roteiro");
  }

  console.log("\n=== A AGENDA VIRA O PREVISTO ===");
  {
    const planilha = relatorioDe([
      // o roteiro: toda quinta no Alfa e no Beta
      ...QUINTAS.map((d) => ({ supervisor: "ZULEICA ENSAIO", cliente: "CLIENTE DE ENSAIO",
                               posto: "POSTO DE ENSAIO ALFA - PORTARIA", agendada: d })),
      ...QUINTAS.map((d) => ({ supervisor: "ZULEICA ENSAIO", cliente: "CLIENTE DE ENSAIO",
                               posto: "POSTO DE ENSAIO BETA - LIMPEZA", agendada: d })),
      // uma visita marcada uma vez so: nao e roteiro
      { supervisor: "ZULEICA ENSAIO", posto: "POSTO DE ENSAIO GAMA - RONDA",
        cliente: "CLIENTE DE ENSAIO", agendada: "08/09/2026" },
    ]);
    const r = await enviar(gestora.token, planilha, "RelacaoDeVisitas.XLS");
    const d = await r.json();
    ok(r.status === 200 && d.ok, "a gestora envia a agenda");
    ok(d.pontos === 2, "dois pontos de roteiro: o avulso ficou de fora");

    const painel = await (await previsto(gestora.token, "2026-09")).json();
    ok(painel.temAgenda === true, "o painel passa a ter agenda");
    const z = (painel.supervisores || []).find((s) => /ZULEICA/.test(s.supervisor));
    ok(z && z.previstas === 8, "8 previstas: dois postos em quatro quintas");
    ok(z && z.feitas === 4, "4 feitas — as que a API registrou");
    ok(z && z.foraDoDia === 1, "uma delas caiu na sexta, e aparece como fora do dia, nao como falta");
    ok(z && z.faltaram === 4, "as quatro do posto nunca visitado aparecem como falta");
    ok(z && z.aderencia === 50, "aderencia de 50%");
    ok(z && z.postos.every((p) => /BETA/.test(p.posto)),
       "e a lista do que faltou aponta o posto certo");
  }

  console.log("\n=== SUBIR OUTRA AGENDA SUBSTITUI A ANTERIOR ===");
  {
    const nova = relatorioDe(QUINTAS.map((d) => ({
      supervisor: "ZULEICA ENSAIO", posto: "POSTO DE ENSAIO ALFA - PORTARIA",
      cliente: "CLIENTE DE ENSAIO", agendada: d,
    })));
    await enviar(gestora.token, nova, "nova.xls");
    const painel = await (await previsto(gestora.token, "2026-09")).json();
    const z = (painel.supervisores || []).find((s) => /ZULEICA/.test(s.supervisor));
    ok(z.previstas === 4, "a agenda nova manda: so o Alfa continua previsto");
    ok(painel.envio.arquivo === "nova.xls", "e a tela mostra qual arquivo esta valendo");
  }

  await pool.query("DELETE FROM nexti_visita WHERE posto_nome LIKE 'POSTO DE ENSAIO%'");
  await pool.query("DELETE FROM agenda_envio");
  await pool.query("DELETE FROM usuarios WHERE email LIKE 'agenda.%@uniseter.com'");
  await pool.end();

  console.log("\n" + (falhas === 0 ? "TODOS OS TESTES PASSARAM" : falhas + " TESTE(S) FALHARAM"));
  process.exitCode = falhas === 0 ? 0 : 1;
})().catch((e) => { console.error(e); process.exitCode = 1; });
