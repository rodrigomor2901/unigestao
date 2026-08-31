"use strict";

const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const db = require("./db");

// ============================================================================
// SENHAS — formato com prefixo de algoritmo
// ----------------------------------------------------------------------------
// Cada sistema atual guarda a senha de um jeito. Para nao obrigar as ~1.230
// pessoas da Gestao de Tarefas a redefinir senha na virada, o campo carrega o
// algoritmo junto e o login sabe verificar todos os formatos antigos:
//
//   pbkdf2-sha256:120000:sal:hash   <- formato novo (Operacional e Documentos ja usam)
//   pbkdf2-sha512:120000:sal:hash   <- CRM
//   bcrypt:$2a$10$...               <- Gestao de Tarefas
//   sha256:hash                     <- Gestao de Eventos (INSEGURO, sem sal)
//
// Sempre que alguem entra com um formato antigo, a senha e REGRAVADA no formato
// novo automaticamente. A migracao acontece sozinha, login a login.
//
// A unica excecao e o `sha256` do Eventos: e fraco demais para ser aceito, entao
// esses usuarios sao importados ja marcados para redefinicao obrigatoria.
// ============================================================================

const PBKDF2_ITER = 120_000;
const PBKDF2_KEYLEN = 32;

function gerarHash(senha) {
  const sal = crypto.randomBytes(16).toString("hex");
  const hash = crypto
    .pbkdf2Sync(String(senha), sal, PBKDF2_ITER, PBKDF2_KEYLEN, "sha256")
    .toString("hex");
  return `pbkdf2-sha256:${PBKDF2_ITER}:${sal}:${hash}`;
}

// Retorna { ok, precisaRegravar }
async function verificarSenha(senha, armazenado) {
  if (!armazenado || typeof armazenado !== "string") return { ok: false };
  const sep = armazenado.indexOf(":");
  const algo = sep === -1 ? "" : armazenado.slice(0, sep);
  const resto = sep === -1 ? "" : armazenado.slice(sep + 1);

  try {
    if (algo === "pbkdf2-sha256" || algo === "pbkdf2-sha512") {
      const digest = algo === "pbkdf2-sha256" ? "sha256" : "sha512";
      const [iterStr, sal, hash] = resto.split(":");
      const keylen = Buffer.from(hash, "hex").length;
      const calc = crypto
        .pbkdf2Sync(String(senha), sal, parseInt(iterStr, 10), keylen, digest)
        .toString("hex");
      const ok = comparaSegura(calc, hash);
      // sha512 e do CRM: valido, mas regravamos no padrao novo
      return { ok, precisaRegravar: ok && algo !== "pbkdf2-sha256" };
    }

    if (algo === "bcrypt") {
      const ok = await bcrypt.compare(String(senha), resto);
      return { ok, precisaRegravar: ok };
    }

    if (algo === "sha256") {
      // Legado da Gestao de Eventos: SHA-256 sem sal. Nao e aceito para login.
      return { ok: false, legadoInseguro: true };
    }
  } catch (e) {
    console.error("[auth] falha ao verificar senha:", e.message);
  }
  return { ok: false };
}

function comparaSegura(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

// ============================================================================
// 2FA — TOTP (RFC 6238), sem dependencia externa
// Mesma implementacao ja em producao no Sistema de Lancamento de Extra.
// ============================================================================

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function gerarSegredoTOTP() {
  const buf = crypto.randomBytes(20);
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  let out = "";
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(s) {
  const limpo = String(s).toUpperCase().replace(/=+$/, "").replace(/\s/g, "");
  let bits = "";
  for (const c of limpo) {
    const i = B32.indexOf(c);
    if (i === -1) continue;
    bits += i.toString(2).padStart(5, "0");
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function codigoTOTP(segredo, janela = 0) {
  const contador = Math.floor(Date.now() / 30000) + janela;
  const buf = Buffer.alloc(8);
  buf.writeBigInt64BE(BigInt(contador));
  const hmac = crypto.createHmac("sha1", base32Decode(segredo)).update(buf).digest();
  const off = hmac[hmac.length - 1] & 0x0f;
  const code =
    ((hmac[off] & 0x7f) << 24) |
    ((hmac[off + 1] & 0xff) << 16) |
    ((hmac[off + 2] & 0xff) << 8) |
    (hmac[off + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

// Aceita a janela anterior e a seguinte, para tolerar relogio dessincronizado
function verificarTOTP(segredo, codigo) {
  const t = String(codigo || "").replace(/\D/g, "");
  if (t.length !== 6) return false;
  return [-1, 0, 1].some((j) => codigoTOTP(segredo, j) === t);
}

function urlQRCode(email, segredo) {
  const label = encodeURIComponent(`UniGestao:${email}`);
  return `otpauth://totp/${label}?secret=${segredo}&issuer=UniGestao&digits=6&period=30`;
}

// ---------------------------------------------------------------------------
// Passo intermediario do login: a senha ja conferiu, falta o codigo do 2FA.
//
// Fica no BANCO, nao em memoria. Em memoria o token sumiria a cada deploy ou
// reinicio do Core, e quebraria de vez se houvesse mais de uma instancia — a
// pessoa entraria a senha numa instancia e o codigo cairia na outra.
//
// A pendencia so e destruida quando o codigo ACERTA (ou quando as tentativas
// acabam). Errar o codigo nao deve obrigar a refazer o login inteiro.
// ---------------------------------------------------------------------------

const MAX_TENTATIVAS_2FA = 5;

setInterval(() => {
  db.query("DELETE FROM login_2fa_pendente WHERE expira_em < NOW()").catch(() => {});
}, 5 * 60 * 1000).unref();

async function criarPendencia2FA(usuarioId) {
  const tempToken = crypto.randomBytes(24).toString("hex");
  await db.query(
    `INSERT INTO login_2fa_pendente (token, usuario_id, expira_em)
     VALUES ($1, $2, NOW() + INTERVAL '5 minutes')`,
    [tempToken, usuarioId]
  );
  return tempToken;
}

// Le sem destruir. Devolve { usuarioId, tentativas } ou null.
async function lerPendencia2FA(tempToken) {
  if (!tempToken) return null;
  const r = await db.query(
    "SELECT usuario_id, tentativas FROM login_2fa_pendente WHERE token = $1 AND expira_em > NOW()",
    [tempToken]
  );
  if (!r.rows[0]) return null;
  return { usuarioId: r.rows[0].usuario_id, tentativas: r.rows[0].tentativas };
}

// Conta um codigo errado. Devolve quantas tentativas ainda restam.
// Zero significa que a pendencia foi descartada e o login recomeca.
async function registrarTentativa2FA(tempToken) {
  const r = await db.query(
    "UPDATE login_2fa_pendente SET tentativas = tentativas + 1 WHERE token = $1 RETURNING tentativas",
    [tempToken]
  );
  if (!r.rows[0]) return 0;
  const restam = MAX_TENTATIVAS_2FA - r.rows[0].tentativas;
  if (restam <= 0) {
    await db.query("DELETE FROM login_2fa_pendente WHERE token = $1", [tempToken]);
    return 0;
  }
  return restam;
}

// So e chamada depois que o codigo confere.
async function consumirPendencia2FA(tempToken) {
  if (!tempToken) return null;
  const r = await db.query(
    "DELETE FROM login_2fa_pendente WHERE token = $1 AND expira_em > NOW() RETURNING usuario_id",
    [tempToken]
  );
  return r.rows[0] ? r.rows[0].usuario_id : null;
}

// ============================================================================
// SESSOES
// ============================================================================

const DURACAO_SESSAO_H = parseInt(process.env.SESSAO_HORAS || "10", 10);
const COOKIE = "unigestao_sessao";

async function criarSessao(usuarioId, ip) {
  const token = crypto.randomBytes(32).toString("hex");
  await db.query(
    "INSERT INTO sessoes (token, usuario_id, expira_em, ip) VALUES ($1,$2,NOW() + ($3 || ' hours')::interval,$4)",
    [token, usuarioId, String(DURACAO_SESSAO_H), ip || null]
  );
  return token;
}

async function lerSessao(token) {
  if (!token) return null;
  const r = await db.query(
    `SELECT u.id, u.nome, u.email, u.ativo, u.super_admin, u.senha_temp, u.totp_ativo,
            u.mural_visto_em, u.mural_autor, u.checklists_ver
       FROM sessoes s JOIN usuarios u ON u.id = s.usuario_id
      WHERE s.token = $1 AND s.expira_em > NOW() AND u.ativo = TRUE`,
    [token]
  );
  return r.rows[0] || null;
}

async function encerrarSessao(token) {
  if (token) await db.query("DELETE FROM sessoes WHERE token = $1", [token]);
}

async function encerrarSessoesDoUsuario(usuarioId) {
  await db.query("DELETE FROM sessoes WHERE usuario_id = $1", [usuarioId]);
}

function definirCookie(res, token) {
  const partes = [
    `${COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${DURACAO_SESSAO_H * 3600}`,
  ];
  if (process.env.NODE_ENV === "production") partes.push("Secure");
  res.setHeader("Set-Cookie", partes.join("; "));
}

function limparCookie(res) {
  res.setHeader("Set-Cookie", `${COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`);
}

function lerToken(req) {
  const h = req.headers["x-unigestao-token"];
  if (h) return String(h);
  const cookie = req.headers.cookie || "";
  const m = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

// Limpeza periodica das sessoes vencidas
setInterval(() => {
  db.query("DELETE FROM sessoes WHERE expira_em < NOW()").catch(() => {});
}, 60 * 60 * 1000).unref();

// ============================================================================
// BLOQUEIO DE FORCA BRUTA — por CONTA, com o IP so como teto
// ============================================================================
//
// A versao anterior contava por IP e tinha DOIS defeitos, os dois vistos em
// producao no dia 26/08/2026:
//
// 1. UM CONTADOR PARA O ESCRITORIO INTEIRO. As 44 pessoas saem pelo mesmo
//    endereco publico, entao quem errava a senha gastava as tentativas de
//    todo mundo. Tres pessoas ficaram sem entrar por causa dos erros de duas.
//
// 2. O BLOQUEIO OLHAVA O CONTADOR VELHO. Quando a janela de 15 minutos vencia,
//    `count` voltava para 1 — mas a decisao de bloquear era tomada com o valor
//    ANTERIOR. Um contador parado em 9 fazia a PRIMEIRA tentativa errada depois
//    do intervalo bloquear na hora. Foi assim que a Lais levou bloqueio com uma
//    unica senha errada, com o contador marcando 1.
//
// Agora a chave e 'conta:<e-mail>' ou 'ip:<endereco>', e cada uma tem o seu
// limite. Errar a propria senha trava a propria conta por 15 minutos; o teto
// por IP existe contra script, e e alto o bastante para um escritorio inteiro
// nunca esbarrar nele sem querer.
//
// O limite por conta abre a porta para alguem travar a conta de um colega de
// proposito, errando a senha dele. E o preco conhecido dessa escolha — e por
// isso o bloqueio e curto e nao exige ninguem para desfazer. A alternativa
// (contar so por IP) ja se provou pior: derruba o escritorio inteiro.

const MAX_POR_CONTA = 8;
const MAX_POR_IP = 60;
const JANELA_MIN = 15;

const chaveConta = (email) => "conta:" + String(email || "").toLowerCase().trim();
const chaveIp = (ip) => "ip:" + String(ip || "");

// Devolve { ate, motivo } se houver bloqueio valendo, ou null.
async function bloqueado(ip, email) {
  const chaves = [chaveIp(ip)];
  if (email) chaves.push(chaveConta(email));
  const r = await db.query(
    `SELECT chave, blocked_until FROM login_tentativas
      WHERE chave = ANY($1) AND blocked_until > NOW()
      ORDER BY blocked_until DESC LIMIT 1`,
    [chaves]
  );
  if (!r.rows[0]) return null;
  return {
    ate: r.rows[0].blocked_until,
    motivo: r.rows[0].chave.startsWith("conta:") ? "conta" : "ip",
  };
}

// Compat: quem so tem o IP em mao (a recuperacao de senha, por exemplo).
async function ipBloqueado(ip) {
  const b = await bloqueado(ip, null);
  return b ? b.ate : null;
}

// A MESMA expressao decide o contador novo e o bloqueio.
//
// Era exatamente aqui que estava o defeito 2: o count era recalculado e o
// bloqueio olhava `count + 1` do valor guardado. Repetir a expressao inteira
// dentro do CASE nao e bonito, mas garante que os dois falam do mesmo numero.
//
// `blocked_until` tambem deixou de ser zerado quando a condicao e falsa: antes,
// a tentativa seguinte apagava um bloqueio que estava valendo.
async function marcar(chave, limite) {
  const novoCount =
    `CASE WHEN login_tentativas.first_at < NOW() - INTERVAL '${JANELA_MIN} minutes'
          THEN 1 ELSE login_tentativas.count + 1 END`;
  await db.query(
    `INSERT INTO login_tentativas (chave, count, first_at) VALUES ($1, 1, NOW())
     ON CONFLICT (chave) DO UPDATE SET
       count = ${novoCount},
       first_at = CASE WHEN login_tentativas.first_at < NOW() - INTERVAL '${JANELA_MIN} minutes'
                       THEN NOW() ELSE login_tentativas.first_at END,
       blocked_until = CASE WHEN (${novoCount}) >= ${limite}
                            THEN NOW() + INTERVAL '${JANELA_MIN} minutes'
                            ELSE login_tentativas.blocked_until END`,
    [chave]
  );
}

async function registrarFalha(ip, email) {
  if (email) await marcar(chaveConta(email), MAX_POR_CONTA);
  await marcar(chaveIp(ip), MAX_POR_IP);
}

// Entrou: o contador da CONTA zera. O do IP nao — senao bastaria uma entrada
// bem-sucedida qualquer para limpar o teto que protege contra script.
async function limparFalhas(ip, email) {
  if (!email) return;
  await db.query("DELETE FROM login_tentativas WHERE chave = $1", [chaveConta(email)]);
}

// ============================================================================
// AUDITORIA — nunca e apagada
// ============================================================================

async function auditar(req, acao, dados = {}) {
  try {
    await db.query(
      "INSERT INTO auditoria (usuario_id, email, acao, alvo, detalhe, ip) VALUES ($1,$2,$3,$4,$5,$6)",
      [
        dados.usuarioId || (req.usuario && req.usuario.id) || null,
        dados.email || (req.usuario && req.usuario.email) || null,
        acao,
        dados.alvo || null,
        JSON.stringify(dados.detalhe || {}),
        ipDe(req),
      ]
    );
  } catch (e) {
    console.error("[auditoria] falhou:", e.message);
  }
}

// Em quem o Express pode acreditar ao ler o X-Forwarded-For (usado la no
// server.js, e conferido no teste). Faixa de endereco, nao contagem de saltos:
// contagem confia em quem quer que esteja do outro lado da conexao; faixa so
// aceita o cabecalho quando o vizinho e a rede privada da Railway — onde
// unicamente a Fachada alcanca o Core — ou a propria maquina, em
// desenvolvimento e nos testes.
const PROXY_CONFIAVEL = ["loopback", "linklocal", "uniquelocal"];

// De onde sai o endereco de rede que conta tentativa e assina a auditoria.
//
// Este trecho JA FOI o defeito. Ele lia o X-Forwarded-For e pegava o PRIMEIRO
// valor — que e justamente o pedaco que o cliente escreve. Bastava mandar um
// endereco diferente a cada tentativa para o teto por local (MAX_POR_IP) nunca
// fechar, e para a auditoria guardar um endereco inventado.
//
// Agora quem decide e o Express, com o `trust proxy` configurado em server.js:
// ele so aceita o X-Forwarded-For quando o vizinho da conexao e confiavel (a
// rede privada da Railway, onde so a Fachada alcanca o Core) e, mesmo assim, so
// o valor da DIREITA — o que o proxy acrescentou, e nao o que o cliente enviou.
// Fora dai, sobra o endereco real da conexao.
//
// A Fachada, que e a porta publica, ainda reescreve o cabecalho antes de
// repassar: o que o cliente escreveu nunca chega aqui.
function ipDe(req) {
  if (req.ip) return req.ip;
  return req.socket ? req.socket.remoteAddress : null;
}

module.exports = {
  gerarHash, verificarSenha,
  gerarSegredoTOTP, verificarTOTP, urlQRCode,
  criarPendencia2FA, lerPendencia2FA, registrarTentativa2FA, consumirPendencia2FA,
  MAX_TENTATIVAS_2FA,
  criarSessao, lerSessao, encerrarSessao, encerrarSessoesDoUsuario,
  definirCookie, limparCookie, lerToken, COOKIE,
  bloqueado, ipBloqueado, registrarFalha, limparFalhas,
  MAX_POR_CONTA, MAX_POR_IP, JANELA_MIN,
  auditar, ipDe, PROXY_CONFIAVEL,
};
