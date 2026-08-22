"use strict";

// ============================================================================
// REGISTRO DE MODULOS
// ----------------------------------------------------------------------------
// Esta e a UNICA coisa que o Core sabe sobre os sistemas.
//
// Ele guarda o nome do modulo, onde ele mora e a LISTA de papeis que aquele
// sistema usa — mas nao sabe o que esses papeis significam. Quem interpreta
// continua sendo cada sistema, exatamente como e hoje.
//
// Para adicionar um papel novo a um modulo, basta acrescentar a palavra na
// lista `papeis`: ela passa a aparecer no Admin Geral. Nada mais muda.
//
// `base`       — caminho publico pelo qual a Fachada expoe o modulo
// `interno`    — endereco na rede privada do Railway (so a Fachada usa)
// `externo`    — sistema de TERCEIRO, que abre no proprio endereco (ver abaixo)
// `ativo`      — false = ainda nao plugado; some do menu e do Admin Geral
// `papelAdmin` — como ESTE modulo chama o papel de administrador. O Core usa
//                isso para o administrador geral, que enxerga todos os modulos
//                com poder total. Nao da para supor "admin": o CRM chama de
//                "administrador", e mandar o nome errado faz o modulo recusar
//                o proprio administrador geral.
// ============================================================================

// ----------------------------------------------------------------------------
// SISTEMA DE TERCEIRO (`externo`)
// ----------------------------------------------------------------------------
// Os seis sistemas do Grupo entram no portal de verdade: a Fachada os encaminha
// e eles trocaram a autenticacao propria pela identidade do Core (ver
// integracao/unigestao.js). Isso exige poder mexer no codigo deles.
//
// Um sistema de terceiro, hospedado na nuvem do fornecedor, nao permite nada
// disso. Um modulo `externo` e a resposta honesta: ele aparece na tela inicial
// junto com os outros e o Admin Geral decide quem enxerga o cartao, mas o
// clique leva para o endereco do fornecedor, onde a pessoa usa o login de la.
//
// NAO e login unico, e nao finge ser. O que ele resolve e o resto: ninguem
// precisa decorar o endereco, e quem nao usa aquele sistema nao ve o cartao.
// O dia em que o fornecedor oferecer SSO, ou o dia em que a API dele virar uma
// tela nossa, este registro muda e o cartao passa a apontar para dentro.
const MODULOS = {
  operacional: {
    nome: "Movimentação Operacional",
    descricao: "Lançamento de extras, desvios e coberturas",
    base: "/operacional",
    interno: process.env.URL_OPERACIONAL || "",
    icone: "truck",
    // Confere com ROLE_ACCESS em server.js do Lancamento de Extra (linha ~105).
    // `gestor` tem o mesmo alcance de `cco` e `admin`: enxerga todas as filas.
    papeis: ["admin", "gestor", "cco", "supervisor", "comercial"],
    rotulos: {
      admin: "Administrador", gestor: "Gestor", cco: "CCO",
      supervisor: "Supervisor", comercial: "Comercial",
    },
    papelAdmin: "admin",
    ativo: true,
  },
  documentos: {
    nome: "Controle de Documentos",
    descricao: "Validade de documentos de colaboradores por contrato",
    base: "/documentos",
    interno: process.env.URL_DOCUMENTOS || "",
    icone: "folder",
    // Confere com NIVEIS em index.html e com exigirNivel() em server.js.
    // `gestao` faltava na lista anterior — sem ele nao daria para atribuir o
    // acesso que as tres contas de setor usam hoje.
    papeis: ["admin", "gestao", "consulta"],
    rotulos: { admin: "Administrador", gestao: "Gestão", consulta: "Consulta" },
    papelAdmin: "admin",
    ativo: true,
  },
  eventos: {
    nome: "Gestão de Eventos",
    descricao: "Orçamentos, propostas, eventos e Orçado x Realizado",
    base: "/eventos",
    interno: process.env.URL_EVENTOS || "",
    icone: "calendar",
    papeis: ["admin", "gestao", "proposta"],
    rotulos: { admin: "Administrador", gestao: "Gestão", proposta: "Proposta" },
    papelAdmin: "admin",
    ativo: true,
  },
  tarefas: {
    nome: "Gestão de Tarefas",
    descricao: "Tarefas, demandas, chamados e agenda de salas",
    base: "/tarefas",
    interno: process.env.URL_TAREFAS || "",
    icone: "check",
    papeis: [
      "admin", "supervisor", "coordenador", "gerente", "diretoria",
      "executor", "visualizador", "recepcao", "recepcao_tao", "solicitante",
    ],
    rotulos: {
      admin: "Administrador", supervisor: "Supervisor", coordenador: "Coordenador",
      gerente: "Gerente", diretoria: "Diretoria", executor: "Executor",
      visualizador: "Visualizador", recepcao: "Recepção", solicitante: "Solicitante",
      // TAO e uma SALA: no Tarefas o acesso desse papel e decidido por
      // `reserva.sala === 'tao'` (server.js ~4614). Nao e sigla de setor.
      recepcao_tao: "Recepção — Sala TAO",
    },
    papelAdmin: "admin",
    ativo: true,
  },
  crm: {
    nome: "CRM Comercial",
    descricao: "Negócios, propostas e pipeline comercial",
    base: "/crm",
    interno: process.env.URL_CRM || "",
    icone: "briefcase",
    // Confere com ROLE_PERMISSIONS em src/security/access.js do CRM.
    // Atencao: la o papel de administrador se chama "administrador", nao "admin".
    papeis: [
      "administrador", "diretoria", "gestor", "gestor_bonus", "financeiro",
      "juridico", "propostas", "comercial_interno", "vendedor",
    ],
    rotulos: {
      administrador: "Administrador", diretoria: "Diretoria", gestor: "Gestor",
      gestor_bonus: "Gestor de Bônus", financeiro: "Financeiro",
      juridico: "Jurídico", propostas: "Propostas",
      comercial_interno: "Comercial Interno", vendedor: "Vendedor",
    },
    papelAdmin: "administrador",
    ativo: true,
  },
  nexti: {
    nome: "Checklist da Operação",
    descricao: "Checklists e roteiros da operação — abre no Nexti",
    // Sem `base` e sem `interno`: a Fachada nao encaminha este. O registro dela
    // (fachada/server.js) e outro e nao tem entrada para `nexti` — por isso
    // /nexti nao vira rota, e e assim que tem que ser.
    externo: "https://uniseter.nexti.com/",
    icone: "checklist",
    // Um papel so. Os papeis existem para o modulo saber o que a pessoa pode
    // fazer la dentro, e aqui quem decide isso e o Nexti, pelo login dele.
    // Inventar niveis daria a impressao de um controle que o portal nao tem.
    papeis: ["acesso"],
    rotulos: { acesso: "Acesso" },
    papelAdmin: "acesso",
    ativo: true,
  },
  precificacao: {
    nome: "Precificação",
    descricao: "Motor de precificação de contratos",
    base: "/precificacao",
    interno: process.env.URL_PRECIFICACAO || "",
    icone: "calculator",
    // Confere com enum UserRole em packages/shared-types/src/enums.ts.
    // Atencao: MAIUSCULAS. A lista anterior ("admin","editor","consulta") tinha
    // os tres errados — nenhum existe naquele sistema.
    papeis: ["ADMIN", "MANAGER", "ANALYST", "VIEWER"],
    rotulos: {
      ADMIN: "Administrador", MANAGER: "Gerente",
      ANALYST: "Analista", VIEWER: "Consulta",
    },
    papelAdmin: "ADMIN",
    ativo: true,
  },
};

function listar() {
  return Object.entries(MODULOS)
    .filter(([, m]) => m.ativo)
    .map(([id, m]) => ({ id, ...m }));
}

function existe(id) {
  return Boolean(MODULOS[id] && MODULOS[id].ativo);
}

// Sistema de terceiro: aparece na tela, mas nao e encaminhado nem recebe
// identidade do Core. Quem pergunta isto e o codigo que decide entre "abrir
// dentro do portal" e "abrir no endereco do fornecedor".
function ehExterno(id) {
  return Boolean(MODULOS[id] && MODULOS[id].externo);
}

function papelValido(id, papel) {
  return Boolean(MODULOS[id] && MODULOS[id].papeis.includes(papel));
}

// Como ESTE modulo chama o papel de administrador. Usado para o administrador
// geral, que entra em todos os modulos com poder total. Cada sistema batiza o
// seu: no CRM e "administrador", nos demais e "admin".
function papelDeAdmin(id) {
  const m = MODULOS[id];
  if (!m) return "admin";
  if (m.papelAdmin && m.papeis.includes(m.papelAdmin)) return m.papelAdmin;
  // Rede de seguranca: se o registro estiver incoerente, usa o primeiro papel
  // declarado — por convencao o de maior alcance — em vez de um nome inventado
  // que o modulo recusaria.
  return m.papeis[0] || "admin";
}

// Como o papel aparece na tela. O valor GRAVADO continua sendo o do modulo —
// "MANAGER" na Precificacao, "comercial_interno" no CRM — porque e isso que
// cada sistema entende. Aqui so muda o que a pessoa le.
//
// Sem rotulo declarado, arruma o que da: troca sublinhado por espaco e poe a
// primeira letra maiuscula. Melhor um "Recepcao tao" do que inventar um nome.
function rotuloDoPapel(id, papel) {
  const m = MODULOS[id];
  if (m && m.rotulos && m.rotulos[papel]) return m.rotulos[papel];
  const bruto = String(papel || "").replace(/_/g, " ").toLowerCase();
  return bruto.charAt(0).toUpperCase() + bruto.slice(1);
}

function get(id) {
  return MODULOS[id] || null;
}

module.exports = { MODULOS, listar, existe, ehExterno, papelValido, papelDeAdmin, rotuloDoPapel, get };
