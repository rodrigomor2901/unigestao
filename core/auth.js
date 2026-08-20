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
            u.mural_visto_em
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
// BLOQUEIO DE FORCA BRUTA — 10 tentativas por IP a cada 15 minutos
// ============================================================================

const MAX_TENTATIVAS = 10;
const JANELA_MIN = 15;

async function ipBloqueado(ip) {
  const r = await db.query(
    "SELECT blocked_until FROM login_attempts WHERE ip = $1 AND blocked_until > NOW()",
    [ip]
  );
  return r.rows[0] ? r.rows[0].blocked_until : null;
}

async function registrarFalha(ip) {
  await db.query(
    `INSERT INTO login_attempts (ip, count, first_at) VALUES ($1, 1, NOW())
     ON CONFLICT (ip) DO UPDATE SET
       count = CASE WHEN login_attempts.first_at < NOW() - INTERVAL '${JANELA_MIN} minutes'
                    THEN 1 ELSE login_attempts.count + 1 END,
       first_at = CASE WHEN login_attempts.first_at < NOW() - INTERVAL '${JANELA_MIN} minutes'
                       THEN NOW() ELSE login_attempts.first_at END,
       blocked_until = CASE WHEN login_attempts.count + 1 >= ${MAX_TENTATIVAS}
                            THEN NOW() + INTERVAL '${JANELA_MIN} minutes' ELSE NULL END`,
    [ip]
  );
}

async function limparFalhas(ip) {
  await db.query("DELETE FROM login_attempts WHERE ip = $1", [ip]);
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

function ipDe(req) {
  const f = req.headers["x-forwarded-for"];
  if (f) return String(f).split(",")[0].trim();
  return req.socket ? req.socket.remoteAddress : null;
}

module.exports = {
  gerarHash, verificarSenha,
  gerarSegredoTOTP, verificarTOTP, urlQRCode,
  criarPendencia2FA, lerPendencia2FA, registrarTentativa2FA, consumirPendencia2FA,
  MAX_TENTATIVAS_2FA,
  criarSessao, lerSessao, encerrarSessao, encerrarSessoesDoUsuario,
  definirCookie, limparCookie, lerToken, COOKIE,
  ipBloqueado, registrarFalha, limparFalhas,
  auditar, ipDe,
};
