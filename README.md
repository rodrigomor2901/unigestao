# UniGestão

Acesso único para os sistemas do Grupo Uniseter. Um cadastro por colaborador, uma senha,
e um Admin Geral onde se define quais módulos cada pessoa acessa.

Cada sistema continua sendo o sistema que é hoje — mesmo código, mesmo banco, mesmas
regras. O UniGestão põe por cima o login, o controle de acesso e um endereço só.

---

## As duas peças deste repositório

| Peça | Pasta | O que faz |
|---|---|---|
| **Core** | raiz (`server.js`, `core/`, `public/`) | Login, 2FA, sessões e Admin Geral. Sem nenhuma regra de negócio. |
| **Fachada** | `fachada/` | Único serviço com endereço público. Roteia por caminho, valida o acesso e injeta a barra comum. |

E mais um arquivo de apoio:

| `integracao/unigestao.js` | Vai copiado para dentro de cada módulo. Substitui o login próprio dele. |

---

## Rodar localmente

```bash
docker run -d --name unigestao-pg -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=unigestao -p 55987:5432 postgres:16-alpine
npm install
npm run dev
```

Abra <http://localhost:8080>. No primeiro acesso o Core cria o super admin e imprime a
senha no log (ou usa `BOOTSTRAP_SENHA`). Como super admin, o 2FA é obrigatório: a tela
mostra o QR Code para ler no Google Authenticator.

```bash
npm test
```

Roda os testes de permissão e de proxy. Exige o servidor no ar.

---

## Como o login único funciona

No Railway cada serviço ganha um subdomínio `*.up.railway.app`. **Cookies não são
compartilhados entre esses subdomínios** — `up.railway.app` está na lista de sufixos
públicos e o navegador recusa.

Por isso: **só a Fachada tem endereço público.** Os módulos ficam na rede privada do
Railway, alcançáveis apenas por ela. Um domínio público, um cookie, login único sem
gambiarra — e os sistemas deixam de ser acessíveis direto da internet.

```
navegador → unigestao.up.railway.app (Fachada)
                    ├── /            → Core
                    ├── /operacional → operacional.railway.internal
                    ├── /eventos     → eventos.railway.internal
                    └── ...
```

A cada requisição de módulo, a Fachada pergunta ao Core quem é a pessoa naquele módulo
(com cache de 30 s), barra quem não tem acesso, e repassa a identidade em cabeçalhos
`x-ug-*`. O módulo não precisa consultar banco nenhum para saber quem está logado.

---

## Papéis: a particularidade de cada sistema

`core/modulos.js` guarda, para cada módulo, a lista de papéis que **aquele sistema já
usa hoje** — `admin/supervisor/cco/comercial` no Operacional, os 10 níveis da Gestão de
Tarefas, `admin/consulta` no Controle de Documentos, e assim por diante.

O Core guarda o rótulo mas **não sabe o que ele significa**. Quem interpreta continua
sendo cada sistema. Para acrescentar um papel novo, basta uma palavra nessa lista: ele
passa a aparecer no Admin Geral e nada mais muda.

---

## Plugar um módulo novo

1. Copiar `integracao/unigestao.js` para dentro do sistema.
2. Trocar o middleware de autenticação dele:
   ```js
   const ug = require('./unigestao');
   app.use(ug.identificar);
   app.get('/api/x', ug.exigeLogin, ...);
   app.post('/api/x', ug.exigePapel('admin','gestao'), ...);
   ```
   `req.usuario.nivel` continua existindo com o mesmo significado, então o código atual
   do sistema não precisa ser reescrito.
3. Remover a tela de login. Da tela de usuários, remover **só** o que passou para o Admin
   Geral (criar pessoa, definir senha, escolher o papel) — e **manter** os ajustes que são
   específicos daquele sistema.

   > O Core guarda **um papel por módulo**, e nada além disso. Vários sistemas têm
   > refinamentos por pessoa que não cabem nesse modelo — no Lançamento de Extra, por
   > exemplo, cada usuário pode ter um `queueAccess` próprio que sobrepõe as filas padrão
   > do papel. Esses ajustes continuam no módulo, numa linha local ligada ao id do Core.
   >
   > A divisão é: **o Core diz quem é a pessoa e qual o papel dela ali; o módulo diz o que
   > aquele papel significa e guarda os detalhes.**
4. No Railway: **remover o domínio público** do serviço e anotar o endereço interno.
5. No Core e na Fachada: preencher `URL_<MODULO>` e marcar `ativo: true` em
   `core/modulos.js`.

O shim injetado pela Fachada corrige sozinho os caminhos das chamadas de API do módulo
(`fetch('/api/x')` vira `/eventos/api/x`), então essa parte não exige mexer no front-end.

---

## Perdeu o 2FA (celular novo, aplicativo apagado)

Se a pessoa **não é** o único administrador geral, outro admin reseta pela tela:
Admin Geral → Editar → **Resetar 2FA**.

Se ficou travado de vez — perdeu o aplicativo e é o único super admin — não há como
destravar pela web, de propósito. A saída é pelo servidor:

```bash
node scripts/resetar-2fa.js                       # lista quem tem 2FA ativo
node scripts/resetar-2fa.js pessoa@uniseter.com   # reseta essa pessoa
```

No Railway: serviço `core` → menu → **Run a command**. No próximo login o QR Code
aparece de novo. O script também derruba as sessões abertas e limpa o bloqueio por IP.

---

## Variáveis de ambiente

Ver [.env.exemplo](.env.exemplo). As essenciais:

| Variável | Onde | Para quê |
|---|---|---|
| `DATABASE_URL` | Core | PostgreSQL do Core (só pessoas e sessões) |
| `CORE_INTERNAL_KEY` | Core, Fachada, módulos | Chave compartilhada entre os serviços |
| `URL_CORE` | Fachada | Endereço interno do Core |
| `URL_<MODULO>` | Fachada | Endereço interno de cada módulo |
| `BOOTSTRAP_EMAIL` / `BOOTSTRAP_SENHA` | Core | Primeiro super admin |
| `SESSAO_HORAS` | Core | Duração da sessão (padrão 10) |

---

## Segurança

- Senha em PBKDF2 com 120.000 iterações.
- 2FA por TOTP (RFC 6238), obrigatório para administrador geral.
- Bloqueio de IP após 10 tentativas em 15 minutos, persistido no banco.
- Cookie `HttpOnly`, `SameSite=Lax`, `Secure` em produção.
- Auditoria de login, alterações de cadastro e mudanças de acesso — nunca apagada.
- Trocar a senha ou desativar alguém derruba as sessões abertas dessa pessoa na hora.

**Senhas dos sistemas antigos:** o campo carrega o algoritmo junto
(`pbkdf2-sha256:`, `pbkdf2-sha512:`, `bcrypt:`) e é regravado no formato novo no primeiro
login. Ninguém precisa redefinir senha na migração — exceto os usuários da Gestão de
Eventos, cujas senhas estão em SHA-256 sem sal e são recusadas de propósito.
