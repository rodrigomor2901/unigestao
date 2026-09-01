"use strict";

// ============================================================================
// UniGestao — arquivo de integracao para os modulos
// ----------------------------------------------------------------------------
// COMO USAR
// Copie este arquivo E o identidade.js para dentro do sistema (ex.: na raiz) e
// troque o middleware de autenticacao dele por este. Exemplo em um app Express:
//
//   const ug = require('./unigestao');
//   app.use(ug.identificar);                    // preenche req.usuario
//   app.get('/api/dados', ug.exigeLogin, ...)
//   app.post('/api/dados', ug.exigePapel('admin','gestao'), ...)
//
// req.usuario fica assim:
//   { id, nome, email, nivel, papel, superAdmin }
//
// `nivel` e `papel` carregam o MESMO valor, de proposito: os sistemas atuais ja
// usam `req.usuario.nivel` em dezenas de lugares, entao nada mais precisa mudar.
//
// O QUE REMOVER DO SISTEMA AO PLUGAR
//   - a tela e a rota de login
//   - a tela de gerenciamento de usuarios (passa a ser o Admin Geral)
//   - a tabela de sessoes propria
// A tabela de usuarios pode continuar existindo para os vinculos internos
// (quem criou o chamado, quem e o responsavel), casada pelo e-mail.
//
// ----------------------------------------------------------------------------
// SEGURANCA — leia antes de mexer
//
// A identidade chega ASSINADA pela Fachada, num cabecalho so
// (`x-ug-identidade`). O modulo confere a assinatura, o prazo e o destino ANTES
// de acreditar em qualquer campo. Sem assinatura valida, a pessoa e visitante
// anonimo — e nao adianta mandar `x-ug-papel: admin` num curl.
//
// O desenho antigo — campos soltos, validados por um segredo que vinha junto no
// `x-ug-key` — nao vale mais por padrao. Ele permitia que qualquer um com o
// segredo em maos montasse um administrador so trocando dois cabecalhos, e o
// segredo viajava em toda requisicao, para todo modulo.
//
// UG_LEGACY_HEADERS_ENABLED=true reativa o desenho antigo. Existe apenas para
// destravar uma virada de versao presa, e deve ficar desligado. Ligado, ele
// devolve exatamente o furo que esta correcao fechou.
//
// VARIAVEIS DE AMBIENTE
//   CORE_INTERNAL_KEY           obrigatoria hoje: dela deriva a chave de
//                               assinatura, quando nao ha uma dedicada
//   UG_ASSINATURA_SEGREDO       opcional (recomendada): chave de assinatura
//                               propria, igual na Fachada e nos modulos
//   UG_MODULO                   opcional: a chave deste modulo ("eventos",
//                               "crm"...). Prende o bilhete a esta porta
//   UG_LEGACY_HEADERS_ENABLED   opcional: "true" reativa os cabecalhos soltos
// ============================================================================

const identidade = require("./identidade");

const CHAVE = process.env.CORE_INTERNAL_KEY || "";
const LEGADO = process.env.UG_LEGACY_HEADERS_ENABLED === "true";

// Lidos na carga, e nao a cada requisicao: configuracao de servico nao muda no
// meio do voo, e ler uma vez deixa explicito de onde cada um veio.
//
// Sao DUAS chaves aceitas enquanto durar a troca de segredo: a dedicada
// (UG_ASSINATURA_SEGREDO) e a derivada da CORE_INTERNAL_KEY. Assim da para
// cadastrar a nova em um servico de cada vez sem derrubar ninguem.
const CHAVES_ACEITAS = identidade.chavesQueAceito();
const MODULO = process.env.UG_MODULO || "";

let avisouLegado = false;

function identificar(req, res, next) {
  req.usuario = lerIdentidade(req);
  // Prefixo publico do modulo (ex.: "/eventos"), util para montar links. Nao e
  // credencial: nao decide acesso nenhum, entao pode vir do cabecalho solto.
  req.baseUniGestao = String(req.headers["x-ug-base"] || "");
  next();
}

// Devolve o usuario, ou null. Qualquer duvida vira null: bilhete ausente,
// assinatura errada, prazo vencido, formato estranho, bilhete de outro modulo.
function lerIdentidade(req) {
  const bilhete = identidade.verificar(req.headers[identidade.CABECALHO],
                                       { chaves: CHAVES_ACEITAS, modulo: MODULO });
  if (bilhete) {
    return montar({
      id: bilhete.id,
      nome: bilhete.nome,
      email: bilhete.email,
      papel: bilhete.papel,
      superAdmin: bilhete.super,
    });
  }

  if (!LEGADO) return null;

  // ---- caminho antigo, so com a flag ligada --------------------------------
  if (!avisouLegado) {
    avisouLegado = true;
    console.warn("[unigestao] UG_LEGACY_HEADERS_ENABLED=true — identidade sendo " +
                 "aceita por cabecalhos soltos, sem assinatura. Desligue assim " +
                 "que a Fachada estiver assinando.");
  }
  const id = req.headers["x-ug-id"];
  const chaveRecebida = req.headers["x-ug-key"] || "";
  if (!id || !CHAVE || chaveRecebida !== CHAVE) return null;

  return montar({
    id,
    nome: decodeURIComponent(String(req.headers["x-ug-nome"] || "")),
    email: String(req.headers["x-ug-email"] || ""),
    papel: String(req.headers["x-ug-papel"] || ""),
    superAdmin: req.headers["x-ug-super"] === "1",
  });
}

function montar(d) {
  const papel = String(d.papel || "");
  return {
    id: String(d.id),
    nome: String(d.nome || ""),
    email: String(d.email || ""),
    papel: papel,
    nivel: papel, // compatibilidade com o codigo atual dos sistemas
    superAdmin: Boolean(d.superAdmin),
  };
}

function exigeLogin(req, res, next) {
  if (!req.usuario) return res.status(401).json({ erro: "Sessão expirada" });
  next();
}

// Aceita qualquer um dos papeis informados. Super admin sempre passa.
function exigePapel(...papeis) {
  return (req, res, next) => {
    if (!req.usuario) return res.status(401).json({ erro: "Sessão expirada" });
    if (req.usuario.superAdmin) return next();
    if (papeis.length && !papeis.includes(req.usuario.papel)) {
      return res.status(403).json({ erro: "Sem permissão para esta ação" });
    }
    next();
  };
}

function podeEditar(req) {
  return Boolean(req.usuario) && req.usuario.papel !== "consulta" && req.usuario.papel !== "visualizador";
}

module.exports = { identificar, exigeLogin, exigePapel, podeEditar, lerIdentidade };
