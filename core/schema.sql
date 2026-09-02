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

-- ------------------------------------------------------------
-- MURAL — publicacoes, imagem, curtidas, comentarios, leitura
-- ------------------------------------------------------------
-- Quem publica: administrador geral e quem for marcado como autor.
--
-- `mural_autor` e um marcador por pessoa, e nao um papel novo. A ideia era
-- "diretoria, gestao e marketing", mas isso e CARGO, e cargo aqui e texto
-- livre digitado por cada um na agenda — amarrar permissao a texto livre daria
-- acesso a quem escrevesse "Gestao de Contratos" e negaria a quem escrevesse
-- "Diretor". Marcar a pessoa e explicito e nao depende de como ela se descreve.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS mural_autor BOOLEAN NOT NULL DEFAULT FALSE;

-- Publicacao: o aviso agora tem imagem, pop-up e nao expira mais sozinho.
-- Vira historico permanente, consultavel no modulo Mural.
ALTER TABLE avisos ADD COLUMN IF NOT EXISTS popup_ate   TIMESTAMPTZ;
ALTER TABLE avisos ADD COLUMN IF NOT EXISTS editado_em  TIMESTAMPTZ;
ALTER TABLE avisos ADD COLUMN IF NOT EXISTS arquivado   BOOLEAN NOT NULL DEFAULT FALSE;

-- A imagem fica em tabela propria pelo mesmo motivo da foto de perfil: a
-- listagem do mural le titulo e texto o tempo todo e nao pode arrastar
-- centenas de kilobytes junto a cada carregamento.
CREATE TABLE IF NOT EXISTS aviso_imagem (
  aviso_id   BIGINT PRIMARY KEY REFERENCES avisos(id) ON DELETE CASCADE,
  tipo       TEXT        NOT NULL,
  bytes      BYTEA       NOT NULL,
  enviada_em TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Leitura por pessoa. Serve para duas coisas ao mesmo tempo: o "lido" que a
-- pessoa marca, e o controle de quem ja viu o pop-up — se fossem duas tabelas,
-- as duas responderiam a mesma pergunta e sairiam do ar juntas.
CREATE TABLE IF NOT EXISTS aviso_leitura (
  aviso_id   BIGINT NOT NULL REFERENCES avisos(id) ON DELETE CASCADE,
  usuario_id TEXT   NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  lido_em    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  popup_em   TIMESTAMPTZ,
  PRIMARY KEY (aviso_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS aviso_curtida (
  aviso_id   BIGINT NOT NULL REFERENCES avisos(id) ON DELETE CASCADE,
  usuario_id TEXT   NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (aviso_id, usuario_id)
);

CREATE TABLE IF NOT EXISTS aviso_comentario (
  id         BIGSERIAL PRIMARY KEY,
  aviso_id   BIGINT NOT NULL REFERENCES avisos(id) ON DELETE CASCADE,
  usuario_id TEXT   REFERENCES usuarios(id) ON DELETE SET NULL,
  texto      TEXT   NOT NULL,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_comentario_aviso ON aviso_comentario (aviso_id, criado_em);

-- Historico de edicao: guarda o texto ANTES da alteracao, com autor e hora.
-- Publicacao que muda sem deixar rastro gera discussao sobre o que estava
-- escrito — e num comunicado de empresa essa discussao custa caro.
CREATE TABLE IF NOT EXISTS aviso_edicao (
  id           BIGSERIAL PRIMARY KEY,
  aviso_id     BIGINT NOT NULL REFERENCES avisos(id) ON DELETE CASCADE,
  editor_id    TEXT   REFERENCES usuarios(id) ON DELETE SET NULL,
  editado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  titulo_antes TEXT   NOT NULL,
  texto_antes  TEXT   NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_edicao_aviso ON aviso_edicao (aviso_id, editado_em DESC);

-- ------------------------------------------------------------
-- AGENDA — mais de um departamento por pessoa
-- ------------------------------------------------------------
-- Uma pessoa pode responder por mais de uma area: gerente comercial que
-- tambem responde por TI e por eventos, por exemplo. O campo unico obrigava
-- a escolher um e sumia com os outros na busca da agenda.
--
-- `departamento` (singular) para de ser escrito. Ele nao e apagado aqui porque
-- a carga abaixo roda no arranque do Core novo enquanto o antigo ainda atende:
-- derrubar a coluna no meio dessa troca daria erro nas telas por alguns
-- segundos. Entao ele fica, e some sozinho — quem salvar o proprio cadastro
-- limpa o seu (ver POST /api/perfil). Enquanto sobra em alguem, e dali que o
-- nome sai; ver departamentosDe() em core/perfil.js, o unico lugar que decide
-- isso. Dois campos dizendo a mesma coisa so nao discordam quando so um manda.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS departamentos TEXT[] NOT NULL DEFAULT '{}';

UPDATE usuarios
   SET departamentos = ARRAY[departamento]
 WHERE departamento IS NOT NULL AND departamento <> ''
   AND departamentos = '{}';

CREATE INDEX IF NOT EXISTS idx_usuarios_departamentos ON usuarios USING GIN (departamentos);

-- ------------------------------------------------------------
-- RECUPERACAO DE SENHA
-- ------------------------------------------------------------
-- Quem esquece a senha hoje fica sem acesso ate achar um administrador. Isto
-- da o caminho de volta pelo proprio e-mail da pessoa.
--
-- Guarda o HASH do token, nunca o token. O token cru existe em dois lugares e
-- so por uma hora: no link do e-mail e na mao de quem o recebeu. Assim, um
-- vazamento desta tabela nao permite redefinir a senha de ninguem.
--
-- `usado_em` e o que faz o link valer UMA vez. Sem isso, o link fica no
-- historico do navegador e na caixa de entrada, e qualquer um que alcance
-- aquele e-mail depois entra na conta quando quiser.
CREATE TABLE IF NOT EXISTS senha_reset (
  token_hash TEXT        PRIMARY KEY,
  usuario_id TEXT        NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criado_em  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expira_em  TIMESTAMPTZ NOT NULL,
  usado_em   TIMESTAMPTZ,
  ip         TEXT
);
CREATE INDEX IF NOT EXISTS idx_senha_reset_usuario ON senha_reset (usuario_id, criado_em DESC);
CREATE INDEX IF NOT EXISTS idx_senha_reset_expira  ON senha_reset (expira_em);

-- ------------------------------------------------------------
-- BLOQUEIO DE FORCA BRUTA — por CONTA, nao so por IP
-- ------------------------------------------------------------
-- A tabela `login_attempts` acima contava por IP. Num escritorio isso e um
-- contador so para todo mundo: as 44 pessoas saem pelo mesmo endereco publico,
-- e quem errasse a senha derrubava o acesso dos colegas junto. Foi o que
-- aconteceu em 26/08/2026 — tres pessoas bloqueadas ao mesmo tempo por causa
-- de erros de senha de duas delas.
--
-- Agora a chave e generica: 'conta:<e-mail>' ou 'ip:<endereco>'. Quem errar a
-- propria senha trava a PROPRIA conta por alguns minutos; o IP continua tendo
-- um teto, mas alto o bastante para um escritorio inteiro nunca esbarrar nele
-- por acidente — ele existe contra script, nao contra gente com dedo pesado.
--
-- `login_attempts` fica sem uso, e nao e derrubada aqui: a carga roda no
-- arranque do Core novo enquanto o antigo ainda atende e ainda escreve nela.
CREATE TABLE IF NOT EXISTS login_tentativas (
  chave         TEXT        PRIMARY KEY,
  count         INT         NOT NULL DEFAULT 0,
  first_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  blocked_until TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS idx_login_tentativas_bloqueio ON login_tentativas (blocked_until);

-- ------------------------------------------------------------
-- CHECKLISTS DA OPERACAO (Nexti Control)
-- ------------------------------------------------------------
-- Copia local das visitas que o Nexti ja concluiu. Nao e o sistema de origem:
-- se esta tabela sumir, uma sincronizacao reconstroi tudo.
--
-- Ela existe por dois motivos praticos:
--   1. a consulta ao Nexti e por DIA (uma chamada por dia). Montar um mes na
--      hora seriam 30 chamadas por pessoa que abrisse a tela.
--   2. a tela precisa cruzar periodos e agrupar por supervisor e por cliente,
--      o que a API nao faz — quem faz e o SQL, aqui.
--
-- `id` e o id da tarefa no Nexti, e nao um id nosso: e o que faz a
-- sincronizacao poder rodar de novo no mesmo dia sem duplicar nada.
--
-- Os nomes (supervisor, posto, cliente) ficam gravados junto, e nao so os ids.
-- Nao e desnormalizacao por preguica: o Nexti pode renomear um posto, e o
-- historico tem que continuar contando o que estava escrito na epoca. Alem
-- disso evita depender de outra chamada so para exibir a lista.
CREATE TABLE IF NOT EXISTS nexti_visita (
  id              BIGINT      PRIMARY KEY,
  dia             DATE        NOT NULL,
  posto_id        BIGINT,
  posto_nome      TEXT,
  cliente_nome    TEXT,
  supervisor_id   BIGINT,
  supervisor_nome TEXT,
  checklist_nome  TEXT,
  inicio_em       TIMESTAMPTZ,
  fim_em          TIMESTAMPTZ,
  minutos         INT,
  atualizado_em   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_nexti_visita_dia   ON nexti_visita (dia DESC);
CREATE INDEX IF NOT EXISTS idx_nexti_visita_sup   ON nexti_visita (supervisor_id, dia DESC);
CREATE INDEX IF NOT EXISTS idx_nexti_visita_posto ON nexti_visita (posto_id, dia DESC);

-- Quando cada dia foi sincronizado pela ultima vez.
--
-- E o que permite a tela dizer "atualizado as 10:42" e, principalmente, dizer
-- quando NAO conseguiu atualizar. Dado velho com aviso e util; dado velho
-- calado e pior do que nao ter painel, porque a pessoa decide achando que esta
-- vendo o agora.
CREATE TABLE IF NOT EXISTS nexti_sync (
  dia             DATE        PRIMARY KEY,
  sincronizado_em TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  quantas         INT         NOT NULL DEFAULT 0,
  erro            TEXT
);

-- Quem enxerga o painel. Mesmo padrao de `mural_autor`: marcador por pessoa,
-- concedido no Admin Geral. Administrador geral ve sempre.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS checklists_ver BOOLEAN NOT NULL DEFAULT FALSE;

-- ------------------------------------------------------------
-- ORDEM DOS CARTOES NA TELA INICIAL
-- ------------------------------------------------------------
-- Cada pessoa arrasta os cartoes e poe na frente o que usa todo dia. Guardado
-- no cadastro, e nao no navegador: quem entra do computador e do celular
-- espera a mesma ordem nos dois, e limpar o cache nao pode desfazer o arranjo.
--
-- Guarda CHAVES, nao posicoes: ["crm", "eventos", "portal:mural", ...]. Assim
-- a lista e so uma PREFERENCIA, nunca um filtro — modulo que a pessoa ganhar
-- depois nao esta aqui e mesmo assim aparece, no fim. Ordem por posicao faria
-- o cartao novo empurrar todos os outros ou, pior, sumir.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS modulos_ordem TEXT[] NOT NULL DEFAULT '{}';

-- Departamento principal — onde a pessoa esta lotada, escolhido pelo administrador
-- quando cria o acesso. E diferente de `departamentos`, que e a lista de areas
-- pelas quais ela RESPONDE (a agenda usa aquela; um gerente pode responder por
-- tres). Este aqui e um so, e e o que vira equipe na Gestao de Tarefas.
ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS departamento_principal TEXT;
