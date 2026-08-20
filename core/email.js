"use strict";

// ============================================================================
// ENVIO DE E-MAIL DO CORE
// ----------------------------------------------------------------------------
// O Core e quem gera as senhas, entao e o Core quem avisa a pessoa. Nenhum
// modulo precisa saber de senha para isso.
//
// Reaproveita a conta SendGrid que a Gestao de Tarefas ja usa: o dominio
// uniseter.com.br esta autenticado la (Settings > Sender Authentication, com
// os CNAME/TXT na Locaweb). E por isso que o remetente precisa ser um endereco
// @uniseter.com.br — mandar de um dominio nao autenticado cai em spam por
// DMARC, que foi exatamente o problema que o Tarefas ja teve.
//
// Nada aqui lanca excecao. Falha de e-mail nao pode derrubar a criacao de um
// usuario: a conta existe do mesmo jeito, e sempre da para reenviar o aviso.
// Por isso as funcoes devolvem {ok, erro} em vez de estourar.
// ============================================================================

const sgMail = require("@sendgrid/mail");

const CHAVE = (process.env.SENDGRID_API_KEY || "").trim();
if (CHAVE) sgMail.setApiKey(CHAVE);

// Modo rascunho: com EMAIL_ARQUIVO definido, nada sai para o mundo — cada
// mensagem vira uma linha num arquivo. E o que roda em desenvolvimento e nos
// testes, para nunca existir a chance de um e-mail de verdade escapar para uma
// pessoa de verdade durante um teste. Tem precedencia sobre a chave: se as
// duas estiverem definidas, grava e nao envia.
const ARQUIVO = (process.env.EMAIL_ARQUIVO || "").trim();

const REMETENTE_ENDERECO = (process.env.EMAIL_FROM || "naoresponda@uniseter.com.br").trim();
const REMETENTE = "UniGestão <" + REMETENTE_ENDERECO + ">";
const URL_PORTAL = (process.env.URL_PUBLICA || "https://unigestao.up.railway.app").replace(/\/+$/, "");

function configurado() {
  return Boolean(CHAVE || ARQUIVO);
}

// "rascunho" = grava em arquivo, nao envia. "envio" = sai de verdade.
// "desligado" = nao ha para onde mandar.
function modo() {
  if (ARQUIVO) return "rascunho";
  return CHAVE ? "envio" : "desligado";
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Log sem PII em claro: "fulano@empresa.com" -> "f***o@empresa.com".
// Mesmo formato que o Tarefas usa, para os dois logs ficarem comparaveis.
function mascarar(email) {
  const p = String(email || "").split("@");
  if (p.length !== 2 || p[0].length < 2) return "[email]";
  return p[0][0] + "***" + p[0][p[0].length - 1] + "@" + p[1];
}

async function enviar(para, assunto, html) {
  if (ARQUIVO) {
    try {
      require("fs").appendFileSync(
        ARQUIVO, JSON.stringify({ para, assunto, html }) + "\n", "utf8"
      );
      return { ok: true, gravado: ARQUIVO };
    } catch (e) {
      return { ok: false, erro: e.message };
    }
  }
  if (!configurado()) {
    return { ok: false, erro: "SENDGRID_API_KEY nao configurada" };
  }
  try {
    await sgMail.send({ from: REMETENTE, to: para, subject: assunto, html });
    return { ok: true };
  } catch (e) {
    const detalhe = e.response && e.response.body
      ? JSON.stringify(e.response.body)
      : e.message;
    console.warn("Falha ao enviar e-mail para " + mascarar(para) + ": " + detalhe);
    return { ok: false, erro: detalhe };
  }
}

// ---------------------------------------------------------------------------
// Aparencia. Sem imagem e sem CSS externo de proposito: cliente de e-mail
// corporativo bloqueia imagem por padrao, e um aviso de acesso que chega
// quebrado parece golpe. Tabela com estilo inline e o que o Outlook renderiza
// igual ao Gmail.
// ---------------------------------------------------------------------------
function moldura(titulo, miolo) {
  // O fundo cinza tambem vem de uma celula com bgcolor, pelo mesmo motivo do
  // botao: o Word ignora `background` de CSS num <div>, e o cartao ficaria
  // solto num fundo branco.
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
           'bgcolor="#f5f4f0" style="background:#f5f4f0;font-family:Arial,Helvetica,sans-serif">' +
    '<tr><td align="center" style="padding:28px 12px">' +
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" ' +
           'bgcolor="#ffffff" ' +
           'style="max-width:520px;background:#ffffff;border-radius:10px;overflow:hidden">' +
      '<tr><td bgcolor="#26357A" style="background:#26357A;padding:18px 26px">' +
        '<span style="color:#fff;font-size:19px;font-weight:700">Uni</span>' +
        // Amarelo, nao laranja: sobre o navy o laranja #EC7807 escurece e some.
        // E o mesmo amarelo que o simbolo do Grupo usa na parte de cima do U.
        '<span style="color:#F7B312;font-size:19px;font-weight:700">Gestão</span>' +
      '</td></tr>' +
      '<tr><td style="padding:26px">' +
        '<h1 style="margin:0 0 16px;font-size:18px;color:#101828">' + esc(titulo) + '</h1>' +
        miolo +
      '</td></tr>' +
      '<tr><td style="padding:0 26px 24px">' +
        '<p style="margin:0;font-size:12px;color:#98a2b3;line-height:1.5">' +
          'Mensagem automática do UniGestão — não responda a este e-mail.<br>' +
          'Se você não esperava receber isto, avise o administrador do sistema.' +
        '</p>' +
      '</td></tr>' +
    '</table>' +
    '</td></tr></table>';
}

// Botao "a prova de bala": duas versoes na mesma mensagem, cada cliente le a
// sua. Foi preciso chegar aqui porque o Outlook do Windows desenha e-mail com
// o motor do Word, e ele nao respeita padding, line-height nem border-radius
// de CSS — tentar acertar a medida por CSS so mudava o tamanho do problema.
//
//   Outlook  -> uma forma VML (v:roundrect) com altura e largura em pixel.
//               O <w:anchorlock/> impede o Word de deslocar o texto dentro
//               dela; sem isso o rotulo escorrega para um canto.
//   O resto  -> o link normal com fundo e cantos arredondados, dentro do
//               truque de comentario `[if !mso]` que o Outlook pula e os
//               demais clientes leem como conteudo comum.
//
// A largura precisa ser fixa: VML nao se ajusta ao texto.
//
// E precisa ser DUAS larguras. A altura em px o Word respeita, mas a largura
// ele encolhe por volta de 0.8 (mede a forma em ponto e o texto em pixel) —
// no primeiro teste os 185px declarados renderizaram ~148px e o rotulo quebrou
// em duas linhas, cortado. Entao a forma do Outlook vai declarada com folga, e
// a versao em CSS, que nao sofre disso, fica justa ao texto.
const ALTURA_BOTAO = 40;
function larguraBotao(texto) {
  return Math.round(texto.length * 7.8) + 44;
}
function larguraBotaoOutlook(texto) {
  return Math.round(larguraBotao(texto) * 1.45);
}

function botao(texto) {
  const rotulo = esc(texto);
  const larg = larguraBotao(texto);
  const largMso = larguraBotaoOutlook(texto);
  return '<div style="margin:22px 0">' +
      '<!--[if mso]>' +
      '<v:roundrect xmlns:v="urn:schemas-microsoft-com:vml" ' +
        'xmlns:w="urn:schemas-microsoft-com:office:word" href="' + URL_PORTAL + '" ' +
        'style="height:' + ALTURA_BOTAO + 'px;v-text-anchor:middle;width:' + largMso + 'px;" ' +
        'arcsize="15%" stroke="f" fillcolor="#26357A">' +
        '<w:anchorlock/>' +
        '<center style="color:#ffffff;font-family:Arial,sans-serif;font-size:14px;">' +
          rotulo +
        '</center>' +
      '</v:roundrect>' +
      '<![endif]-->' +
      '<!--[if !mso]><!-->' +
      '<a href="' + URL_PORTAL + '" style="background-color:#26357A;border-radius:6px;' +
        'color:#ffffff;display:inline-block;font-family:Arial,Helvetica,sans-serif;' +
        'font-size:14px;line-height:' + ALTURA_BOTAO + 'px;text-align:center;' +
        'text-decoration:none;width:' + larg + 'px;-webkit-text-size-adjust:none">' +
        rotulo +
      '</a>' +
      '<!--<![endif]-->' +
    '</div>' +
    '<p style="margin:0 0 4px;font-size:13px;color:#667085">Se o botão não funcionar, ' +
    'copie este endereço no navegador:</p>' +
    '<p style="margin:0;font-size:13px"><a href="' + URL_PORTAL + '" style="color:#26357A">' +
    esc(URL_PORTAL) + '</a></p>';
}

function listaModulos(modulos) {
  if (!modulos || !modulos.length) return "";
  return '<ul style="margin:0 0 18px;padding-left:20px;font-size:14px;color:#344054;line-height:1.7">' +
    modulos.map(function (m) {
      return "<li><b>" + esc(m.nome) + "</b>" +
             (m.papelRotulo ? " — " + esc(m.papelRotulo) : "") + "</li>";
    }).join("") + "</ul>";
}

// ---------------------------------------------------------------------------
// E-mail 1 — conta nova, com senha provisoria.
//
// Montar e enviar sao separados de proposito: da para revisar o texto exato
// que vai sair, e para testar o conteudo, sem mandar nada para ninguem.
// ---------------------------------------------------------------------------
function htmlContaNova({ nome, email, senha, modulos }) {
  const primeiro = String(nome || "").trim().split(/\s+/)[0] || "";
  const miolo =
    '<p style="margin:0 0 16px;font-size:14px;color:#344054;line-height:1.6">' +
      'Olá' + (primeiro ? ", " + esc(primeiro) : "") + '! Os sistemas do Grupo passaram a ' +
      'ficar num lugar só, o <b>UniGestão</b>: um endereço e uma senha para tudo o que ' +
      'você usa. Sua conta já está criada.' +
    '</p>' +
    listaModulos(modulos) +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
           'style="background:#f8f9fb;border-radius:8px;margin:0 0 4px">' +
      '<tr><td style="padding:16px 18px;font-size:14px;color:#344054;line-height:1.9">' +
        'E-mail: <b>' + esc(email) + '</b><br>' +
        'Senha provisória: <b style="font-family:Consolas,monospace;font-size:15px">' +
          esc(senha) + '</b>' +
      '</td></tr>' +
    '</table>' +
    botao("Entrar no UniGestão") +
    '<p style="margin:20px 0 0;font-size:14px;color:#344054;line-height:1.6">' +
      'No primeiro acesso o sistema pede que você troque essa senha por uma sua. ' +
      'A provisória deixa de valer nesse momento.' +
    '</p>';
  return moldura("Seu acesso está pronto", miolo);
}

async function avisarContaNova(dados) {
  return enviar(dados.email, "Seu acesso ao UniGestão", htmlContaNova(dados));
}

// ---------------------------------------------------------------------------
// E-mail 2 — quem ja entra no UniGestao e ganhou um modulo novo.
// Sem senha nenhuma: a pessoa continua com a que ja escolheu. Mandar senha
// para quem ja tem uma so confundiria.
// ---------------------------------------------------------------------------
function htmlModuloNovo({ nome, modulos }) {
  const primeiro = String(nome || "").trim().split(/\s+/)[0] || "";
  const quantos = (modulos || []).length;
  const miolo =
    '<p style="margin:0 0 16px;font-size:14px;color:#344054;line-height:1.6">' +
      'Olá' + (primeiro ? ", " + esc(primeiro) : "") + '! ' +
      (quantos === 1 ? 'Um módulo novo apareceu' : 'Módulos novos apareceram') +
      ' no seu UniGestão:' +
    '</p>' +
    listaModulos(modulos) +
    '<p style="margin:0 0 4px;font-size:14px;color:#344054;line-height:1.6">' +
      '<b>Sua senha continua a mesma.</b> É só entrar como sempre — ' +
      (quantos === 1 ? 'o módulo já está' : 'os módulos já estão') + ' na sua tela inicial.' +
    '</p>' +
    botao("Abrir o UniGestão");
  return moldura("Você tem um acesso novo", miolo);
}

async function avisarModuloNovo(dados) {
  return enviar(dados.email, "Novo módulo no seu UniGestão", htmlModuloNovo(dados));
}

// ---------------------------------------------------------------------------
// E-mail 3 — o administrador redefiniu a senha de alguem.
//
// Texto diferente do de conta nova de proposito: quem recebe este ja tem
// conta ha tempos, e "sua conta foi criada" faria a pessoa achar que e golpe.
// ---------------------------------------------------------------------------
function htmlSenhaNova({ nome, email, senha }) {
  const primeiro = String(nome || "").trim().split(/\s+/)[0] || "";
  const miolo =
    '<p style="margin:0 0 16px;font-size:14px;color:#344054;line-height:1.6">' +
      'Olá' + (primeiro ? ", " + esc(primeiro) : "") + '! A senha da sua conta no ' +
      '<b>UniGestão</b> foi redefinida pelo administrador. Use a senha provisória ' +
      'abaixo para entrar.' +
    '</p>' +
    '<table role="presentation" cellpadding="0" cellspacing="0" width="100%" ' +
           'style="background:#f8f9fb;border-radius:8px;margin:0 0 4px">' +
      '<tr><td style="padding:16px 18px;font-size:14px;color:#344054;line-height:1.9">' +
        'E-mail: <b>' + esc(email) + '</b><br>' +
        'Senha provisória: <b style="font-family:Consolas,monospace;font-size:15px">' +
          esc(senha) + '</b>' +
      '</td></tr>' +
    '</table>' +
    botao("Entrar no UniGestão") +
    '<p style="margin:20px 0 0;font-size:14px;color:#344054;line-height:1.6">' +
      'O sistema vai pedir que você escolha uma senha sua logo no primeiro acesso. ' +
      'Se não foi você que pediu a redefinição, avise o administrador.' +
    '</p>';
  return moldura("Sua senha foi redefinida", miolo);
}

async function avisarSenhaNova(dados) {
  return enviar(dados.email, "Sua senha do UniGestão foi redefinida", htmlSenhaNova(dados));
}

module.exports = {
  configurado, modo, enviar,
  avisarContaNova, avisarModuloNovo, avisarSenhaNova,
  htmlContaNova, htmlModuloNovo, htmlSenhaNova,
  mascarar, URL_PORTAL, REMETENTE_ENDERECO,
};
