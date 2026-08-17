# UniGestão — Desenho Técnico

Acesso único para todos os sistemas do Grupo Uniseter, com um Admin Geral separado que
controla quais módulos cada colaborador enxerga.

Data: 16/08/2026 · Status: **proposta para aprovação** (nenhum código escrito ainda)
Versão 2 — substitui a versão anterior, que propunha fundir os códigos.

---

## 1. O que muda e o que não muda

**O que muda:** um endereço só, um login só, uma senha só. Um Admin Geral onde você cria
a pessoa uma vez e marca quais módulos ela acessa. Um menu lateral que mostra só os
módulos liberados para quem está logado.

**O que NÃO muda:** cada sistema continua sendo o sistema que é hoje. Mesmo código, mesmo
banco, mesmas regras, mesmas telas, mesmos papéis internos. Nenhuma regra de negócio é
reescrita. Os sistemas não precisam se conversar e continuam não se conversando.

Não é um portal com links. A pessoa entra em `unigestao.uniseter.com`, faz login uma vez,
e navega entre os módulos sem sair do endereço e sem digitar senha de novo. Por fora é um
sistema só. Por dentro, cada módulo continua independente.

---

## 2. Os sistemas (levantamento de 16/08/2026)

| # | Módulo | Local | Backend | Papéis internos que ele já usa |
|---|---|---|---|---|
| 1 | **Movimentação Operacional** | `Documents\Sistema de Lançamento de Extra` | `server.js` 1.882 linhas + `db/` | `admin`, `supervisor`, `cco`, `comercial` |
| 2 | **Gestão de Eventos** | `Desktop\Gestão Eventos` | `server.js` 379 linhas | `admin`, `gestao`, `proposta` |
| 3 | **Gestão de Tarefas** | `Desktop\Gestao Tarefas` | `server.js` 4.623 linhas | `admin`, `supervisor`, `coordenador`, `gerente`, `diretoria`, `executor`, `visualizador`, `recepcao`, `recepcao_tao`, `solicitante` |
| 4 | **Controle de Documentos** | `Desktop\Controle de Documentos` | `server.js` 2.212 linhas | `admin`, `consulta` (+ campo `area`) |
| 5 | **CRM Comercial** | `Z:\APP COMERCIAL\...\sistema-gestao-comercial-uniseter` | `server.js` 9.525 linhas | tabelas `roles` + `user_roles` |
| 6 | **Precificação** | `Desktop\pricing-saas` | monorepo TypeScript | — |

Todos rodam Node.js + PostgreSQL, cada um com seu banco.

**Vantagem desta arquitetura:** a Precificação, que é a única em TypeScript, **deixa de ser
um problema**. Como nenhum código é fundido, ela entra igual aos outros — basta ela aceitar
o login central. A decisão de reescrevê-la ou não fica para quando você quiser, e não
bloqueia nada.

---

## 3. Arquitetura

Três peças:

```
                    unigestao.uniseter.com
                              │
                    ┌─────────▼─────────┐
                    │      FACHADA      │  um domínio só
                    │  (reverse proxy)  │  roteia por caminho
                    └─────────┬─────────┘
                              │
        ┌──────────┬──────────┼──────────┬──────────┬──────────┐
        │          │          │          │          │          │
   ┌────▼────┐  ┌──▼───┐  ┌───▼───┐  ┌───▼────┐  ┌──▼──┐  ┌───▼────┐
   │  CORE   │  │/opera│  │/event.│  │/tarefas│  │/crm │  │/precif.│
   │ login + │  │cional│  │       │  │        │  │     │  │        │
   │  Admin  │  └──┬───┘  └───┬───┘  └───┬────┘  └──┬──┘  └───┬────┘
   │  Geral  │     │          │          │          │         │
   └────┬────┘     └──────────┴──────────┴──────────┴─────────┘
        │                          │
        └──────── "esse token é válido? que papel ele tem aqui?" ────┘

   Bancos:  core_db   oper_db   eventos_db   tarefas_db   crm_db   pricing_db
            (separados, cada módulo com o seu — como já é hoje)
```

### Peça 1 — Core (novo, pequeno)

O único sistema novo a ser construído. É enxuto: login, sessão e Admin Geral. Não tem
regra de negócio nenhuma.

```
core/
├── server.js
├── db/schema.sql
└── public/
    ├── login.html        # a única tela de login que existe
    ├── shell.js          # menu lateral, montado com os módulos liberados
    └── admin.html        # Admin Geral: pessoas × módulos × papel
```

Estimativa: entre 800 e 1.200 linhas no total. Bem menor que qualquer um dos módulos.

### Peça 2 — Fachada (reverse proxy)

Um serviço mínimo que faz o domínio único funcionar:

| Caminho | Vai para |
|---|---|
| `/` e `/admin` | Core |
| `/operacional/*` | app do Lançamento de Extra |
| `/eventos/*` | app de Gestão de Eventos |
| `/tarefas/*` | app de Gestão de Tarefas |
| `/documentos/*` | app de Controle de Documentos |
| `/crm/*` | app do CRM |
| `/precificacao/*` | app do pricing-saas |

Como tudo está sob o mesmo domínio, o **cookie de sessão é enxergado por todos os
módulos automaticamente**. É isso que faz o login único funcionar sem gambiarra: a pessoa
autentica no Core, recebe o cookie, e qualquer módulo que ela abrir já vê esse cookie.

### Peça 3 — Os módulos (os sistemas atuais)

Continuam como estão. A cirurgia em cada um é pequena e sempre a mesma:

1. **Apagar a tela de login própria.** Se não houver cookie válido, redireciona para `/`.
2. **Trocar a função que identifica o usuário logado.** Onde hoje ele consulta a própria
   tabela `usuarios`, passa a perguntar ao Core:
   ```
   GET core/api/sessao?token=...&modulo=eventos
   → { id, nome, email, papel: "gestao" }   ou   403 se não tiver acesso
   ```
3. **Mapear o papel recebido** para a variável que ele já usa internamente. Uma linha.
4. **Remover a tela de gestão de usuários** — passa a ser o Admin Geral.
5. **Incluir o menu lateral do Core** (uma tag `<script>` no HTML).

**Nada além disso.** Nenhuma tabela de negócio muda, nenhuma tela muda, nenhum cálculo
muda. É por isso que o risco desta arquitetura é muito menor.

---

## 4. O Admin Geral

O centro do que você pediu. Uma tela só, com uma linha por pessoa:

```
Rodrigo Moraes · rodrigo@uniseter.com                        [ativo]

  ☑ Movimentação Operacional      papel: [ admin        ▾ ]
  ☑ Gestão de Eventos             papel: [ admin        ▾ ]
  ☑ Gestão de Tarefas             papel: [ admin        ▾ ]
  ☑ Controle de Documentos        papel: [ admin        ▾ ]
  ☑ CRM Comercial                 papel: [ admin        ▾ ]
  ☐ Precificação                  —

Elaine Cristina · elaine@uniseter.com                        [ativo]

  ☐ Movimentação Operacional      —
  ☑ Gestão de Eventos             papel: [ gestao       ▾ ]
  ☑ Gestão de Tarefas             papel: [ executor     ▾ ]
  ☑ Controle de Documentos        papel: [ admin        ▾ ]
  ☐ CRM Comercial                 —
  ☐ Precificação                  —
```

**A particularidade de cada sistema é preservada aqui.** O campo "papel" não é uma lista
genérica igual para todos — cada módulo oferece exatamente os papéis que ele já conhece.
Ao marcar Operacional, o menu mostra `admin / supervisor / cco / comercial`. Ao marcar
Tarefas, mostra os 10 níveis dele. Ao marcar Documentos, mostra `admin / consulta`.

Isso é possível porque o Core guarda um pequeno registro de cada módulo:

```js
// core/modulos.js — a única coisa que o Core sabe sobre os módulos
const MODULOS = {
  operacional: {
    nome:   'Movimentação Operacional',
    base:   '/operacional',
    papeis: ['admin', 'supervisor', 'cco', 'comercial'],
  },
  tarefas: {
    nome:   'Gestão de Tarefas',
    base:   '/tarefas',
    papeis: ['admin','supervisor','coordenador','gerente','diretoria',
             'executor','visualizador','recepcao','recepcao_tao','solicitante'],
  },
  documentos: { nome: 'Controle de Documentos', base: '/documentos', papeis: ['admin','consulta'] },
  eventos:    { nome: 'Gestão de Eventos',      base: '/eventos',    papeis: ['admin','gestao','proposta'] },
  crm:        { nome: 'CRM Comercial',          base: '/crm',        papeis: [/* do banco do CRM */] },
};
```

Ele **não sabe o que esses papéis significam** — quem interpreta continua sendo cada
módulo, como já é hoje. O Core só sabe quem entra onde e com que rótulo.

Se amanhã o Operacional criar um papel novo, adiciona-se uma palavra nessa lista e ele
aparece no Admin Geral. Nada mais precisa mudar.

---

## 5. Banco de dados do Core

Só três tabelas. Os bancos dos módulos ficam **intocados**.

```sql
CREATE TABLE usuarios (
  id           TEXT PRIMARY KEY,
  nome         TEXT NOT NULL,
  email        TEXT NOT NULL UNIQUE,
  senha        TEXT NOT NULL,              -- algoritmo:salt:hash
  totp_secret  TEXT,
  totp_ativo   BOOLEAN NOT NULL DEFAULT FALSE,
  ativo        BOOLEAN NOT NULL DEFAULT TRUE,
  super_admin  BOOLEAN NOT NULL DEFAULT FALSE,
  criado_em    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- O coração: quem acessa o quê, e com que papel lá dentro.
CREATE TABLE usuario_modulos (
  usuario_id  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  modulo      TEXT NOT NULL,
  papel       TEXT NOT NULL,
  PRIMARY KEY (usuario_id, modulo)
);

CREATE TABLE sessoes (
  token       TEXT PRIMARY KEY,
  usuario_id  TEXT NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
  criada_em   TIMESTAMPTZ NOT NULL,
  expira_em   TIMESTAMPTZ NOT NULL
);

-- Bloqueio de força bruta, persistido entre reinícios
CREATE TABLE login_attempts (
  ip             TEXT PRIMARY KEY,
  count          INT NOT NULL DEFAULT 0,
  first_at       TIMESTAMPTZ NOT NULL,
  blocked_until  TIMESTAMPTZ
);
```

Como cada módulo mantém o banco dele, **não existe colisão de tabelas** entre sistemas —
problema que a arquitetura de fusão criava e esta simplesmente não tem.

---

## 6. De onde vem o código do Core

O **Sistema de Lançamento de Extra** já tem, pronta e em produção, a melhor autenticação
dos seis:

- senha com PBKDF2, 120.000 iterações
- **2FA por TOTP** (RFC 6238, implementado sem biblioteca externa)
- bloqueio de IP após 10 tentativas em 15 minutos, persistido no banco
- cookie HttpOnly
- log de auditoria que nunca é apagado

O Core não se escreve do zero: extrai-se essa parte, tira-se o que é específico de
chamados, e acrescenta-se a tabela `usuario_modulos` e a tela do Admin Geral. Todos os
módulos passam a herdar 2FA e bloqueio de força bruta — inclusive os que hoje não têm.

---

## 7. Senhas: unificar sem obrigar todo mundo a trocar

A **Gestão de Tarefas tem cerca de 1.230 contas**. Forçar 1.230 redefinições de senha na
virada seria um problema operacional sério.

Algoritmos em uso hoje:

| Sistema | Algoritmo | Situação |
|---|---|---|
| Operacional | PBKDF2 120k · SHA-256 · 32 bytes | ✅ forte |
| Documentos | PBKDF2 120k · SHA-256 · 32 bytes | ✅ idêntico ao Operacional |
| CRM | PBKDF2 120k · SHA-512 · 64 bytes | ✅ forte, parâmetros diferentes |
| Tarefas | bcrypt custo 10 | ✅ forte, algoritmo diferente |
| Eventos | **SHA-256 puro, sem sal** | ❌ inseguro |

**Solução:** o campo de senha guarda o algoritmo junto (`pbkdf2-sha256:...`,
`pbkdf2-sha512:...`, `bcrypt:...`). O login do Core sabe verificar todos os formatos e,
**no primeiro acesso bem-sucedido, regrava a senha no formato novo**.

Resultado: Operacional, Documentos, CRM e Tarefas migram sem ninguém trocar de senha. Só
os usuários de Eventos redefinem uma vez — as senhas de lá estão em SHA-256 sem sal, que
é fraco demais para importar, e são poucas pessoas.

---

## 8. Plano de execução

Cada fase entrega algo funcionando. Nenhum sistema sai do ar.

### Fase 0 — Core + Fachada
Construir o Core (login, sessões, Admin Geral) extraindo a autenticação do Lançamento de
Extra. Subir a Fachada com o domínio único. Importar e deduplicar as pessoas dos cinco
bancos.
**Entrega:** login único funcionando e Admin Geral operante — ainda sem módulo plugado.

### Fase 1 — Movimentação Operacional
Primeiro módulo a plugar, porque o Core saiu dele e a compatibilidade é imediata.
**Entrega:** primeiro módulo em produção via `unigestao.uniseter.com/operacional`.

### Fase 2 — Controle de Documentos
Já usa o mesmo algoritmo de senha do Core. Valida o roteiro de migração nos sistemas que
não deram origem ao Core.

### Fase 3 — Gestão de Eventos
Back-end pequeno (379 linhas). Aqui entra a redefinição de senha dos usuários de Eventos.

### Fase 4 — Gestão de Tarefas
Maior volume de pessoas (~1.230). A tela de usuários dele é rica e precisa ser
representada corretamente no Admin Geral.

### Fase 5 — CRM Comercial
Maior back-end, mas o modelo dele (`roles` + `user_roles`) é o mais próximo do alvo.

### Fase 6 — Precificação
Agora é uma fase normal: basta ele aceitar o cookie do Core. Nenhuma reescrita necessária.

**Ordem de esforço estimado:** a Fase 0 é a maior. Cada fase seguinte é uma cirurgia
pequena e repetitiva no módulo — sem tocar em regra de negócio.

---

## 9. Migração e deduplicação de pessoas

Na Fase 0, as pessoas dos cinco bancos são importadas para a tabela `usuarios` do Core,
deduplicando por e-mail: quem existe em três sistemas vira **uma** pessoa com três linhas
em `usuario_modulos`, cada uma com o papel que ela já tinha naquele sistema.

**Este é o ponto que exige mais atenção.** É provável que a mesma pessoa esteja cadastrada
com e-mails ligeiramente diferentes entre sistemas. Antes de concluir a Fase 0 será gerada
uma lista de conflitos para conferência manual — automatizar isso corre o risco de fundir
duas pessoas diferentes ou duplicar a mesma.

---

## 10. Riscos e como são tratados

| Risco | Gravidade | Tratamento |
|---|---|---|
| Core fora do ar derruba o login de todos | **Alta** | O Core é pequeno e estável (só auth). Sessão validada com cache curto: uma queda breve não expulsa quem já está logado. |
| Deduplicação de pessoas com e-mails divergentes | **Média** | Lista de conflitos revisada manualmente na Fase 0. |
| Visual diferente entre módulos | **Média** | Cada sistema tem seu CSS. O menu lateral comum dá unidade; uniformizar o resto é melhoria posterior, não requisito. |
| Papel novo criado num módulo sem avisar o Core | **Baixa** | O registro em `core/modulos.js` precisa ser atualizado junto. Fica documentado no CLAUDE.md de cada módulo. |
| Custo de 7 serviços no Railway | **Baixa** | Já são 5 hoje; entram o Core e a Fachada, ambos leves. |
| Navegar entre módulos recarrega a página | **Baixa** | Aceitável — é troca de sistema, não de aba. |

---

## 11. Comparação honesta com a alternativa

| | **Esta arquitetura** (acesso único) | Fusão de códigos |
|---|---|---|
| Login único | ✅ | ✅ |
| Admin Geral separado por módulo | ✅ | ✅ |
| Particularidade de cada sistema preservada | ✅ total | ⚠️ parcial |
| Código de negócio reescrito | ❌ nenhum | ⚠️ ~25 mil linhas reorganizadas |
| Risco de quebrar o que funciona | Baixo | Alto |
| Precificação (TypeScript) | ✅ entra igual aos outros | ❌ exigiria reescrita |
| Falha isolada por módulo | ✅ mantida | ❌ perdida |
| Serviços no Railway | 7 | 1 |
| Visual 100% uniforme | ⚠️ exige trabalho extra | ✅ natural |

A troca é clara: você abre mão da uniformidade visual automática e de um deploy único, e
ganha risco baixo, nenhuma reescrita e a Precificação incluída sem drama.

---

## 12. Pendências antes da Fase 0

1. **Domínio** — definir o endereço (ex.: `unigestao.uniseter.com`). O domínio único é o
   que faz o cookie compartilhado funcionar; sem ele a arquitetura fica mais complicada.
2. **Repositório e serviços** — criar `github.com/rodrigomor2901/unigestao` (Core +
   Fachada) e dois serviços novos no Railway, com um PostgreSQL pequeno só para o Core.
3. **2FA obrigatório ou opcional?** Sugestão: obrigatório para `super_admin`, opcional
   para os demais.
4. **Quem são os super admins** além de você.
5. **`Desktop\Controle de Documentos` não está em Git.** Hoje não existe como desfazer um
   erro nesse projeto. Vale versionar antes de qualquer alteração — vale
   independentemente do UniGestão.
