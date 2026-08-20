"use strict";

// ============================================================================
// MURAL — regras
// ----------------------------------------------------------------------------
// Fica fora do server.js porque e regra de convivencia, nao de rota: quem pode
// publicar, quem pode apagar o comentario de quem, o que e um texto valido.
// Esse tipo de regra muda por decisao de gente.
// ============================================================================

const TIPOS = ["aviso", "mudanca", "evento"];

// Publicar: administrador geral, ou quem foi marcado como autor do mural.
//
// O pedido original era "diretoria, gestao e marketing", mas isso e CARGO, e
// cargo aqui e texto livre que cada um digita na propria agenda. Amarrar
// permissao a texto livre daria acesso a quem escrevesse "Gestao de Contratos"
// e negaria a quem escrevesse "Diretor" — e ninguem entenderia por que.
function podePublicar(u) {
  return Boolean(u && (u.super_admin || u.mural_autor));
}

// Apagar comentario: quem escreveu, quem publicou o comunicado, ou o admin.
//
// Feed interno sem isso vira problema no dia em que alguem escrever algo
// infeliz — e sempre chega esse dia. Quem publicou responde pelo que fica
// embaixo do proprio comunicado, entao precisa poder limpar.
function podeApagarComentario(u, comentario, aviso) {
  if (!u) return false;
  if (u.super_admin) return true;
  if (comentario.usuario_id === u.id) return true;
  if (aviso && aviso.autor_id === u.id) return true;
  return false;
}

// Editar ou apagar publicacao: quem publicou, ou o admin. Um autor nao mexe no
// comunicado do outro — mesmo os dois podendo publicar.
function podeEditar(u, aviso) {
  if (!u || !aviso) return false;
  return Boolean(u.super_admin || aviso.autor_id === u.id);
}

function limparTexto(v, max) {
  return String(v == null ? "" : v).trim().slice(0, max);
}

function validarPublicacao(corpo) {
  const erros = [];
  const titulo = limparTexto(corpo.titulo, 140);
  const texto = limparTexto(corpo.texto, 4000);
  const tipo = TIPOS.includes(corpo.tipo) ? corpo.tipo : "aviso";

  if (titulo.length < 3) erros.push("Escreva um título.");

  // Pop-up e interrupcao: ele para a pessoa antes de ela fazer o que veio
  // fazer. Por isso tem prazo obrigatorio quando ligado — pop-up permanente
  // vira algo que todo mundo fecha no reflexo, sem ler, e aí ele nao serve
  // nem para o comunicado importante.
  let popupAte = null;
  if (corpo.popup) {
    const dias = Math.min(30, Math.max(1, parseInt(corpo.popupDias, 10) || 7));
    popupAte = new Date(Date.now() + dias * 24 * 60 * 60 * 1000);
  }

  return { ok: erros.length === 0, erros, valores: { titulo, texto, tipo, popupAte } };
}

function validarComentario(texto) {
  const t = limparTexto(texto, 1000);
  return { ok: t.length > 0, texto: t };
}

// Limites da imagem. A tela reduz antes de enviar; isto e a rede de seguranca
// para quem chamar a API direto.
const IMAGEM_MAX_BYTES = 900 * 1024;
const IMAGEM_TIPOS = ["image/jpeg", "image/png", "image/webp"];

module.exports = {
  TIPOS, podePublicar, podeApagarComentario, podeEditar,
  validarPublicacao, validarComentario, limparTexto,
  IMAGEM_MAX_BYTES, IMAGEM_TIPOS,
};
