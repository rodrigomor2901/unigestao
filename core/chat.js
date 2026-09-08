"use strict";

// ============================================================================
// COMUNICADOR INTERNO — regras
// ----------------------------------------------------------------------------
// Fica fora do server.js pelo mesmo motivo do mural: aqui esta o que e decisao
// de gente (o que vale como mensagem, quem pode apagar, o que e "online"), e
// nao encanamento de rota. E o arquivo para onde olhar quando a regra mudar.
// ============================================================================

const TEXTO_MAX = 4000;
const SOBRE_MAX = 120;

// Print de tela e o motivo de existir imagem aqui — e print e maior que foto de
// perfil. 1,2 MB cobre uma tela cheia em PNG; a tela reduz antes de enviar e
// isto e a rede de seguranca para quem chamar a API direto.
const IMAGEM_MAX_BYTES = 1200 * 1024;
const IMAGEM_TIPOS = ["image/png", "image/jpeg", "image/webp"];

// Quanto tempo sem dar sinal ate a bolinha apagar. O fluxo em tempo real bate
// a cada 25s; 90s aguenta duas batidas perdidas antes de dizer que a pessoa
// saiu — melhor um "online" atrasado por um minuto do que uma bolinha que
// pisca a cada oscilacao de rede.
const ONLINE_SEGUNDOS = 90;

// Quem enxerga o comunicador.
//
// Vazio (o normal) = todo mundo. Com e-mails na variavel CHAT_EMAILS, so eles —
// e assim da para experimentar com tres pessoas antes de aparecer para as 45.
// A trava vale nos DOIS sentidos: quem nao esta na lista nao ve o chat, e nao
// aparece na lista de quem ve. Metade da regra deixaria alguem mandando
// mensagem para quem nunca vai receber.
function liberados(env = process.env) {
  return String(env.CHAT_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

function podeUsar(usuario, env = process.env) {
  if (!usuario) return false;
  const lista = liberados(env);
  if (!lista.length) return true;
  return lista.includes(String(usuario.email || "").toLowerCase());
}

// As situacoes que a pessoa pode escolher. Nada escolhido = automatico: ela
// aparece online enquanto estiver com o sistema aberto.
const STATUS = ["ocupado", "reuniao"];

// Quanto tempo a situacao escolhida vale. Um dia de trabalho.
//
// Sem prazo, quem marcou "em reuniao" as 14h de sexta aparece em reuniao na
// segunda — e situacao que mente faz as pessoas pararem de acreditar em todas,
// inclusive nas verdadeiras.
const STATUS_HORAS = 8;

function statusValido(v) {
  const s = String(v == null ? "" : v).trim();
  return STATUS.includes(s) ? s : null;
}

// Como a pessoa aparece para os outros.
//
// Estar offline VENCE qualquer situacao escolhida: quem marcou "ocupado" e
// fechou o navegador esta offline, e nao ocupado. Mostrar "ocupado" faria
// alguem esperar resposta de quem nem esta no sistema.
function comoAparece(online, status) {
  if (!online) return "offline";
  return statusValido(status) || "online";
}

// Situacao que silencia o aviso — o "nao perturbe".
//
// Silencia som e caixinha, mas NAO o contador: a pessoa escolheu nao ser
// interrompida, nao deixar de saber.
function calaOAviso(status) {
  return statusValido(status) !== null;
}

// O nome do departamento, tratado como chave do canal.
//
// Comparacao sem caixa e sem espaco sobrando, igual ao casamento com as equipes
// da Gestao de Tarefas: quem digitou " comercial " e quem digitou "COMERCIAL"
// tem que cair no mesmo canal, senao a area se divide em dois sem ninguem
// entender por que metade da conversa sumiu.
function mesmoDepartamento(a, b) {
  const n = (v) => String(v == null ? "" : v).trim().toLowerCase();
  const x = n(a);
  return Boolean(x) && x === n(b);
}

function nomeDeCanal(v) {
  const s = String(v == null ? "" : v).trim();
  return s ? s.slice(0, 120) : null;
}

function limparTexto(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

// A dupla, sempre na mesma ordem: o menor id primeiro.
//
// E o que faz o indice unico do banco valer nos dois sentidos. Sem ordenar,
// (A,B) e (B,A) seriam pares diferentes para o banco e a mesma dupla teria
// duas conversas — cada um falando na sua e achando que o outro nao responde.
function parDe(umId, outroId) {
  const a = String(umId || "");
  const b = String(outroId || "");
  if (!a || !b) return null;
  if (a === b) return null;              // conversa consigo mesma nao existe
  return a < b ? [a, b] : [b, a];
}

// Endereco de "conversar sobre isto".
//
// So caminho interno passa: tem que comecar com uma barra e o proximo
// caractere nao pode ser outra barra nem contrabarra. Sem esse corte,
// "//site.com" viraria link externo dentro de uma mensagem que parece ter sido
// gerada pelo proprio sistema — o UniGestao emprestando credibilidade a um
// golpe. Mesma regra do destino de login na Fachada.
function linkInterno(v) {
  const s = String(v == null ? "" : v).trim();
  return /^\/[^/\\]/.test(s) ? s.slice(0, 300) : null;
}

function validarMensagem(corpo) {
  const texto = limparTexto(corpo.texto, TEXTO_MAX);
  const temImagem = Boolean(corpo.imagem && corpo.imagemTipo);

  // Mensagem vazia nao existe — mas texto vazio COM print e mensagem legitima:
  // muita gente cola a tela e nao escreve nada.
  if (!texto && !temImagem) {
    return { ok: false, erro: "Escreva alguma coisa ou anexe um print." };
  }
  if (temImagem && !IMAGEM_TIPOS.includes(corpo.imagemTipo)) {
    return { ok: false, erro: "Formato de imagem não aceito." };
  }

  return {
    ok: true,
    valores: {
      texto,
      sobre: limparTexto(corpo.sobre, SOBRE_MAX) || null,
      link: linkInterno(corpo.link),
    },
  };
}

// Apagar: so quem escreveu.
//
// Nem o administrador geral entra aqui, de proposito. Apagar mensagem dos
// outros e mexer na conversa alheia por um caminho lateral; se um dia a
// diretoria precisar do conteudo, o caminho e o resgate registrado — que
// mostra, nao apaga.
function podeApagar(u, mensagem) {
  return Boolean(u && mensagem && mensagem.autor_id === u.id);
}

// Resgate de conversa: administrador geral, com motivo escrito.
//
// O motivo nao e burocracia — e o que fica na auditoria. Um resgate sem motivo
// registrado e indistinguivel de bisbilhotice seis meses depois, inclusive para
// quem resgatou de boa-fe e precisa explicar.
function validarResgate(corpo) {
  const motivo = limparTexto(corpo.motivo, 500);
  if (motivo.length < 10) {
    return { ok: false, erro: "Descreva quem pediu o resgate e por quê (mínimo 10 caracteres)." };
  }
  return { ok: true, motivo };
}

module.exports = {
  TEXTO_MAX, SOBRE_MAX, IMAGEM_MAX_BYTES, IMAGEM_TIPOS, ONLINE_SEGUNDOS,
  limparTexto, parDe, linkInterno, validarMensagem, podeApagar, validarResgate,
  liberados, podeUsar,
  STATUS, STATUS_HORAS, statusValido, comoAparece, calaOAviso,
  mesmoDepartamento, nomeDeCanal,
};
