"use strict";

// ============================================================================
// Avisa o CRM de quem tem acesso a ele
// ----------------------------------------------------------------------------
// POR QUE ISSO EXISTE
// O CRM criava a pessoa so na primeira visita dela. Cadastrar um vendedor no
// UniGestao nao bastava para passar um negocio para ele: ate ele abrir o CRM,
// nao aparecia em lista nenhuma (13/09/2026).
//
// COMO FUNCIONA
// Sempre que o Admin Geral salva alguem — e quando o Core liga — o Core manda ao
// CRM a LISTA INTEIRA de quem tem acesso a ele, assinada. O CRM cria quem falta,
// atualiza nome/e-mail/papel e desativa quem saiu da lista.
//
// Lista inteira, e nao "o que mudou", de proposito: se o CRM estiver fora do ar
// num salvamento, o proximo salvamento (ou o proximo boot) corrige tudo sozinho.
// Sao dezenas de pessoas — o pacote e pequeno.
//
// Nunca atrasa nem derruba o cadastro: roda depois da resposta, e falha so vai
// para o log. A primeira visita da pessoa ao CRM continua criando o cadastro la,
// como antes — isto so adianta.
//
// Variaveis no servico core: URL_CRM (o mesmo endereco que a Fachada usa) e
// UG_ASSINATURA_SEGREDO (o mesmo segredo da Fachada). Sem as duas, fica
// desligado e avisa uma vez no log.
// ============================================================================

const db = require("./db");
const modulos = require("./modulos");
const sincronia = require("../integracao/sincronia");

const ESPERA_MS = 10000;
// Varios salvamentos seguidos (desativar cinco pessoas, por exemplo) viram um
// envio so.
const AGRUPAR_MS = 1500;
const TENTAR_DE_NOVO_MS = 60000;

let timer = null;
let avisouDesligado = false;

function endereco(env = process.env) {
  return String(env.URL_CRM || "").trim().replace(/\/+$/, "");
}

function ligado(env = process.env) {
  return Boolean(endereco(env) && env.UG_ASSINATURA_SEGREDO);
}

// Quem entra no CRM hoje: conta ativa E (modulo CRM marcado OU super admin — que
// entra em todos os modulos com o papel de administrador de cada um).
async function montarLista(consulta = db.query) {
  const r = await consulta(
    `SELECT u.id, u.nome, u.email,
            COALESCE(m.papel, CASE WHEN u.super_admin THEN $1 END) AS papel
       FROM usuarios u
       LEFT JOIN usuario_modulos m ON m.usuario_id = u.id AND m.modulo = 'crm'
      WHERE u.ativo = TRUE
        AND (m.papel IS NOT NULL OR u.super_admin = TRUE)
      ORDER BY u.nome`,
    [modulos.papelDeAdmin("crm")]
  );
  return r.rows.map((p) => ({
    id: p.id, nome: p.nome || "", email: String(p.email || "").toLowerCase(), papel: p.papel,
  }));
}

async function enviar(opcoes = {}) {
  const env = opcoes.env || process.env;
  if (!ligado(env)) {
    if (!avisouDesligado) {
      avisouDesligado = true;
      console.log("[sincronia-crm] desligada: falta URL_CRM ou UG_ASSINATURA_SEGREDO no servico core");
    }
    return { ok: false, desligada: true };
  }

  const pessoas = await montarLista(opcoes.consulta);
  const pacote = sincronia.assinarPacote("crm", { pessoas }, { env });
  const ir = opcoes.fetch || fetch;
  const resp = await ir(endereco(env) + "/api/unigestao/pessoas", {
    method: "POST",
    headers: { "content-type": "application/json", [sincronia.CABECALHO]: pacote.assinatura },
    body: pacote.corpo,
    signal: AbortSignal.timeout(ESPERA_MS),
  });
  const texto = await resp.text().catch(() => "");
  if (!resp.ok) throw new Error("CRM respondeu " + resp.status + ": " + texto.slice(0, 200));
  console.log("[sincronia-crm] " + pessoas.length + " pessoas enviadas — " + texto.slice(0, 200));
  return { ok: true, pessoas: pessoas.length };
}

// Pede um envio para daqui a pouco. Chamado depois de responder ao Admin Geral.
function agendar(atrasoMs = AGRUPAR_MS) {
  if (!ligado()) return enviar().catch(() => {});
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    timer = null;
    enviar().catch((e) => {
      console.warn("[sincronia-crm] falhou, tento de novo em 1 minuto:", e.message);
      if (!timer) agendar(TENTAR_DE_NOVO_MS);
    });
  }, atrasoMs);
  if (timer.unref) timer.unref();
}

module.exports = { agendar, enviar, montarLista, ligado };
