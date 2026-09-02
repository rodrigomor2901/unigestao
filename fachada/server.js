"use strict";

// ============================================================================
// UniGestao — FACHADA
// ----------------------------------------------------------------------------
// E o unico servico com endereco publico. Tudo passa por aqui:
//
//   /                  -> Core (login, inicio, Admin Geral)
//   /api/...           -> Core
//   /operacional/...   -> Sistema de Lancamento de Extra
//   /eventos/...       -> Gestao de Eventos
//   /documentos/...    -> Controle de Documentos
//   /tarefas/...       -> Gestao de Tarefas
//   /crm/...           -> CRM Comercial
//   /precificacao/...  -> pricing-saas
//
// POR QUE ISSO E NECESSARIO
// No Railway cada servico ganha um subdominio *.up.railway.app. Cookies NAO sao
// compartilhados entre esses subdominios, porque `up.railway.app` esta na lista
// de sufixos publicos e o navegador recusa. Com um dominio publico so, existe um
// cookie so — e o login unico funciona sem gambiarra.
// Os modulos ficam na rede privada do Railway, inacessiveis pela internet.
//
// O QUE A FACHADA FAZ EM CADA REQUISICAO DE MODULO
//   1. le o cookie de sessao e pergunta ao Core quem e a pessoa naquele modulo
//   2. barra quem nao tem acesso (403) e manda quem nao esta logado para o login
//   3. repassa a requisicao ao modulo, ja com a identidade em cabecalhos
//   4. se a resposta for HTML, injeta o shim (que corrige os caminhos) e a
//      barra superior comum
// ============================================================================

const http = require("http");
const https = require("https");
const { URL } = require("url");
// Copia de integracao/identidade.js — a Fachada e publicada com a propria pasta
// na raiz do container, entao nao alcanca nada de fora dela. As duas copias sao
// comparadas byte a byte em tests/identidade-assinada.test.js.
const identidade = require("./identidade");

const PORT = process.env.PORT || 8080;
const CORE = process.env.URL_CORE || "http://localhost:3000";
const CHAVE = process.env.CORE_INTERNAL_KEY || "";
const COOKIE = "unigestao_sessao";

// Mesmo registro do Core, so com o que a Fachada precisa saber.
//
// `sub` existe para modulos partidos em mais de um servico. A Precificacao e
// assim: a tela e um servico e a API e outro. Sem isso o navegador chamaria a
// API em outro dominio, fora da Fachada — e os cabecalhos de identidade nunca
// chegariam la. As sub-rotas sao testadas na ordem em que aparecem.
const MODULOS = {
  operacional:  { destino: process.env.URL_OPERACIONAL  || "" },
  documentos:   { destino: process.env.URL_DOCUMENTOS   || "" },
  eventos:      { destino: process.env.URL_EVENTOS      || "" },
  tarefas:      { destino: process.env.URL_TAREFAS      || "" },
  crm:          { destino: process.env.URL_CRM          || "" },
  precificacao: {
    destino: process.env.URL_PRECIFICACAO || "",
    sub: [{ prefixo: "/api", destino: process.env.URL_PRECIFICACAO_API || "" }],
  },
};

// Escolhe o destino conforme o caminho DENTRO do modulo. Sem `sub`, e sempre
// o destino principal — que e o caso de todos os modulos menos a Precificacao.
function destinoDe(modulo, restoDoCaminho) {
  const m = MODULOS[modulo];
  if (!m) return "";
  for (const s of m.sub || []) {
    if (restoDoCaminho === s.prefixo || restoDoCaminho.startsWith(s.prefixo + "/")) {
      return s.destino || m.destino;
    }
  }
  return m.destino;
}

// ---------------------------------------------------------------------------
// Cache curto de sessao — evita uma ida ao Core a cada arquivo carregado
// ---------------------------------------------------------------------------

const TTL_MS = 30_000;
const cache = new Map();

setInterval(() => {
  const agora = Date.now();
  for (const [k, v] of cache) if (v.ate < agora) cache.delete(k);
}, 60_000).unref();

async function identificar(token, modulo) {
  const chaveCache = `${token}|${modulo}`;
  const guardado = cache.get(chaveCache);
  if (guardado && guardado.ate > Date.now()) return guardado.valor;

  const url = `${CORE}/api/interno/sessao?modulo=${encodeURIComponent(modulo)}`;
  const headers = { "x-unigestao-token": token };
  if (CHAVE) headers["x-core-key"] = CHAVE;

  let valor;
  try {
    const r = await fetch(url, { headers });
    valor = r.ok ? await r.json() : { erro: r.status };
  } catch (e) {
    console.error("[fachada] Core indisponivel:", e.message);
    return { erro: 503 };
  }
  cache.set(chaveCache, { valor, ate: Date.now() + TTL_MS });
  return valor;
}

function lerCookie(req) {
  const c = req.headers.cookie || "";
  const m = c.match(new RegExp(`(?:^|;\\s*)${COOKIE}=([^;]+)`));
  return m ? m[1] : null;
}

// ---------------------------------------------------------------------------
// Shim injetado no HTML dos modulos
// ----------------------------------------------------------------------------
// Os sistemas atuais chamam a propria API com caminho absoluto: fetch('/api/x').
// Servidos sob /eventos, o navegador resolveria isso para a raiz do dominio e a
// chamada se perderia. Em vez de reescrever milhares de linhas em cada sistema,
// este trecho intercepta fetch e XHR e acrescenta o prefixo do modulo.
// E a peca que permite plugar um sistema quase sem tocar no codigo dele.
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// O shim e a barra vao como ARQUIVOS, nunca embutidos no HTML.
//
// Modulos com politica de seguranca estrita (o CRM manda
// `script-src 'self'; style-src 'self'`) bloqueiam script e style inline — o
// shim simplesmente nao rodava e a pagina abria na tela de login.
//
// Servindo os dois de /<modulo>/__ug/*, eles viram same-origin e passam pela
// politica do proprio modulo sem que precisemos afrouxar nada. Pelo mesmo
// motivo nao existe `onclick` inline aqui: eventos vao pelo shim.
// ---------------------------------------------------------------------------

const SHIM_JS = `(function(){
var el=document.currentScript;
var BASE=el.getAttribute('data-base')||'';
window.UNIGESTAO={base:BASE,usuario:JSON.parse(el.getAttribute('data-usuario')||'{}')};

function pfx(u){
  if(typeof u!=='string')return u;
  if(u.charAt(0)!=='/'||u.indexOf('//')===0)return u;
  if(u.indexOf(BASE+'/')===0||u===BASE)return u;
  return BASE+u;
}
var _f=window.fetch;
if(_f)window.fetch=function(e,o){
  if(typeof e==='string')return _f(pfx(e),o);
  if(e&&e.url)return _f(new Request(pfx(e.url),e),o);
  return _f(e,o);
};
var _o=XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open=function(m,u){
  arguments[1]=pfx(u);
  return _o.apply(this,arguments);
};

// EventSource (sincronizacao em tempo real). Sem isto o modulo abre a conexao
// na raiz do dominio, recebe 404 e o navegador fica retentando em loop — falha
// silenciosa, porque a tela carrega normalmente e so o tempo real para de valer.
if(window.EventSource){
  var _E=window.EventSource;
  var EventSourceUG=function(u,c){ return new _E(pfx(u),c); };
  EventSourceUG.prototype=_E.prototype;
  EventSourceUG.CONNECTING=_E.CONNECTING;
  EventSourceUG.OPEN=_E.OPEN;
  EventSourceUG.CLOSED=_E.CLOSED;
  window.EventSource=EventSourceUG;
}

// WebSocket, pelo mesmo motivo. Nenhum modulo usa hoje, mas o custo e uma linha.
if(window.WebSocket){
  var _W=window.WebSocket;
  var WebSocketUG=function(u,p){
    var alvo=(typeof u==="string"&&u.charAt(0)==="/")? (location.origin.replace(/^http/,"ws")+pfx(u)) : u;
    return p===undefined? new _W(alvo) : new _W(alvo,p);
  };
  WebSocketUG.prototype=_W.prototype;
  WebSocketUG.CONNECTING=_W.CONNECTING; WebSocketUG.OPEN=_W.OPEN;
  WebSocketUG.CLOSING=_W.CLOSING; WebSocketUG.CLOSED=_W.CLOSED;
  window.WebSocket=WebSocketUG;
}

document.addEventListener('click',function(ev){
  var alvo=ev.target.closest&&ev.target.closest('#ug-sair');
  if(!alvo)return;
  ev.preventDefault();
  // Caminho absoluto de proposito: o logout e do Core, nao do modulo.
  fetch(location.origin+'/api/logout',{method:'POST',credentials:'include'})
    .catch(function(){})
    .then(function(){location.href='/'});
});

// Links que o modulo monta em tempo de execucao, pelo mesmo motivo das
// imagens: quando o proprio JS gera <a href="/api/attachments/435/download">,
// esse trecho nasce como TEXTO dentro do app.js — nunca foi HTML, entao a
// reescrita da Fachada nao o alcanca. O clique ia para a raiz do dominio, ou
// seja, para o Core, que responde "Cannot GET".
//
// Foi o que aconteceu com os anexos do CRM. Corrigido no clique, na fase de
// captura, alterando o href antes de o navegador segui-lo — vale para link
// comum e para os que abrem em outra aba.
//
// A barra do UniGestao fica de fora: os links dela apontam para a raiz DE
// PROPOSITO ("Todos os modulos", "Sair"), e prefixa-los levaria a pessoa para
// dentro do modulo em vez de para o portal.
document.addEventListener('click',function(ev){
  var a=ev.target.closest&&ev.target.closest('a[href]');
  if(!a)return;
  if(a.closest('#ug-barra'))return;
  var bruto=a.getAttribute('href')||'';
  if(bruto.charAt(0)!=='/'||bruto.indexOf('//')===0)return;
  if(bruto.indexOf(BASE+'/')===0||bruto===BASE)return;
  a.setAttribute('href',BASE+bruto);
},true);

// Link criado e clicado por codigo, SEM ser posto na pagina:
//   var a=document.createElement('a'); a.href='/api/x'; a.click();
// E um jeito comum de disparar download. Nesse caso o evento nao sobe ate o
// documento, entao o tratador de clique acima nunca o ve.
//
// Hoje os modulos usam esse padrao so com blob: (arquivo montado na memoria do
// navegador), que nao precisa de prefixo — mas o dia em que um deles apontar
// para um caminho do servidor, o download quebraria em silencio, e a causa
// levaria horas para achar. Sao tres linhas para fechar o buraco.
if (window.HTMLAnchorElement){
  var _click=HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click=function(){
    var bruto=this.getAttribute&&this.getAttribute('href');
    if(bruto&&bruto.charAt(0)==='/'&&bruto.indexOf('//')!==0&&
       bruto.indexOf(BASE+'/')!==0&&bruto!==BASE){
      this.setAttribute('href',BASE+bruto);
    }
    return _click.apply(this,arguments);
  };
}

// window.open com caminho da raiz cai no mesmo buraco — e e como varios
// sistemas abrem recibo, anexo e relatorio em outra aba.
if(window.open){
  var _open=window.open;
  window.open=function(u){
    var args=Array.prototype.slice.call(arguments);
    args[0]=pfx(u);
    return _open.apply(window,args);
  };
}

// Imagens que o modulo monta em tempo de execucao escapam da reescrita feita
// no HTML: quando o proprio JS gera <img src="/assets/logo.png">, esse trecho
// nunca passou pela Fachada, e o navegador vai buscar na raiz do dominio — no
// Core — onde o arquivo nao existe. Resultado: logo quebrado.
// Corrigido no momento da falha, uma tentativa por elemento.
// A fase de captura e obrigatoria: erro de carregamento de recurso nao borbulha.
document.addEventListener('error',function(ev){
  var el=ev.target;
  if(!el||el.tagName!=='IMG')return;
  var bruto=el.getAttribute('src')||'';
  if(bruto.charAt(0)!=='/'||bruto.indexOf('//')===0)return;
  if(bruto.indexOf(BASE+'/')===0)return;
  if(el.getAttribute('data-ug-tentado'))return;
  el.setAttribute('data-ug-tentado','1');
  el.setAttribute('src',BASE+bruto);
},true);
})();`;

// O simbolo vai escrito aqui, nao lido de public/marca/.
//
// A Fachada e publicada com a PROPRIA pasta na raiz do container: dentro dele
// server.js e /app/server.js, e `../public` aponta para /public, que nao
// existe. Ler do disco derrubou o servico inteiro na subida — o processo morre
// antes de escutar a porta, entao nao e um icone faltando, e o portal fora do
// ar. Mesmo motivo pelo qual SHIM_JS e BARRA_CSS tambem sao literais.
//
// Se o desenho mudar em public/marca/simbolo-claro.svg, atualizar aqui junto.
// Sao ~700 bytes; a alternativa (copiar a pasta no build) custaria mais do que
// resolve.
const MARCA_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64" role="img" aria-label="UniGestão"><defs><linearGradient id="ugGrad" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="58"><stop offset="0" stop-color="#F7B312"/><stop offset=".55" stop-color="#F7B312"/><stop offset=".72" stop-color="#EC7807"/><stop offset="1" stop-color="#EC7807"/></linearGradient><mask id="ugCavidade"><rect width="64" height="64" fill="#fff"/><circle cx="53" cy="28.8" r="3.7" fill="#000"/></mask></defs><g fill="none" stroke="url(#ugGrad)"><path d="M11 6 V34 A21 21 0 0 0 53 34 V30" stroke-width="7"/><path d="M17.5 6 V34 A14.5 14.5 0 0 0 46.5 34 V30" stroke-width="3.2"/><path d="M24 6 V34 A8 8 0 0 0 40 34 V30" stroke-width="2.8"/></g><circle cx="53" cy="30" r="3" fill="#EC7807"/><g fill="#ffffff" mask="url(#ugCavidade)"><rect x="49.5" y="6" width="7" height="22.8" rx="3.5"/><rect x="44.9" y="6" width="3.2" height="22.8" rx="1.6"/><rect x="38.6" y="6" width="2.8" height="22.8" rx="1.4"/></g></svg>`;

// A ALTURA DA BARRA NA PILHA (z-index) — 45, e nao um numero grande
//
// Com 9999 a barra pintava por cima dos modais dos modulos: no Precificacao o
// cabecalho do "Nome do Cargo" ficava escondido atras dela. Modal e modal — ele
// TEM que cobrir a barra do portal enquanto estiver aberto.
//
// 45 nao foi chutado. E o unico intervalo que serve para os seis sistemas ao
// mesmo tempo, levantado no codigo de cada um:
//
//   fica ABAIXO de (para o modal cobrir a barra):
//     Precificacao  50    modais (`fixed inset-0 z-50`, 26 telas)
//     CRM           60    lista suspensa    80  avisos
//     Documentos   100    caixas            200 aviso
//     Extra        100
//     Tarefas      900 · 950 · 998 · 999
//     Eventos     1000 · 9999
//
//   fica ACIMA de (para a barra nao sumir sob o conteudo que rola):
//     Documentos    20    cabecalho proprio, tambem grudado no topo
//     Tarefas       20    lista de mencoes
//     Extra         20
//     CRM           30    lista de notificacoes
//     Precificacao  40    barra de acoes de Disparo, tambem grudada no topo
//
// Ao plugar um sistema novo, conferir os z-index dele contra esta tabela.
// tests/barra-modal.test.js guarda o limite de cima, que e o que quebrou.
//
// Efeito colateral aceito: o menu "Trocar de modulo" abre dentro da barra,
// entao ele nao sobe acima de 45 por mais alto que seja o z-index dele. Se um
// dia um modulo desenhar algo entre 45 e o menu, e aqui que se resolve.
const BARRA_CSS = `#ug-barra{position:sticky;top:0;z-index:45;display:flex;align-items:center;gap:14px;
padding:7px 16px;background:#26357A;color:#fff;font:14px/1.4 'DM Sans',system-ui,sans-serif}
#ug-barra a{color:#fff;text-decoration:none;opacity:.9;cursor:pointer}
#ug-barra a:hover{opacity:1;text-decoration:underline}
/* sem gap: ele separaria "Uni" de "Gestão" — ver public/inicio.html */
#ug-barra .ug-marca{font-weight:600;display:flex;align-items:center}
#ug-barra .ug-marca img{width:22px;height:22px;margin-right:8px}
#ug-barra .ug-marca span{color:#F7B312}
#ug-barra .ug-dir{margin-left:auto;display:flex;gap:14px;align-items:center;font-size:13px}

/* Menu de troca de modulo. <details> nativo: sem script, sem CSP no caminho. */
#ug-barra .ug-troca{position:relative}
#ug-barra .ug-troca>summary{list-style:none;cursor:pointer;opacity:.9;
padding:3px 8px;border-radius:5px;user-select:none}
#ug-barra .ug-troca>summary::-webkit-details-marker{display:none}
#ug-barra .ug-troca>summary::after{content:" ▾";font-size:11px}
#ug-barra .ug-troca>summary:hover{opacity:1;background:rgba(255,255,255,.12)}
#ug-barra .ug-troca[open]>summary{background:rgba(255,255,255,.16);opacity:1}
#ug-barra .ug-menu{position:absolute;top:calc(100% + 6px);left:0;min-width:230px;
background:#fff;border-radius:8px;padding:6px;box-shadow:0 6px 20px rgba(16,24,40,.22);
display:flex;flex-direction:column;z-index:10000}
#ug-barra .ug-menu a{display:block;padding:8px 10px;border-radius:5px;
color:#26357A;opacity:1;font-size:13.5px;white-space:nowrap}
#ug-barra .ug-menu a:hover{background:#E9ECF6;text-decoration:none}
/* O modulo atual fica marcado e sem realce de clique: e para onde a pessoa ja
   esta, e um item que parece clicavel mas nao leva a lugar nenhum confunde. */
#ug-barra .ug-menu a.ug-aqui{color:#6b7280;font-weight:600;cursor:default}
#ug-barra .ug-menu a.ug-aqui:hover{background:none}
#ug-barra .ug-menu a.ug-todos{border-top:1px solid #eceff3;margin-top:4px;
padding-top:10px;color:#6b7280;font-size:13px}`;

// O menu de troca de modulo usa <details>/<summary>, nao JavaScript.
//
// Abrir e fechar e comportamento nativo do navegador: funciona com o teclado,
// funciona com leitor de tela e — o que importa aqui — nao depende de script.
// Modulos com politica estrita (o CRM manda `script-src 'self'`) bloqueiam
// qualquer manipulador inline, e um menu que nao abre e pior do que menu
// nenhum.
function menuModulos(base, lista) {
  if (!lista || lista.length < 2) {
    // Com um modulo so nao ha para onde trocar; o link de sempre basta.
    return `<a href="/">◂ Todos os módulos</a>`;
  }
  const itens = lista.map((m) => {
    // Sistema de terceiro sai do portal: abre em outra aba e leva o simbolo ↗
    // para a pessoa saber disso ANTES de clicar. Sem a aba nova ela perderia o
    // sistema em que estava, e a barra do portal nao existe do outro lado.
    if (m.externo) {
      return `<a href="${escapeHtml(m.externo)}" target="_blank" rel="noopener noreferrer">` +
             `${escapeHtml(m.nome)} ↗</a>`;
    }
    const aqui = m.base === base;
    return `<a href="${escapeHtml(m.base)}/"${aqui ? ' class="ug-aqui" aria-current="page"' : ""}>` +
           `${escapeHtml(m.nome)}${aqui ? " ·" : ""}</a>`;
  }).join("\n    ");
  return `<details class="ug-troca">
  <summary>Trocar de módulo</summary>
  <div class="ug-menu">
    ${itens}
    <a class="ug-todos" href="/">◂ Todos os módulos</a>
  </div>
</details>`;
}

function shim(base, usuario, listaModulos) {
  const dados = escapeHtml(JSON.stringify(usuario));
  return `<link rel="stylesheet" href="${base}/__ug/barra.css">
<script src="${base}/__ug/shim.js" data-base="${escapeHtml(base)}" data-usuario="${dados}"></script>
<div id="ug-barra">
  <a class="ug-marca" href="/"><img src="${base}/__ug/marca.svg" alt="" width="22" height="22">Uni<span>Gestão</span></a>
  ${menuModulos(base, listaModulos)}
  <div class="ug-dir"><span>${escapeHtml(usuario.nome || "")}</span>
  <a id="ug-sair" href="/">Sair</a></div>
</div>`;
}

function paraOLogin(res, destino) {
  // So caminho interno vira destino: precisa comecar com uma barra e o
  // caractere seguinte nao pode ser outra barra nem contrabarra. Sem esse
  // corte, "//site.com" e "/\site.com" passariam e o portal viraria trampolim
  // para levar gente a qualquer endereco — o proprio dominio do login dando
  // credibilidade ao golpe.
  const seguro = typeof destino === "string" && /^\/[^/\\]/.test(destino);
  const local = seguro ? "/?ir=" + encodeURIComponent(destino) : "/";
  res.writeHead(302, { location: local });
  return res.end();
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// Acrescenta o prefixo do modulo aos caminhos absolutos de src/href/action.
//   <script src="/app.js">  ->  <script src="/operacional/app.js">
// Deixa em paz o que ja esta prefixado e os enderecos externos ("//cdn...").
function prefixarCaminhos(html, base) {
  const jaPrefixado = new RegExp(`^${base}(/|$)`);
  return html.replace(
    /(\s(?:src|href|action)\s*=\s*)(["'])(\/(?!\/)[^"']*)\2/gi,
    (inteiro, atributo, aspas, caminho) =>
      jaPrefixado.test(caminho) ? inteiro : `${atributo}${aspas}${base}${caminho}${aspas}`
  );
}

// ---------------------------------------------------------------------------
// Proxy
// ---------------------------------------------------------------------------

// Quantos proxies existem na FRENTE da Fachada. Na Railway sao DOIS — medido,
// nao suposto (31/08/2026): tres requisicoes de fora, mandando 0, 1 e 2
// enderecos inventados, chegaram todas com exatamente 2 valores na lista. Ou
// seja, a borda da Railway DESCARTA o que o cliente escreve e monta a lista
// sozinha, com dois saltos.
//
// Como cada proxy acrescenta no fim o endereco de quem falou com ele, o cliente
// e o valor 2 contado da direita — o primeiro, hoje. Contar da direita, em vez
// de pegar o primeiro direto, e o que mantem a conta certa se um dia a borda
// deixar de descartar: os enderecos inventados entrariam a esquerda e o cliente
// continuaria na mesma posicao a partir do fim.
//
// Rodando direto na sua maquina, sem proxy nenhum, o certo e
// PROXIES_NA_FRENTE=0: ai a lista inteira e invencao e vale a conexao.
//
// O numero e configuracao e nao deteccao automatica porque e a unica coisa que
// separa o endereco escrito pela infraestrutura do escrito por quem chama. Se um
// dia a Railway mudar a topologia, o log abaixo mostra a nova forma.
const PROXIES_NA_FRENTE = process.env.PROXIES_NA_FRENTE !== undefined
  ? Math.max(0, Number(process.env.PROXIES_NA_FRENTE) || 0)
  : 2;

// O endereco de quem realmente abriu a conexao.
//
// O X-Forwarded-For e uma lista e a ordem importa: cada proxy ACRESCENTA no fim
// o endereco de quem falou com ele. Entao os ultimos valores foram escritos
// pela infraestrutura e valem; tudo o que vem antes foi escrito por quem chamou
// e nao vale nada — pode ser invencao.
//
// Contar os saltos e o que separa um do outro, e por isso o numero e
// configuracao e nao adivinhacao: com um proxy na frente, o valor bom e o
// ultimo; com nenhum, a lista inteira e do cliente e deve ser jogada fora.
//
// Ler o PRIMEIRO valor — o que o Core fazia — e justamente o furo: quem quisesse
// burlar o teto de tentativas so precisava mandar um endereco novo a cada vez.
function ipDoCliente(req) {
  const daConexao = (req.socket && req.socket.remoteAddress) || "";
  if (PROXIES_NA_FRENTE === 0) return daConexao;

  const bruto = req.headers["x-forwarded-for"];
  const partes = bruto
    ? String(bruto).split(",").map((x) => x.trim()).filter(Boolean)
    : [];
  // Lista curta demais para o numero de saltos esperado: alguem esta chamando
  // por um caminho que nao e o previsto. Fica com a conexao.
  if (partes.length < PROXIES_NA_FRENTE) return daConexao;
  return partes[partes.length - PROXIES_NA_FRENTE];
}

// Algumas linhas, nas primeiras requisicoes de cada processo, para conferir o
// FORMATO que a Railway entrega — quantos saltos vem na frente. Sem isso o
// numero de proxies seria chute, e chutar para menos reabre o furo.
//
// Nenhum endereco e escrito: so a quantidade e o tipo de cada valor (publico ou
// privado). Tipo basta para ler a estrutura da lista e nao identifica ninguem.
const PRIVADO = /^(10\.|127\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|::1|::ffff:(10\.|127\.|192\.168\.)|f[cd])/i;
let aContar = 1;
function contarUmaVez(req) {
  if (aContar <= 0) return;
  aContar--;
  const bruto = req.headers["x-forwarded-for"];
  const partes = bruto
    ? String(bruto).split(",").map((x) => x.trim()).filter(Boolean)
    : [];
  const tipos = partes.map((x) => (PRIVADO.test(x) ? "privado" : "publico")).join(" | ");
  const daConexao = (req.socket && req.socket.remoteAddress) || "";
  console.log(`[fachada] x-forwarded-for: ${partes.length} valor(es) [${tipos}]; ` +
              `conexao: ${PRIVADO.test(daConexao) ? "privada" : "publica"}; ` +
              `ultimo == conexao? ${partes.length && partes[partes.length - 1] === daConexao}; ` +
              `proxies na frente: ${PROXIES_NA_FRENTE}`);
}

function encaminhar(req, res, destino, caminho, extras, injetar) {
  let alvo;
  try {
    alvo = new URL(caminho, destino);
  } catch (e) {
    return responder(res, 502, "Destino do módulo mal configurado");
  }

  const mod = alvo.protocol === "https:" ? https : http;
  const headers = { ...req.headers, ...extras };
  headers.host = alvo.host;
  delete headers["accept-encoding"]; // simplifica a injecao de HTML

  // A Fachada e a unica porta publica, entao e aqui que o endereco de quem
  // chamou para de ser palpite. O cabecalho e REESCRITO com um valor so — o
  // verdadeiro. O que o cliente tiver escrito e descartado, e nao repassado
  // para o Core nem para os modulos.
  //
  // Sem isto, qualquer um mandaria "x-forwarded-for: 1.2.3.4" e o Core contaria
  // a tentativa na conta de um endereco que nao existe.
  contarUmaVez(req);
  headers["x-forwarded-for"] = ipDoCliente(req);
  delete headers["x-real-ip"];               // idem: e do cliente, nao vale
  delete headers["x-envoy-external-address"];

  // Cabecalhos de identidade que venham DE FORA sao apagados antes de qualquer
  // coisa. Quem os escreve e a Fachada, logo abaixo, com `extras`. Sem esta
  // limpeza, um `x-ug-identidade` vindo do navegador chegaria ao modulo em
  // qualquer rota que nao monte `extras` — o Core, por exemplo.
  for (const nome of Object.keys(headers)) {
    if (nome.toLowerCase().startsWith("x-ug-") && !(nome in (extras || {}))) {
      delete headers[nome];
    }
  }

  // Numa navegacao de pagina, o navegador pode mandar "so me responda se
  // mudou" (if-none-match / if-modified-since) com o ETag que ele guardou. O
  // modulo entao responde 304 SEM CORPO — e sem corpo nao ha onde injetar a
  // barra: o navegador exibe a copia velha que tem em maos.
  //
  // Como so da para saber que a resposta e HTML depois que ela chega, o corte
  // e feito pelo pedido: navegacao de pagina (Accept com text/html) vai sempre
  // buscar o conteudo inteiro. Arquivo estatico — script, folha de estilo,
  // imagem — nao passa por aqui e continua aproveitando o cache normalmente,
  // que e onde o cache realmente importa.
  const querHtml = String(req.headers.accept || "").includes("text/html");
  if (querHtml && injetar) {
    delete headers["if-none-match"];
    delete headers["if-modified-since"];
  }

  const proxy = mod.request(
    {
      protocol: alvo.protocol,
      hostname: alvo.hostname,
      port: alvo.port || (alvo.protocol === "https:" ? 443 : 80),
      path: alvo.pathname + alvo.search,
      method: req.method,
      headers,
    },
    (r) => {
      const tipo = String(r.headers["content-type"] || "");
      const ehHtml = tipo.includes("text/html");

      // Redirecionamentos internos do modulo precisam manter o prefixo
      if (r.headers.location && r.headers.location.startsWith("/") && injetar) {
        r.headers.location = injetar.base + r.headers.location;
      }

      if (!ehHtml || !injetar) {
        res.writeHead(r.statusCode, r.headers);
        return r.pipe(res);
      }

      // HTML: acumula para reescrever os caminhos e injetar o shim e a barra
      const pedacos = [];
      r.on("data", (d) => pedacos.push(d));
      r.on("end", () => {
        let html = Buffer.concat(pedacos).toString("utf8");

        // Os modulos referenciam os proprios arquivos pela raiz:
        //   <script src="/app.js">   <link href="/styles.css">
        // Servidos sob /operacional, o navegador buscaria isso na raiz do
        // dominio — ou seja, no Core — e a pagina abriria em branco.
        //
        // O shim NAO resolve isto: ele intercepta fetch e XHR, mas src e href
        // sao resolvidos pelo navegador ao ler o HTML, antes de qualquer JS.
        // Por isso o caminho precisa ser reescrito aqui.
        //
        // Feito ANTES de injetar o bloco proprio, senao os links da barra
        // ("Todos os modulos", "Sair") seriam prefixados tambem — e eles
        // apontam para a raiz de proposito.
        html = prefixarCaminhos(html, injetar.base);

        const bloco = shim(injetar.base, injetar.usuario, injetar.modulos);
        if (/<body[^>]*>/i.test(html)) {
          html = html.replace(/<body[^>]*>/i, (m) => m + bloco);
        } else {
          html = bloco + html;
        }
        const corpo = Buffer.from(html, "utf8");
        const h = { ...r.headers };
        // O corpo mudou de tamanho: passa a ser uma resposta de tamanho fixo.
        // `transfer-encoding: chunked` e `content-length` juntos sao invalidos
        // em HTTP e o navegador recusa a resposta inteira.
        delete h["transfer-encoding"];

        // O corpo tambem deixou de ser o que o modulo gerou — e o ETag e o
        // Last-Modified que vieram com ele descrevem o ARQUIVO ORIGINAL, sem a
        // barra. Repassa-los e mentir para o navegador: na visita seguinte ele
        // pergunta "mudou?", o modulo responde "nao" (304, porque o arquivo
        // dele de fato nao mudou) e o navegador mostra a copia guardada — com
        // a barra velha dentro.
        //
        // Foi exatamente o que aconteceu quando o menu de trocar de modulo
        // entrou: apareceu na hora no CRM e na Movimentacao, que mandam
        // no-store, e nao apareceu em Eventos, Documentos, Tarefas e
        // Precificacao, que mandam ETag. O sintoma parecia ser do menu; a
        // causa estava aqui.
        delete h["etag"];
        delete h["last-modified"];
        h["cache-control"] = "no-store, must-revalidate";
        h["content-length"] = corpo.length;
        res.writeHead(r.statusCode, h);
        res.end(corpo);
      });
    }
  );

  proxy.on("error", (e) => {
    console.error("[fachada] erro ao falar com o módulo:", e.message);
    responder(res, 502, "Módulo indisponível no momento");
  });

  req.pipe(proxy);
}

function responder(res, status, msg) {
  const corpo = `<!doctype html><meta charset="utf-8">
<title>UniGestão</title>
<div style="font:16px/1.6 'DM Sans',system-ui,sans-serif;max-width:460px;margin:16vh auto;padding:0 24px;color:#1c1c1c">
  <h1 style="font-size:20px;color:#26357A;margin:0 0 8px">UniGestão</h1>
  <p style="color:#6b7280">${escapeHtml(msg)}</p>
  <p><a href="/" style="color:#26357A">Voltar ao início</a></p>
</div>`;
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(corpo);
}

// ---------------------------------------------------------------------------
// Servidor
// ---------------------------------------------------------------------------

const servidor = http.createServer(async (req, res) => {
  const caminho = req.url.split("?")[0];
  const partes = caminho.split("/").filter(Boolean);
  const primeiro = partes[0] || "";

  // Tudo que nao for prefixo de modulo vai para o Core
  if (!MODULOS[primeiro]) {
    return encaminhar(req, res, CORE, req.url, {}, null);
  }

  const modulo = primeiro;

  // Arquivos da propria Fachada: nunca vao para o modulo.
  if (caminho === `/${modulo}/__ug/shim.js`) {
    res.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-cache",
    });
    return res.end(SHIM_JS);
  }
  if (caminho === `/${modulo}/__ug/marca.svg`) {
    res.writeHead(200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "public, max-age=3600",
    });
    return res.end(MARCA_SVG);
  }
  if (caminho === `/${modulo}/__ug/barra.css`) {
    res.writeHead(200, {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "no-cache",
    });
    return res.end(BARRA_CSS);
  }

  // Remove o prefixo do modulo antes de decidir o destino: /precificacao/api/x
  // vira /api/x, e e esse trecho que diz se vai para a API ou para a tela.
  const restoBruto = (req.url.slice(("/" + modulo).length) || "/").split("?")[0];
  const destino = destinoDe(modulo, restoBruto);
  if (!destino) {
    return responder(res, 503, "Este módulo ainda não foi conectado ao UniGestão.");
  }

  // Quem chega sem sessao vai para o login levando junto o destino.
  //
  // Sem isto, clicar em "Ver no sistema" num e-mail de notificacao levava a
  // pessoa ao login e, depois de entrar, a tela de modulos — nao a tarefa que
  // ela queria ver. Dois cliques a mais, toda vez, para 44 pessoas.
  //
  // So caminho interno entra no parametro: sem "//" no comeco e sem esquema,
  // senao o portal viraria trampolim para levar gente a qualquer site.
  const token = lerCookie(req);
  if (!token) return paraOLogin(res, req.url);

  const quem = await identificar(token, modulo);

  if (quem.erro === 401) return paraOLogin(res, req.url);
  if (quem.erro === 403) {
    return responder(res, 403, "Você não tem acesso a este módulo. Fale com o administrador.");
  }
  if (quem.erro) {
    return responder(res, 503, "Não foi possível validar seu acesso agora. Tente novamente.");
  }

  // A identidade vai ASSINADA, num cabecalho so: `x-ug-identidade`. Assinada
  // significa que os campos andam lacrados juntos — mexer no papel ou no
  // super-admin invalida o conjunto inteiro. O bilhete vale dois minutos, vale
  // para ESTE modulo e tem numero unico, entao nao serve para guardar e usar
  // depois nem para apresentar em outra porta.
  //
  // Os cabecalhos soltos NAO vao mais — nem o `x-ug-key`, que era o segredo
  // viajando em toda requisicao para todo modulo (01/09/2026, depois que os seis
  // passaram a exigir assinatura). E o que faz o segredo parar de circular: hoje
  // ele so existe nas variaveis de ambiente de cada servico.
  //
  // `x-ug-base` fica: e o prefixo publico do modulo ("/eventos"), serve para
  // montar link, nao decide acesso nenhum.
  const bilhete = identidade.assinar({
    id: quem.id,
    nome: quem.nome || "",
    email: quem.email || "",
    papel: quem.papel || "",
    departamento: quem.departamento || "",
    superAdmin: quem.superAdmin,
    modulo,
  });

  const extras = { "x-ug-base": "/" + modulo };
  if (bilhete) extras[identidade.CABECALHO] = bilhete;

  // Remove o prefixo antes de repassar: /eventos/api/x  ->  /api/x
  const resto = req.url.slice(("/" + modulo).length) || "/";
  encaminhar(req, res, destino, resto, extras, {
    base: "/" + modulo,
    // O que o modulo enxerga em window.UNIGESTAO.usuario. Deliberadamente
    // enxuto: e contrato com codigo de terceiro, entao so entra aqui o que o
    // modulo realmente usa.
    usuario: { id: quem.id, nome: quem.nome, email: quem.email, papel: quem.papel },
    // A lista de modulos vai por fora, so para a barra montar o menu de troca.
    // Fora do data-usuario de proposito: nenhum modulo precisa saber a que
    // outros sistemas a pessoa tem acesso.
    modulos: quem.modulos || [],
  });
});

// "::" cobre IPv6 e IPv4 mapeado — exigido pela rede privada do Railway.
servidor.listen(PORT, "::", () => {
  console.log(`[fachada] ouvindo na porta ${PORT}`);
  console.log(`[fachada] Core em ${CORE}`);
  for (const [id, m] of Object.entries(MODULOS)) {
    console.log(`[fachada]   /${id} -> ${m.destino || "(nao conectado)"}`);
  }
});
