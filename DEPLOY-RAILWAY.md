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
- [ ] Cada módulo recebe `x-ug-identidade` e recusa cabeçalho `x-ug-*` sem assinatura
- [ ] `UG_LEGACY_HEADERS_ENABLED` **não** está definida em nenhum módulo
- [ ] `URL_CORE` aponta para `http://core.railway.internal:3000`
- [ ] Login funciona e o 2FA foi ativado
- [ ] `BOOTSTRAP_SENHA` removida das variáveis

---

## Como a identidade da pessoa chega aos módulos

A Fachada **assina** quem é a pessoa; o módulo **confere a assinatura** antes de
acreditar em qualquer campo. Vai tudo num cabeçalho só, `x-ug-identidade`:
id, nome, e-mail, papel, super admin, módulo de destino, hora de emissão,
validade e um número único — lacrados juntos por um HMAC-SHA256.

O desenho anterior mandava esses campos soltos (`x-ug-id`, `x-ug-papel`,
`x-ug-super`) e validava com um segredo que viajava junto, no `x-ug-key`. Quem
tivesse o segredo montava um administrador num `curl`, só trocando dois
cabeçalhos — e o segredo passava por todo módulo, em toda requisição, então
bastava um log ou um módulo comprometido para vazar.

O que a assinatura resolve:

| Ataque | Antes | Agora |
|---|---|---|
| Mandar `x-ug-papel: admin` num curl | entrava com o segredo | ignorado |
| Editar o papel de um bilhete legítimo | — | assinatura quebra |
| Reusar um bilhete capturado | valia para sempre | 2 min, e só uma vez |
| Usar bilhete do CRM na Precificação | valia | recusado (preso ao módulo) |

**O que ela não resolve, e é honesto dizer:** a assinatura é simétrica. Quem
tiver o segredo de assinatura emite bilhete válido. O ganho é que o segredo
deixa de viajar e o bilhete passa a ter dono e prazo.

### Variáveis

| Variável | Onde | Para quê |
|---|---|---|
| `CORE_INTERNAL_KEY` | Core, Fachada, módulos | já existia; hoje a chave de assinatura **deriva** dela quando não há uma dedicada |
| `UG_ASSINATURA_SEGREDO` | Fachada e módulos | opcional, **recomendada**: chave de assinatura própria. Tem que ser *idêntica* nos sete serviços, e entra nos módulos ANTES da Fachada |
| `UG_MODULO` | cada módulo | opcional: a chave do módulo (`eventos`, `crm`…). Prende o bilhete àquela porta |
| `UG_LEGACY_HEADERS_ENABLED` | cada módulo | opcional: `true` reativa os cabeçalhos soltos. **Deixe desligado** — ligado, devolve o furo |
| `CHAT_EMAILS` | Core | opcional: e-mails (separados por vírgula) que enxergam o comunicador interno. **Vazio = todo mundo.** Serve para testar com três pessoas antes de abrir para as 45 — quem não está na lista não vê o chat *e* não aparece na lista de quem vê |

### A virada

Os dois primeiros passos já foram feitos (01/09/2026):

1. ✅ **Fachada assinando.** Ela manda o bilhete assinado *e* continua mandando
   os cabeçalhos antigos, para nenhum módulo quebrar durante a troca.
2. ✅ **Os seis módulos exigindo assinatura.** Operacional, Eventos, Tarefas,
   Documentos, CRM e Precificação ignoram os cabeçalhos soltos.

Falta tirar o segredo de circulação. Hoje a chave de assinatura é *derivada* da
`CORE_INTERNAL_KEY` — que continua viajando no `x-ug-key` para os seis módulos.
Quem consegue ler uma requisição tem o material para emitir bilhete válido.

**Por que não dá para virar de uma vez:** assinar usa uma chave só. No instante
em que a Fachada trocasse de segredo, todo módulo que ainda não tivesse o novo
recusaria todo mundo — e a virada teria que ser simultânea em sete serviços.
Por isso o verificador aceita **as duas** chaves (a dedicada e a derivada)
enquanto durar a troca. A ordem então fica sem buraco:

3. ✅ **Verificador aceitando as duas chaves**, nos sete serviços.
4. **Gerar um segredo** e cadastrar `UG_ASSINATURA_SEGREDO` **nos seis
   módulos**. Nada muda ainda: a Fachada continua assinando com a derivada, e os
   módulos aceitam as duas. Um segredo bom sai de:

   ```
   node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
   ```

5. **Cadastrar o mesmo valor na Fachada.** Ela passa a assinar com a dedicada, e
   todos já aceitam. É aqui que o segredo que assina deixa de ser o que viaja.
6. ✅ **Faxina feita (01/09/2026):** a Fachada não manda mais o `x-ug-key` nem
   os campos soltos — só o bilhete assinado e o `x-ug-base` (prefixo do módulo,
   que serve para montar link e não decide acesso). E havendo
   `UG_ASSINATURA_SEGREDO`, os módulos aceitam **só** ele: a chave derivada da
   `CORE_INTERNAL_KEY` deixou de valer.

   Sem `UG_ASSINATURA_SEGREDO` a derivada ainda vale — é o que mantém o
   `dev-local.js` rodando sem cadastrar segredo nenhum. Em produção os sete
   serviços têm a variável, então lá vale só a dedicada.

**A ordem importa.** Cadastrar na Fachada antes dos módulos derruba: módulo sem
o segredo novo recusa bilhete assinado com ele. Se acontecer, é reversível —
apagar a variável da Fachada devolve tudo ao passo anterior.

Para quem usa o portal, nenhum desses passos muda nada: o bilhete é interno,
criado e conferido a cada requisição entre a Fachada e o módulo. Ninguém é
deslogado.

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
