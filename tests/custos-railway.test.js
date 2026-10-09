// Testa as contas do painel de custos (core/custos-railway.js).
//
// Nao precisa do servidor nem do banco: so as funcoes puras. Os numeros de
// entrada sao os que a API do Railway devolveu para o ciclo de 08/09 a
// 08/10/2026, e o esperado e a fatura 8M4PF9EW-0007 daquele ciclo. Se alguem
// mexer nos precos ou na conversao de unidade, este teste deixa de bater com a
// fatura de verdade.
//
// O que precisa valer:
//   - a API devolve MINUTO (GB-minuto, vCPU-minuto) e a conta chega na fatura
//   - fatura nunca fica abaixo do incluido no plano
//   - relatorio soma por projeto e por servico, e calcula RAM media
//   - cada alerta sai uma vez por ciclo; "gasto" engole "projecao"
process.env.DATABASE_URL = process.env.DATABASE_URL || "postgres://ninguem@localhost:1/nada";
const c = require("../core/custos-railway.js");

let falhas = 0;
function ok(cond, msg) { console.log((cond ? "  OK   " : "  FALHA") + "  " + msg); if (!cond) falhas++; }
const perto = (a, b, tol = 0.02) => Math.abs(a - b) <= tol;

// --- 1. Contra a fatura real -------------------------------------------------
const totaisSetembro = [
  { measurement: "CPU_USAGE", value: 7862.556869033333 },
  { measurement: "NETWORK_TX_GB", value: 15.633084334 },
  { measurement: "MEMORY_USAGE_GB", value: 83839.44244394667 },
  { measurement: "DISK_USAGE_GB", value: 85746.37903872 },
  { measurement: "BACKUP_USAGE_GB", value: 26140.14554112 },
];
const custo = (m) => c.custoDe(m, totaisSetembro.find((x) => x.measurement === m).value);
ok(perto(custo("CPU_USAGE"), 3.64), "CPU de setembro = US$ 3,64 da fatura");
ok(perto(custo("MEMORY_USAGE_GB"), 19.36, 0.03), "RAM de setembro = US$ 19,36 da fatura");
ok(perto(custo("NETWORK_TX_GB"), 0.78), "rede de setembro = US$ 0,78 da fatura");
ok(perto(custo("DISK_USAGE_GB") + custo("BACKUP_USAGE_GB"), 0.39), "disco + backup = US$ 0,39 da fatura");
const totalSet = totaisSetembro.reduce((t, l) => t + c.custoDe(l.measurement, l.value), 0);
ok(perto(c.faturaDe(totalSet), 24.17, 0.05), "uso de setembro = US$ 24,17, que e a fatura (o plano de 5 volta como uso incluido)");

ok(c.faturaDe(0.8) === 5, "uso abaixo do incluido paga o plano inteiro");
ok(c.faturaDe(12.3) === 12.3, "uso acima do incluido paga o uso");
ok(c.custoDe("MEDIDA_INVENTADA", 999) === 0, "medida desconhecida nao vira custo");

// --- 2. Montagem do relatorio ------------------------------------------------
const inicio = "2026-10-08T01:37:30.000Z";
const agora = new Date(inicio).getTime() + 24 * 60 * 60 * 1000; // um dia depois
const rel = c.montarRelatorio({
  ciclo: { start: inicio, end: "2026-11-08T01:37:30.000Z" },
  agora,
  projetos: [
    { id: "p1", name: "unigestao", services: [{ id: "s1", name: "fachada" }, { id: "s2", name: "core" }] },
    { id: "p2", name: "SGC - RLM", services: [{ id: "s3", name: "sgc-rlm" }] },
  ],
  uso: [
    // fachada com 600 MB o dia inteiro: 0,5859 GB x 1440 min
    { measurement: "MEMORY_USAGE_GB", value: (600 / 1024) * 1440, tags: { projectId: "p1", serviceId: "s1" } },
    { measurement: "CPU_USAGE", value: 100, tags: { projectId: "p1", serviceId: "s1" } },
    { measurement: "MEMORY_USAGE_GB", value: (120 / 1024) * 1440, tags: { projectId: "p1", serviceId: "s2" } },
    { measurement: "MEMORY_USAGE_GB", value: (70 / 1024) * 1440, tags: { projectId: "p2", serviceId: "s3" } },
    { measurement: "NETWORK_TX_GB", value: 2, tags: { projectId: "p9", serviceId: "s9" } }, // projeto apagado
  ],
  estimado: [
    { measurement: "MEMORY_USAGE_GB", estimatedValue: 30000, projectId: "p1" },
    { measurement: "MEMORY_USAGE_GB", estimatedValue: 3000, projectId: "p2" },
  ],
  anterior: totaisSetembro,
});

const ug = rel.projetos.find((p) => p.nome === "unigestao");
ok(rel.projetos[0].nome === "unigestao", "projeto com maior projecao vem primeiro");
ok(ug.servicos[0].nome === "fachada", "dentro do projeto, o servico mais caro vem primeiro");
ok(Math.abs(ug.servicos[0].ramMediaMb - 600) <= 1, "RAM media da fachada = 600 MB (" + ug.servicos[0].ramMediaMb + ")");
ok(Math.abs(ug.servicos[1].ramMediaMb - 120) <= 1, "RAM media do core = 120 MB");
ok(perto(ug.estimado, 30000 * 0.000231), "projecao do projeto vem do estimatedUsage");
ok(rel.projetos.some((p) => p.nome === "Projeto removido"), "uso de projeto apagado aparece como 'Projeto removido', nao some");
ok(perto(rel.anterior.fatura, 24.17, 0.05), "ciclo anterior bate com a fatura de setembro");
ok(perto(rel.atual.uso, rel.projetos.reduce((t, p) => t + p.atual, 0), 0.02), "total atual = soma dos projetos");
ok(rel.atual.fatura === 5, "gasto de um dia ainda paga so o plano");
ok(perto(rel.porMedida.rede, 0.1), "rede somada por medida");

// --- 3. Alertas ---------------------------------------------------------------
const base = { atual: { uso: 3, fatura: 5 }, estimado: { uso: 12, fatura: 12 }, incluido: 5 };
const cfg = { ativo: true, limite_usd: 10, avisar_plano: false };
ok(JSON.stringify(c.alertasDevidos(base, cfg, [])) === '["projecao"]', "projecao acima do limite -> aviso de projecao");
ok(c.alertasDevidos(base, cfg, ["projecao"]).length === 0, "aviso de projecao nao repete no mesmo ciclo");
const estourou = { atual: { uso: 11, fatura: 11 }, estimado: { uso: 20, fatura: 20 }, incluido: 5 };
ok(JSON.stringify(c.alertasDevidos(estourou, cfg, [])) === '["gasto"]', "gasto acima do limite manda 'gasto', nao os dois juntos");
ok(JSON.stringify(c.alertasDevidos(estourou, cfg, ["projecao"])) === '["gasto"]', "depois da projecao, o gasto real ainda avisa");
ok(c.alertasDevidos(estourou, { ...cfg, ativo: false }, []).length === 0, "alertas desligados nao mandam nada");
ok(c.alertasDevidos(base, { ...cfg, limite_usd: 50 }, []).length === 0, "dentro do limite nao avisa");
ok(JSON.stringify(c.alertasDevidos({ ...base, estimado: { uso: 4, fatura: 5 }, atual: { uso: 6, fatura: 6 } },
  { ...cfg, avisar_plano: true }, [])) === '["plano"]', "passou do incluido no plano avisa so se marcado");

// --- 4. E-mail ------------------------------------------------------------------
const email = c.htmlAlerta("projecao", { ...rel, projetos: [{ nome: "<script>x</script>", estimado: 1 }] }, { limite_usd: 10 });
ok(!email.html.includes("<script>x"), "nome de projeto vai escapado no e-mail");
ok(/^A fatura do Railway deve passar do limite — US\$ /.test(email.assunto), "assunto diz o que aconteceu e o valor");

console.log(falhas ? `\n${falhas} FALHA(S)` : "\nTudo certo");
process.exit(falhas ? 1 : 0);
