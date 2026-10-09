"use strict";

// ============================================================================
// ENVIO DE E-MAIL DO CORE
// ----------------------------------------------------------------------------
// O Core e quem gera as senhas, entao e o Core quem avisa a pessoa. Nenhum
// modulo precisa saber de senha para isso.
//
// Usa a MESMA conta Brevo da Gestao de Tarefas. O Grupo trocou o SendGrid
// pelo Brevo (plano gratuito de 300 e-mails/dia cobre o volume), e o Core
// ficou para tras: continuou mandando com a chave do SendGrid, que foi
// desativada na mudanca — e todo cadastro novo passou a sair sem e-mail, com o
// administrador lendo um erro em ingles na tela (11/09/2026).
//
// O dominio uniseter.com.br esta autenticado no Brevo (Senders & IP > Domains,
// com SPF/DKIM na Locaweb). E por isso que o remetente precisa ser um endereco
// @uniseter.com.br — mandar de dominio nao autenticado cai em spam por DMARC.
//
// Sem biblioteca: a API do Brevo e um POST HTTPS simples, e o fetch do proprio
// Node resolve. Uma dependencia a menos para atualizar e para quebrar.
//
// Nada aqui lanca excecao. Falha de e-mail nao pode derrubar a criacao de um
// usuario: a conta existe do mesmo jeito, e sempre da para reenviar o aviso.
// Por isso as funcoes devolvem {ok, erro} em vez de estourar.
// ============================================================================

const CHAVE = (process.env.BREVO_API_KEY || "").trim();
const API_BREVO = "https://api.brevo.com/v3/smtp/email";

// Quanto esperar o Brevo responder. Sem limite, um Brevo lento prenderia a
// tela de "Nova pessoa" girando — e o cadastro ja esta salvo, o e-mail e so o
// aviso. Dez segundos e folga de sobra para um POST que costuma levar um.
const ESPERA_MS = 10000;

// Modo rascunho: com EMAIL_ARQUIVO definido, nada sai para o mundo — cada
// mensagem vira uma linha num arquivo. E o que roda em desenvolvimento e nos
// testes, para nunca existir a chance de um e-mail de verdade escapar para uma
// pessoa de verdade durante um teste. Tem precedencia sobre a chave: se as
// duas estiverem definidas, grava e nao envia.
const ARQUIVO = (process.env.EMAIL_ARQUIVO || "").trim();

const REMETENTE_ENDERECO = (process.env.EMAIL_FROM || "naoresponda@uniseter.com.br").trim();
// Endereco publico do portal. `botao(texto, destino)` aceita um destino
// proprio — o link de recuperacao de senha vai para /redefinir?token=...
const URL_PORTAL_PADRAO = (process.env.URL_PUBLICA || "https://unigestao.up.railway.app").replace(/\/+$/, "");
const URL_PORTAL = URL_PORTAL_PADRAO;

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
    return { ok: false, erro: "a chave do Brevo (BREVO_API_KEY) não está configurada no Railway" };
  }
  try {
    const resp = await fetch(API_BREVO, {
      method: "POST",
      headers: { "api-key": CHAVE, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: "UniGestão", email: REMETENTE_ENDERECO },
        to: [{ email: para }],
        subject: assunto,
        htmlContent: html,
      }),
      signal: AbortSignal.timeout(ESPERA_MS),
    });
    if (resp.ok) return { ok: true };

    const status = resp.status;
    const detalhe = await resp.text().catch(() => "");
    console.warn("Falha ao enviar e-mail para " + mascarar(para) + " (" + status + "): " + detalhe);
    return { ok: false, erro: explicarFalha(status, detalhe), status };
  } catch (e) {
    // Aqui so chega falha de rede ou tempo esgotado — recusa do Brevo volta
    // acima, com status.
    const status = 0;
    const detalhe = e.name === "TimeoutError" ? "o Brevo não respondeu a tempo" : e.message;
    // O motivo tecnico fica no log, para quem for investigar. Para o
    // administrador vai uma frase que diz o que fazer.
    console.warn("Falha ao enviar e-mail para " + mascarar(para) + " (" + status + "): " + detalhe);
    return { ok: false, erro: explicarFalha(status, detalhe), status };
  }
}

// Traduz a recusa do servico de e-mail para quem nao e tecnico.
//
// Antes o administrador lia `{"errors":[{"message":"The provided authorization
// grant is invalid, expired, or revoked"...}]}` — e nao tinha como saber que o
// problema nao era o cadastro nem o endereco, e sim a chave do servico, que
// ninguem na tela consegue consertar. O texto cru continua no log.
function explicarFalha(status, detalhe) {
  if (status === 401 || status === 403) {
    return "a chave do Brevo não vale (errada, apagada ou sem permissão de envio). " +
           "Confira a BREVO_API_KEY do serviço core no Railway";
  }
  if (status === 402 || status === 429) {
    return "o limite de envios do Brevo acabou por hoje. Tente de novo amanhã";
  }
  if (status === 400 && /sender/i.test(String(detalhe || ""))) {
    return "o Brevo recusou o remetente " + REMETENTE_ENDERECO +
           " — o endereço precisa ser do domínio autenticado lá (uniseter.com.br)";
  }
  return "o serviço de e-mail recusou o envio (" + String(detalhe || "").slice(0, 120) + ")";
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

function botao(texto, destino) {
  const rotulo = esc(texto);
  const larg = larguraBotao(texto);
  const largMso = larguraBotaoOutlook(texto);
  const URL_PORTAL = destino || URL_PORTAL_PADRAO;
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

// `para` permite mandar o aviso para um endereco DIFERENTE do login.
//
// Existe por causa das contas funcionais — recepcao, financeiro@,
// contasapagar@ —, cujo login e uma caixa que ninguem abre. O e-mail de acesso
// dessas contas chegou a um lugar onde ninguem ia ver, e a pessoa que de fato
// usa a conta ficou sem a senha. O corpo continua mostrando o login correto;
// so o destinatario muda.
async function avisarContaNova(dados) {
  return enviar(dados.para || dados.email, "Seu acesso ao UniGestão", htmlContaNova(dados));
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

// ---------------------------------------------------------------------------
// E-mail 4 — quem esqueceu a senha e pediu o caminho de volta.
//
// NAO leva senha nenhuma dentro. Manda um link que vale por uma hora e uma vez
// so; a senha nova quem escolhe e a propria pessoa, na tela. Senha viajando por
// e-mail fica para sempre na caixa de entrada de quem a recebeu.
//
// O aviso do fim existe para o caso de nao ter sido a pessoa que pediu: se
// alguem tentar entrar na conta dela, e esse e-mail que a avisa.
// ---------------------------------------------------------------------------
function htmlRecuperarSenha({ nome, link, minutos }) {
  const primeiro = String(nome || "").trim().split(/\s+/)[0] || "";
  const miolo =
    '<p style="margin:0 0 16px;font-size:14px;color:#344054;line-height:1.6">' +
      'Olá' + (primeiro ? ", " + esc(primeiro) : "") + '! Recebemos um pedido para ' +
      'redefinir a senha do seu acesso ao <b>UniGestão</b>. Clique no botão abaixo ' +
      'para escolher uma senha nova.' +
    '</p>' +
    botao("Escolher uma senha nova", link) +
    '<p style="margin:20px 0 0;font-size:14px;color:#344054;line-height:1.6">' +
      'O link vale por <b>' + esc(String(minutos)) + ' minutos</b> e só pode ser usado ' +
      'uma vez.' +
    '</p>' +
    '<p style="margin:12px 0 0;font-size:14px;color:#344054;line-height:1.6">' +
      'Se não foi você que pediu, ignore este e-mail — sua senha continua a mesma. ' +
      'Se isso se repetir, avise o administrador do sistema.' +
    '</p>';
  return moldura("Redefinir sua senha", miolo);
}

async function avisarRecuperarSenha(dados) {
  return enviar(dados.email, "Redefinir sua senha do UniGestão", htmlRecuperarSenha(dados));
}

module.exports = {
  configurado, modo, enviar,
  avisarContaNova, avisarModuloNovo, avisarSenhaNova, avisarRecuperarSenha,
  htmlContaNova, htmlModuloNovo, htmlSenhaNova, htmlRecuperarSenha,
  mascarar, URL_PORTAL, REMETENTE_ENDERECO,
  // usados pelo alerta de custos (core/custos-railway.js), com a mesma moldura
  moldura, esc,
};
