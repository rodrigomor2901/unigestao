# UniGestão — contexto do projeto

Acesso único para os sistemas do Grupo Uniseter. **Não é uma fusão de códigos**: cada
sistema continua independente, com seu banco, seu deploy e suas regras. Este projeto põe
por cima o login único, o controle de acesso por módulo e um endereço só.

O desenho completo está em [DESENHO-TECNICO.md](DESENHO-TECNICO.md).

---

## Estrutura

```
UniGestao/
├── server.js              # CORE: login, 2FA, sessoes, Admin Geral
├── dev-local.js           # sobe Core + Fachada juntos, para desenvolvimento
├── core/
│   ├── db.js              # pool PostgreSQL
│   ├── schema.sql         # usuarios, usuario_modulos, sessoes, login_attempts, auditoria
│   ├── auth.js            # PBKDF2, verificacao multi-algoritmo, TOTP, rate limit
│   ├── chat.js            # COMUNICADOR: o que vale como mensagem, quem apaga, quem ve
│   ├── modulos.js         # REGISTRO dos modulos e dos papeis de cada um
│   └── custos-railway.js  # CUSTOS: painel /custos e alerta de fatura do Railway
├── public/                # login.html, inicio.html, admin.html, core.css
│                          # chat.js + chat.css: o comunicador, servido tambem aos modulos
├── fachada/server.js      # FACHADA: unico servico publico, roteia e injeta o shim
├── integracao/unigestao.js# arquivo copiado para dentro de cada modulo
└── tests/                 # permissao.test.js, fachada.test.js
```

---

## Regras que não devem ser quebradas

1. **O Core não tem regra de negócio.** Ele só sabe quem é a pessoa e a que módulos ela
   tem acesso. Qualquer lógica de eventos, tarefas, CRM etc. fica no módulo.

2. **O Core não sabe o que os papéis significam.** `core/modulos.js` guarda a lista de
   papéis de cada sistema como rótulos. Quem interpreta é o módulo. Não criar lógica no
   Core que dependa do significado de um papel específico.

3. **Só a Fachada tem endereço público.** Os módulos vivem na rede privada do Railway.
   Essa é a premissa que torna os cabeçalhos `x-ug-*` confiáveis. Se um módulo ganhar
   domínio público, a premissa cai e a identidade pode ser forjada.

   **Restrição do Railway (confirmada na doc):** a rede privada é isolada **por projeto e
   ambiente** — serviços em projetos diferentes não se enxergam por ela. Hoje cada sistema
   do grupo está em um projeto separado. Então, ao plugar cada módulo, existem dois
   caminhos, e a escolha é por módulo:
   - **Mover o serviço para o projeto `unigestao`** — ganha a rede privada e a premissa
     acima vale integralmente. Exige recriar o serviço apontando para o mesmo repositório
     e decidir o que fazer com o banco dele.
   - **Deixar onde está** — a Fachada fala com o módulo pelo domínio público dele, e a
     chave compartilhada (`x-ug-key`) passa a ser a única tranca. Funciona, mas o segredo
     trafega em toda requisição: se vazar, dá para forjar identidade em qualquer módulo.

   Preferir o primeiro caminho. O segundo só como transição.

4. **Um domínio público só.** Cookies não são compartilhados entre subdomínios
   `*.up.railway.app` (sufixo público). É por isso que existe a Fachada.

5. **Nenhum módulo lê o banco do Core**, e o Core não lê o banco de nenhum módulo.

---

## Ao plugar um módulo (fases 1 a 6)

1. Copiar `integracao/unigestao.js` para o sistema e trocar o middleware de auth.
2. Remover do sistema: tela de login, tela de usuários, tabela de sessões própria.
3. Remover o domínio público do serviço no Railway.
4. Preencher `URL_<MODULO>` e marcar `ativo: true` em `core/modulos.js`.
5. Rodar `npm test`.

Ordem acordada: Operacional → Documentos → Eventos → Tarefas → CRM → Precificação.
**Nenhum sistema antigo é desligado antes de o módulo novo estar validado em produção.**

---

## Detalhes que custaram trabalho (não regredir)

- **`transfer-encoding` vs `content-length`**: ao injetar HTML, a Fachada precisa apagar
  o `transfer-encoding` antes de definir o `content-length`. Os dois juntos são inválidos
  em HTTP e o navegador recusa a resposta inteira.

- **Shim de caminhos**: os sistemas chamam a própria API com caminho absoluto
  (`fetch('/api/x')`). Servidos sob `/eventos`, isso se perderia. A Fachada injeta um
  trecho que intercepta `fetch` e `XMLHttpRequest` e acrescenta o prefixo. É o que
  permite plugar um sistema sem reescrever o front-end dele.

- **Cabeçalhos com acento**: `x-ug-nome` vai com `encodeURIComponent` e volta com
  `decodeURIComponent`. Sem isso, um nome acentuado quebra o cabeçalho HTTP.

- **Senhas legadas**: o campo carrega o algoritmo junto e é regravado no formato novo no
  primeiro login. Os ~1.230 usuários da Gestão de Tarefas (bcrypt) migram sozinhos. O
  `sha256:` da Gestão de Eventos é recusado de propósito — sem sal, é fraco demais.

- **Pendência do 2FA nunca se destrói num código errado.** A primeira versão consumia o
  token temporário *antes* de conferir o código: um erro de digitação derrubava o login e
  a tela dizia "Sessão de login expirada", escondendo o motivo real. Agora a pendência é
  lida sem destruir, conta tentativas (`MAX_TENTATIVAS_2FA`) e só é apagada quando o
  código acerta. Coberto por `tests/dois-fatores.test.js`.

- **A pendência do 2FA mora no banco, não em memória.** Em memória ela sumiria a cada
  deploy do Core e quebraria de vez com mais de uma instância: a senha entraria numa e o
  código cairia na outra. Não voltar a usar `Map` para isso.

- **O comunicador interno mora no Core e aparece nos seis modulos.** A Fachada serve
  `public/chat.js` e `public/chat.css` em `/<modulo>/__ug/chat.*`, e desvia
  `/<modulo>/__ug/chat/*` para `/api/chat/*` do Core. Tem que sair de baixo do endereco do
  modulo: o CRM manda `script-src 'self'` e arquivo de outra origem nao carregaria. Pelo
  mesmo motivo o widget nao tem `<style>` embutido nem `onclick` no HTML.

- **Tempo real do chat: consulta ao banco a cada 2s, nao registro de conexoes em
  memoria.** Parece menos elegante e e o que sobrevive a duas instancias do Core: a
  mensagem que chegou na instancia A precisa alcancar quem esta pendurado na B. Com
  conexoes em memoria isso falharia calado — metade das mensagens sumindo, so para
  algumas pessoas. Se um dia pesar, o caminho e `LISTEN/NOTIFY` do proprio Postgres.

- **Apagar mensagem e ESCONDER, nunca remover a linha.** E o que sustenta a promessa do
  resgate a pedido da diretoria. Apagar de verdade transformaria "da para resgatar" numa
  promessa que o sistema nao cumpre justamente no caso em que ela importa.

- **A permissao de notificacao NAO e pedida ao abrir a pagina.** O convite fica dentro
  do painel do chat e so sai depois de um clique. Pedido do nada, a pessoa clica em
  "Bloquear" — e bloqueio no navegador nao tem volta pela tela do sistema, so pelas
  configuracoes do Chrome. A caixinha do Windows so aparece com a janela ESCONDIDA:
  com a pessoa olhando, o selo e o bip ja avisaram. Coberto por `tests/chat-aviso.test.js`.

- **A janela separada do chat e o MESMO chat.js.** `public/chat-janela.html` so marca
  `data-janela` no `<body>`; o codigo ve a marca e ocupa a janela inteira. Duas telas do
  mesmo chat dariam duas manutencoes e, na pratica, duas telas diferentes.

- **As janelas do chat conversam por `BroadcastChannel`.** Com a janela separada aberta,
  as telas embutidas ficam quietas — senao a pessoa ouve um bip por aba do UniGestao que
  estiver aberta. Sem suporte ao recurso, o pior caso e bip repetido, nunca falha.

- **A situacao (`ocupado`/`reuniao`) vence em 8 horas, na propria consulta.** Sem prazo,
  quem marcou "em reuniao" na sexta amanhece em reuniao na segunda — e situacao que mente
  faz as pessoas pararem de acreditar em todas. Estar offline sempre vence a situacao
  escolhida.

- **Cada modulo so atende quem vem pela Fachada** (`portaDaFachada` em
  integracao/unigestao.js, copiado nos cinco modulos JS). Desativar a pessoa no portal
  fechava so a porta do portal: o endereco proprio de cada sistema continuava no ar com o
  login antigo dele. A tranca confere o bilhete assinado; sem bilhete, o navegador recebe
  uma pagina dizendo onde entrar e a chamada de programa recebe 403.

  Duas consequencias para quem for mexer: (1) `identidadeDoCore` passou a GUARDAR o
  resultado no proprio pedido, porque a porta confere e a rota confere de novo — e cada
  bilhete so vale uma vez; (2) teste que bate na API sem passar pela Fachada precisa de
  `UG_PORTA_ABERTA=true` (ja esta nos harness do CRM e das Tarefas).

  Falta o Precificacao, que e NestJS + SPA em nginx e pede outro formato.

- **O canal do departamento mora na MESMA tabela `conversas`** (coluna `tipo`), e nao
  numa tabela nova. Mensagem, leitura, imagem, apagar, tempo real e resgate ja rodam em
  cima de `conversa_id`; em tabela separada, cada uma dessas seis coisas precisaria de uma
  segunda versao — e a segunda e sempre a que fica para tras quando alguem corrige um
  defeito na primeira. **Nao existe tabela de membros:** quem esta no canal e quem tem
  aquele departamento no cadastro, conferido a cada pedido. Lista de membros a parte sairia
  do lugar no dia em que alguem mudasse de area.

- **Grupo x canal: a diferenca e de ONDE vem a lista de gente.** No canal do
  departamento ela e derivada do cadastro e nao se guarda. No grupo ("os gestores de todas
  as areas") nao existe regra que a produza — e escolha — entao existe `conversa_membros`.
  Guardar membro do canal criaria uma segunda verdade sobre quem participa, e as duas
  discordariam no dia em que alguem mudasse de area.

- **A forma de uma conversa (`conversa_forma`) e definida UMA vez no schema.** Ja esteve
  em dois lugares: a versao de duas formas rodava antes da de tres e derrubou o boot no
  dia em que o primeiro grupo apareceu — a linha nova violava a regra que ainda nao
  conhecia grupos. Constraint escrita em dois pontos passa meses quieta e falha
  exatamente quando o dado novo chega.

- **`departamentos` e NOT NULL.** Ao criar acesso sem departamento, mande lista vazia e
  nunca `null` — com `null` a criacao de acesso inteira falhava com 500, e nao escolher
  departamento e o caso comum.

### O previsto das visitas não vem da API do Nexti

Apurado em 06/10/2026, contra a API de produção: ela tem **386 endereços e
nenhum é o roteiro**. Pedir o roteiro `18073` (que existe na tela *Nexti Control
→ Roteiro*) responde "não encontrado"; `/routes`, `/roteiros`, `/agendas`,
`/taskschedules`, `/visits` e mais quarenta nomes dão 404; `/control/...` dá 404
com a nossa credencial. O que a API chama de `schedules` é **escala de trabalho**
("das 06:00 às 15:48, 5X2"), não roteiro de visita.

Por isso o previsto entra por planilha — o relatório *Relação de visitas* — no
painel de checklists (`core/visitas-previstas.js`). Três decisões que não devem
ser desfeitas sem motivo:

- **só vira roteiro o que se repete em 2+ semanas.** O relatório mistura visita
  semanal, visita "não se repete" e tarefa de demanda (CC - SOLICITACAO). Tratar
  tudo como roteiro dava 501 pontos/semana onde 10 se repetiam.
- **a conta é por semana, não por dia.** Visita de quinta feita na sexta cumpriu
  o roteiro; cobrar o dia exato transforma remarcação em falta.
- **a semana corrente não entra na conta.** Visita combinada para depois de hoje
  não é visita perdida.

Cuidado com nomes: a *Agenda de Contatos* do portal (`core/perfil.js`,
`tests/agenda.test.js`) não tem nada a ver com a *agenda de visitas*.

### Custos do Railway (`core/custos-railway.js`, tela `/custos`)

Nasceu da fatura de 07/10/2026 (US$ 24 onde se pagava ~US$ 6). Só o administrador
geral vê. Precisa de `RAILWAY_API_TOKEN` (token de **workspace**) e
`RAILWAY_WORKSPACE_ID` no serviço `core`; sem eles a tela explica o que falta e nada
mais muda.

- **A API do Railway devolve MINUTOS** (GB-minuto, vCPU-minuto), não meses. Os preços
  em `PRECO_POR_UNIDADE` são por minuto e foram conferidos contra a fatura real em
  `tests/custos-railway.test.js` — se a conta parar de bater com a fatura, é ali que falha.
- **Backup é cobrado na linha do disco.** Os dois entram com o mesmo preço.
- **Cada alerta sai uma vez por ciclo** (`custos_alerta`, chave `ciclo_inicio + tipo`).
  A linha é inserida ANTES do envio: com duas instâncias do Core, só uma consegue
  inserir e só ela manda o e-mail. Não trocar por controle em memória.
- **Foto diária em `custos_dia`**, gravada a cada 6 h no fuso de Brasília — é o que
  desenha a curva do mês, que a tela do Railway não guarda.

---

## Comandos

```bash
npm run dev    # Core (3000) + Fachada (8080)
npm test       # testes de permissao e de proxy — exige o servidor no ar
```

PostgreSQL de desenvolvimento:

```bash
docker run -d --name unigestao-pg -e POSTGRES_PASSWORD=teste -e POSTGRES_DB=unigestao -p 55987:5432 postgres:16-alpine
```
