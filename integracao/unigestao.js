"use strict";

// ============================================================================
// UniGestao — arquivo de integracao para os modulos
// ----------------------------------------------------------------------------
// COMO USAR
// Copie este arquivo para dentro do sistema (ex.: `unigestao.js` na raiz) e
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
// SEGURANCA
// Os cabecalhos so sao confiaveis porque o modulo NAO tem endereco publico: ele
// vive na rede privada do Railway e so a Fachada o alcanca. A chave compartilhada
// (CORE_INTERNAL_KEY) e a segunda tranca. Se o modulo tiver dominio publico, essa
// premissa cai — remova o dominio publico dele no Railway.
// ============================================================================

const CHAVE = process.env.CORE_INTERNAL_KEY || "";

function identificar(req, res, next) {
  const chaveRecebida = req.headers["x-ug-key"] || "";
  const id = req.headers["x-ug-id"];

  if (!id || (CHAVE && chaveRecebida !== CHAVE)) {
    req.usuario = null;
    return next();
  }

  const papel = String(req.headers["x-ug-papel"] || "");
  req.usuario = {
    id: String(id),
    nome: decodeURIComponent(String(req.headers["x-ug-nome"] || "")),
    email: String(req.headers["x-ug-email"] || ""),
    papel: papel,
    nivel: papel, // compatibilidade com o codigo atual dos sistemas
    superAdmin: req.headers["x-ug-super"] === "1",
  };
  // Prefixo publico do modulo (ex.: "/eventos"), util para montar links
  req.baseUniGestao = String(req.headers["x-ug-base"] || "");
  next();
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

module.exports = { identificar, exigeLogin, exigePapel, podeEditar };
