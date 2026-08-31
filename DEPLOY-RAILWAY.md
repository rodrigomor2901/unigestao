# Deploy no Railway

## Estado atual — Fase 0 no ar (17/08/2026)

**Endereço: https://unigestao.up.railway.app**

| Recurso | Nome | Situação |
|---|---|---|
| Projeto | `unigestao` (`260968c6-d960-45f8-b3d4-5b085c091ca9`) | criado |
| Banco | `Postgres` | online |
| Core | `core` — `core.railway.internal:3000` | online, **sem domínio público** |
| Fachada | `fachada` — `unigestao.up.railway.app` | online, **único serviço público** |

O primeiro super admin foi criado no boot (`rodrigo.moraes@uniseter.com`) com senha
aleatória impressa nos logs. `BOOTSTRAP_SENHA` **não** foi definida como variável — a
senha nunca ficou guardada na configuração do Railway.

### Armadilha encontrada: como definir o Root Directory

`railway environment edit --service-config <svc> source.rootDirectory /fachada` responde
`{"committed":false,"message":"No changes to apply"}` e **não faz nada**. Esse comando
pertence ao sistema de configuração declarativa, que exige o Railway TypeScript SDK
instalado no repositório.

Sem o SDK, o caminho que funciona é a API GraphQL:

```bash
railway api 'mutation($serviceId: String!, $environmentId: String, $input: ServiceInstanceUpdateInput!) {
  serviceInstanceUpdate(serviceId: $serviceId, environmentId: $environmentId, input: $input)
}' --variables @vars.json
```

com `vars.json` contendo `serviceId`, `environmentId` e `{"input":{"rootDirectory":"/fachada"}}`.
Depois é preciso **redeployar** — a mudança não afeta um build já em andamento.

Sintoma de que não pegou: a Fachada sobe `unigestao-core@1.0.0` em vez de
`unigestao-fachada@1.0.0` e quebra procurando PostgreSQL em `127.0.0.1:5432`.

---

## Passo a passo (para refazer do zero)

Este guia sobe o UniGestão pela primeira vez: um banco, o Core e a Fachada.
Nenhum sistema atual é tocado — eles continuam rodando exatamente como estão.

Ao final você terá um endereço único com login e o Admin Geral funcionando,
ainda sem nenhum módulo plugado. Plugar módulos é assunto das fases seguintes.

---

## Antes de começar

Tenha à mão a **chave interna** — é o segredo compartilhado entre os serviços.
Se precisar gerar outra:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

Guarde essa chave. Ela vai ser colada em três lugares (Core, Fachada e, depois,
em cada módulo).

---

## Passo 1 — Criar o projeto e o banco

1. No Railway, **New Project** → dê o nome `unigestao`.
2. Dentro dele: **+ New** → **Database** → **Add PostgreSQL**.

Esse banco é pequeno: guarda só pessoas, acessos e sessões. Nenhum dado de
negócio passa por aqui.

---

## Passo 2 — Serviço do Core

1. **+ New** → **GitHub Repo** → `rodrigomor2901/unigestao`.
2. Renomeie o serviço para **`core`** (Settings → Service Name). O nome importa:
   ele vira o endereço interno.
3. Em **Settings → Networking**: **não** gere domínio público. Se já tiver sido
   criado um, remova. O Core só é alcançado por dentro.
4. Em **Variables**, adicione:

   | Variável | Valor |
   |---|---|
   | `DATABASE_URL` | `${{Postgres.DATABASE_URL}}` |
   | `PORT` | `3000` |
   | `NODE_ENV` | `production` |
   | `CORE_INTERNAL_KEY` | a chave gerada |
   | `SESSAO_HORAS` | `10` |
   | `BOOTSTRAP_NOME` | `Rodrigo Moraes` |
   | `BOOTSTRAP_EMAIL` | seu e-mail de acesso |
   | `BOOTSTRAP_SENHA` | uma senha provisória forte |

   `${{Postgres.DATABASE_URL}}` é a referência do próprio Railway ao banco criado
   no passo 1 — digite exatamente assim, com as chaves.

5. Aguarde o deploy. Nos logs deve aparecer `[db] schema verificado` e
   `[core] UniGestao ouvindo na porta 3000`.

---

## Passo 3 — Serviço da Fachada

1. **+ New** → **GitHub Repo** → `rodrigomor2901/unigestao` **de novo** (é o mesmo
   repositório; muda a pasta).
2. Renomeie para **`fachada`**.
3. Em **Settings → Build**, defina **Root Directory** = `fachada`.
4. Em **Settings → Networking**, **gere o domínio público**. Este é o único serviço
   com endereço público — é o endereço do UniGestão.
5. Em **Variables**:

   | Variável | Valor |
   |---|---|
   | `NODE_ENV` | `production` |
   | `CORE_INTERNAL_KEY` | **a mesma chave** do Core |
   | `URL_CORE` | `http://core.railway.internal:3000` |
   | `PROXIES_NA_FRENTE` | opcional — padrão `2`, que é o do Railway; só mude se a topologia mudar |

   Não preencha as `URL_<MODULO>` ainda — nenhum módulo foi plugado.
   O `PORT` da Fachada o Railway injeta sozinho, por ela ter domínio público.

6. Aguarde o deploy. Os logs devem mostrar `[fachada] ouvindo na porta ...` e a
   lista de módulos como `(nao conectado)`.

---

## Passo 4 — Primeiro acesso

Abra o domínio público da Fachada.

1. Entre com o `BOOTSTRAP_EMAIL` e a `BOOTSTRAP_SENHA`.
2. Como administrador geral, o 2FA é obrigatório: a tela mostra um QR Code.
   Leia no **Google Authenticator** (ou Microsoft Authenticator / Authy) e digite
   o código de 6 dígitos.
3. Você cai na tela inicial. Em **Admin Geral** já dá para cadastrar pessoas.

**Assim que entrar, troque a senha provisória** e apague a variável
`BOOTSTRAP_SENHA` do Railway — ela não é mais usada depois do primeiro usuário,
e não convém deixar senha em variável de ambiente.

---

> **O código do 2FA vem de um cadastro novo.** Ao ler o QR Code, o Google Authenticator
> cria uma entrada chamada **`UniGestao: seu@email`**. É só o código dessa entrada que
> funciona aqui. Códigos de outras entradas da lista (inclusive de outros sistemas do
> grupo) nunca vão servir — cada uma tem um segredo próprio.

Se travar nessa etapa, veja **Perdeu o 2FA** no [README.md](README.md#perdeu-o-2fa-celular-novo-aplicativo-apagado).

---

## Conferência final

- [ ] O serviço `core` **não** tem domínio público
- [ ] O serviço `fachada` **tem** domínio público
- [ ] `CORE_INTERNAL_KEY` é idêntica nos dois
- [ ] `URL_CORE` aponta para `http://core.railway.internal:3000`
- [ ] Login funciona e o 2FA foi ativado
- [ ] `BOOTSTRAP_SENHA` removida das variáveis

---

## Como o endereço de rede de quem chama é apurado

O bloqueio de tentativas de login e o registro na auditoria dependem de saber de
onde veio a requisição. Esse endereço chega num cabeçalho, `X-Forwarded-For`, e
cabeçalho é texto: **quem chama escreve o que quiser nele**.

O que separa o verdadeiro do inventado é a ordem. Cada proxy *acrescenta no fim*
o endereço de quem falou com ele. Então, com um proxy na frente — a borda do
Railway —, o último valor foi escrito pela infraestrutura e vale; tudo o que vem
antes foi escrito por quem chamou e não vale nada.

Isso já foi um defeito: o Core lia o **primeiro** valor. Bastava mandar um
endereço diferente a cada tentativa para o teto de 60 por local nunca fechar, e
a auditoria guardava endereço inventado — pior do que não guardar, porque dá a
impressão de que se sabe de onde veio.

Hoje são duas travas:

1. **A Fachada reescreve o cabeçalho** antes de repassar. Ela conta os saltos
   (`PROXIES_NA_FRENTE`, padrão 2) e manda adiante **um valor só**, o verdadeiro.
   O que o cliente escreveu não chega ao Core nem aos módulos.

   O número 2 foi medido, não suposto (31/08/2026): três requisições de fora,
   mandando 0, 1 e 2 endereços inventados, chegaram todas com **exatamente 2
   valores** na lista — a borda do Railway descarta o que o cliente escreve e
   monta a lista sozinha, com dois saltos. Se a topologia mudar, a primeira
   requisição de cada processo registra a forma nova no log da Fachada
   (quantidade e tipo, nunca o endereço).
2. **O Core só acredita no cabeçalho quando o vizinho da conexão é da rede
   privada** do Railway — por onde unicamente a Fachada fala. Requisição vinda de
   fora tem o cabeçalho ignorado e vale o endereço real da conexão.

Rodando na sua máquina sem proxy nenhum na frente, o certo é
`PROXIES_NA_FRENTE=0` — o `dev-local.js` já define isso. Sem proxy, o cabeçalho
inteiro é invenção e deve ser descartado.

---

## Por que a Fachada precisa ser o único serviço público

No Railway cada serviço ganha um subdomínio `*.up.railway.app`. Cookies **não** são
compartilhados entre esses subdomínios: `up.railway.app` está na lista de sufixos
públicos e o navegador recusa um cookie com esse escopo. Com um domínio público só,
existe um cookie só — e o login vale para todos os módulos sem gambiarra.

O efeito colateral é bom: os módulos deixam de ser acessíveis pela internet. É isso
que torna confiáveis os cabeçalhos de identidade que a Fachada envia a eles.

---

## Nas próximas fases (plugar um módulo)

Para cada sistema, o roteiro é sempre o mesmo:

1. No serviço daquele sistema no Railway: **remover o domínio público** e anotar
   o endereço interno (`nome-do-servico.railway.internal:PORTA`).
2. Acrescentar `CORE_INTERNAL_KEY` (a mesma) nas variáveis dele.
3. No serviço `fachada`: preencher a `URL_<MODULO>` correspondente.
4. No código do módulo: copiar `integracao/unigestao.js` e trocar o middleware de
   autenticação (ver [README.md](README.md)).
5. Em `core/modulos.js`: marcar `ativo: true` naquele módulo.

O sistema antigo só sai do ar depois que o módulo novo estiver validado em uso real.
