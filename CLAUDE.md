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
│   └── modulos.js         # REGISTRO dos modulos e dos papeis de cada um
├── public/                # login.html, inicio.html, admin.html, core.css
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
