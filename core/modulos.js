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
// `base`     — caminho publico pelo qual a Fachada expoe o modulo
// `interno`  — endereco na rede privada do Railway (so a Fachada usa)
// `ativo`    — false = ainda nao plugado; some do menu e do Admin Geral
// ============================================================================

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
    ativo: true,
  },
  documentos: {
    nome: "Controle de Documentos",
    descricao: "Validade de documentos de colaboradores por contrato",
    base: "/documentos",
    interno: process.env.URL_DOCUMENTOS || "",
    icone: "folder",
    papeis: ["admin", "consulta"],
    ativo: false,
  },
  eventos: {
    nome: "Gestão de Eventos",
    descricao: "Orçamentos, propostas, eventos e Orçado x Realizado",
    base: "/eventos",
    interno: process.env.URL_EVENTOS || "",
    icone: "calendar",
    papeis: ["admin", "gestao", "proposta"],
    ativo: false,
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
    ativo: false,
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
    ativo: false,
  },
  precificacao: {
    nome: "Precificação",
    descricao: "Motor de precificação de contratos",
    base: "/precificacao",
    interno: process.env.URL_PRECIFICACAO || "",
    icone: "calculator",
    papeis: ["admin", "editor", "consulta"],
    ativo: false,
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

function papelValido(id, papel) {
  return Boolean(MODULOS[id] && MODULOS[id].papeis.includes(papel));
}

function get(id) {
  return MODULOS[id] || null;
}

module.exports = { MODULOS, listar, existe, papelValido, get };
