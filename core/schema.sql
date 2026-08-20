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

-- ------------------------------------------------------------
-- AGENDA CORPORATIVA
-- ------------------------------------------------------------
-- Dados de contato da pessoa, para todo mundo do grupo poder achar quem
-- precisa falar. Ficam aqui, e nao num modulo, porque o Core e quem sabe quem
-- e cada pessoa — e assim a agenda serve aos seis sistemas de uma vez.
--
-- `cargo` e o cargo da pessoa na empresa. NAO confundir com `papel` em
-- usuario_modulos, que e o nivel de acesso dela dentro de um sistema: a mesma
-- pessoa pode ser "Coordenadora" de cargo e ter papel "executor" no Tarefas.
--
-- Telefone e ramal separados porque sao coisas diferentes e quem tem os dois
-- vai querer informar os dois. Nenhum dos dois e obrigatorio sozinho — o que
-- se exige e ter pelo menos uma forma de contato (ver core/perfil.js).
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS telefone     TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS ramal        TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS departamento TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS cargo        TEXT;
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS perfil_em    TIMESTAMPTZ;

-- Busca por nome/departamento/cargo sem depender de maiuscula e acento
CREATE INDEX IF NOT EXISTS idx_usuarios_departamento ON usuarios (LOWER(departamento));

-- A foto fica em tabela separada, nao em coluna de `usuarios`.
--
-- Motivo pratico: `usuarios` e lida o tempo todo — em toda requisicao de
-- modulo, na leitura de sessao, na listagem do Admin Geral. Uma coluna de
-- dezenas de kilobytes seria arrastada junto em consultas que nunca precisam
-- dela. Em tabela propria, a foto so e lida quando alguem realmente a pede.
CREATE TABLE IF NOT EXISTS usuario_foto (
  usuario_id  TEXT PRIMARY KEY REFERENCES usuarios(id) ON DELETE CASCADE,
  tipo        TEXT        NOT NULL,   -- image/jpeg ou image/png
  bytes       BYTEA       NOT NULL,
  enviada_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

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

-- ------------------------------------------------------------
-- MURAL — avisos da empresa na tela inicial
-- ------------------------------------------------------------
-- Aviso de empresa por e-mail some na caixa de entrada e ainda gasta a cota
-- diaria do SendGrid, que ja e apertada. O mural e o contrario: quem entra no
-- portal ve, quem nao entra nao e incomodado. Por isso ele NAO manda e-mail.
--
-- `fim_em` e o que impede o mural de virar paisagem. Aviso sem prazo fica na
-- tela para sempre, as pessoas param de ler, e o mural morre. Todo aviso nasce
-- com prazo; quem quiser um permanente marca `fixado`, que e uma decisao
-- consciente e nao o padrao.
CREATE TABLE IF NOT EXISTS avisos (
  id         BIGSERIAL   PRIMARY KEY,
  titulo     TEXT        NOT NULL,
  texto      TEXT        NOT NULL DEFAULT '',
  -- aviso | mudanca | evento — muda so a cor e o rotulo na tela
  tipo       TEXT        NOT NULL DEFAULT 'aviso',
  inicio_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  fim_em     TIMESTAMPTZ,
  fixado     BOOLEAN     NOT NULL DEFAULT FALSE,
  autor_id   TEXT        REFERENCES usuarios(id) ON DELETE SET NULL,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_avisos_janela ON avisos (inicio_em, fim_em);

-- Quando a pessoa olhou o mural pela ultima vez — e o que decide o ponto de
-- "novo". Sem isso, ou nada e destacado, ou tudo fica destacado para sempre.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS mural_visto_em TIMESTAMPTZ;
