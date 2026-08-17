-- ============================================================
-- UniGestao — Core de identidade e acesso
-- Este banco guarda SOMENTE pessoas, acessos e sessoes.
-- Nenhum dado de negocio mora aqui: cada modulo mantem o seu.
-- ============================================================

CREATE TABLE IF NOT EXISTS usuarios (
  id           TEXT PRIMARY KEY,
  nome         TEXT        NOT NULL,
  email        TEXT        NOT NULL UNIQUE,
  senha        TEXT        NOT NULL,   -- formato: algoritmo:parametros:sal:hash
  senha_temp   BOOLEAN     NOT NULL DEFAULT FALSE,  -- obriga troca no proximo login
  totp_secret  TEXT,
  totp_ativo   BOOLEAN     NOT NULL DEFAULT FALSE,
  ativo        BOOLEAN     NOT NULL DEFAULT TRUE,
  super_admin  BOOLEAN     NOT NULL DEFAULT FALSE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ultimo_login TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_usuarios_email ON usuarios (LOWER(email));
CREATE INDEX IF NOT EXISTS idx_usuarios_ativo ON usuarios (ativo);

-- O CORACAO DO SISTEMA: quem acessa qual modulo, e com que papel la dentro.
-- O Core guarda o rotulo do papel mas NAO sabe o que ele significa —
-- quem interpreta continua sendo cada modulo, como ja e hoje.
CREATE TABLE IF NOT EXISTS usuario_modulos (
  usuario_id  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  modulo      TEXT NOT NULL,
  papel       TEXT NOT NULL,
  concedido_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (usuario_id, modulo)
);
CREATE INDEX IF NOT EXISTS idx_usuario_modulos_modulo ON usuario_modulos (modulo);

CREATE TABLE IF NOT EXISTS sessoes (
  token       TEXT PRIMARY KEY,
  usuario_id  TEXT        NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criada_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em   TIMESTAMPTZ NOT NULL,
  ip          TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessoes_usuario ON sessoes (usuario_id);
CREATE INDEX IF NOT EXISTS idx_sessoes_expira  ON sessoes (expira_em);

-- Etapa intermediaria do login: a senha ja conferiu, falta o codigo do 2FA.
-- Fica no banco (e nao em memoria) por dois motivos:
--   1. sobrevive a reinicios e a deploys do Core
--   2. funciona com mais de uma instancia do servico rodando ao mesmo tempo
-- `tentativas` permite errar o codigo algumas vezes sem ter que refazer o login.
CREATE TABLE IF NOT EXISTS login_2fa_pendente (
  token       TEXT PRIMARY KEY,
  usuario_id  TEXT        NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criada_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em   TIMESTAMPTZ NOT NULL,
  tentativas  INT         NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_2fa_pendente_expira ON login_2fa_pendente (expira_em);

-- Bloqueio de forca bruta, persistido para sobreviver a reinicios do servico
CREATE TABLE IF NOT EXISTS login_attempts (
  ip             TEXT PRIMARY KEY,
  count          INT         NOT NULL DEFAULT 0,
  first_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until  TIMESTAMPTZ
);

-- Auditoria: nunca e apagada.
CREATE TABLE IF NOT EXISTS auditoria (
  id         BIGSERIAL PRIMARY KEY,
  at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  usuario_id TEXT,
  email      TEXT,
  acao       TEXT NOT NULL,
  alvo       TEXT,
  detalhe    JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_auditoria_at      ON auditoria (at DESC);
CREATE INDEX IF NOT EXISTS idx_auditoria_usuario ON auditoria (usuario_id);
