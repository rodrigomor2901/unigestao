"use strict";

// ============================================================================
// UniGestao — arquivo de integracao para os modulos
// ----------------------------------------------------------------------------
// COMO USAR
// Copie este arquivo E o identidade.js para dentro do sistema (ex.: na raiz) e
// troque o middleware de autenticacao dele por este. Exemplo em um app Express:
//
//   const ug = require('./unigestao');
//   app.use(ug.portaDaFachada());               // fecha a porta antiga do sistema
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
  // Guardado no proprio pedido. Cada bilhete so vale UMA vez — conferir duas
  // vezes no mesmo pedido derrubaria a segunda conferencia, e a pessoa viraria
  // visitante anonima no meio da propria requisicao.
  if (req.__ugIdent !== undefined) return req.__ugIdent;
  req.__ugIdent = conferirIdentidade(req);
  return req.__ugIdent;
}

function conferirIdentidade(req) {
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

// ---------------------------------------------------------------------------
// PORTA DA FRENTE — so entra quem vem pela Fachada
// ----------------------------------------------------------------------------
// Todo pedido que passa pelo UniGestao chega com um bilhete assinado. Quem
// digita o endereco antigo deste sistema nao traz bilhete nenhum.
//
// POR QUE ISTO EXISTE
// Desativar a pessoa no UniGestao derruba a sessao dela e fecha os seis modulos
// — mas so pela porta do portal. O endereco proprio deste sistema continuava no
// ar, com o login antigo dele, e quem tinha senha aqui de antes da unificacao
// entrava por fora: sem passar por permissao, sem 2FA e sem aparecer na
// auditoria do portal. Era a porta dos fundos de um desligamento.
//
// Fechar aqui, e nao so escondendo a tela de login, e o que resolve de verdade:
// mesmo que sobre alguma rota de login esquecida no codigo, ela fica atras
// desta tranca e nao responde a ninguem de fora.
//
// DUAS SAIDAS, de proposito:
//   - `UG_PORTA_ABERTA=true` destranca tudo. E para o dia em que o portal
//     estiver fora do ar e for preciso entrar por aqui — sem isso, uma falha na
//     Fachada tornaria os seis sistemas inalcancaveis ao mesmo tempo.
//   - os enderecos de saude seguem abertos, senao o Railway declara o servico
//     morto e para de publicar as novas versoes.
//
// Escrito sobre `http` puro (writeHead/end), e nao sobre o Express: dois dos
// seis modulos nao usam Express, e uma tranca so vale se for a MESMA nos seis.
// ---------------------------------------------------------------------------

var PORTAL = process.env.UG_PORTAL_URL || "https://unigestao.up.railway.app";

var SAUDE = ["/health", "/healthz", "/_health", "/api/health", "/status", "/api/status"];

function paginaDaPorta() {
  return '<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    "<title>UniGestão</title><style>" +
    "body{margin:0;font:16px/1.6 system-ui,'Segoe UI',Arial,sans-serif;color:#1c1c1c;" +
    "background:#f5f4f0;display:flex;align-items:center;justify-content:center;min-height:100vh}" +
    ".c{max-width:430px;padding:34px;text-align:center}" +
    "h1{font-size:20px;color:#12335e;margin:0 0 10px}" +
    "p{color:#5b6270;margin:0 0 22px}" +
    "a{display:inline-block;background:#12335e;color:#fff;text-decoration:none;" +
    "padding:11px 22px;border-radius:8px;font-size:15px}" +
    "</style></head><body><div class=c>" +
    "<h1>Este sistema abre pelo UniGestão</h1>" +
    "<p>O acesso passa pelo portal: é lá que ficam o seu login, a sua senha e as suas permissões. " +
    "Entre por ele e escolha este sistema na tela inicial.</p>" +
    '<a href="' + PORTAL + '">Ir para o UniGestão</a>' +
    "</div></body></html>";
}

// Devolve TRUE quando ja respondeu — quem chama nao deve seguir adiante.
//
// `livres` abre caminhos especificos deste sistema (um webhook que venha de
// fora, por exemplo). Use com parcimonia: cada caminho livre e uma porta que
// continua destrancada.
function portaFechada(req, res, opcoes) {
  opcoes = opcoes || {};
  if (String(process.env.UG_PORTA_ABERTA || "") === "true") return false;

  var caminho = String(req.url || "").split("?")[0];
  if (SAUDE.indexOf(caminho) !== -1) return false;
  if ((opcoes.livres || []).indexOf(caminho) !== -1) return false;

  if (lerIdentidade(req)) return false;

  // Chamada de programa recebe erro; navegador recebe explicacao.
  if (String(req.headers.accept || "").indexOf("text/html") === -1) {
    res.writeHead(403, { "content-type": "application/json; charset=utf-8" });
    res.end(JSON.stringify({ error: "Este sistema abre pelo UniGestão.", url: PORTAL }));
    return true;
  }

  // 200, e nao 403, no caminho do navegador: e uma pagina de verdade, e um erro
  // aqui faria o Railway achar que o servico esta quebrado.
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(paginaDaPorta());
  return true;
}

// O mesmo, no formato que o Express espera.
function portaDaFachada(opcoes) {
  return function (req, res, next) {
    if (!portaFechada(req, res, opcoes)) next();
  };
}

module.exports = { identificar, exigeLogin, exigePapel, podeEditar, lerIdentidade, portaDaFachada, portaFechada };
