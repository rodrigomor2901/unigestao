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

const BARRA_CSS = `#ug-barra{position:sticky;top:0;z-index:9999;display:flex;align-items:center;gap:14px;
padding:7px 16px;background:#26357A;color:#fff;font:14px/1.4 'DM Sans',system-ui,sans-serif}
#ug-barra a{color:#fff;text-decoration:none;opacity:.9;cursor:pointer}
#ug-barra a:hover{opacity:1;text-decoration:underline}
#ug-barra .ug-marca{font-weight:600;display:flex;align-items:center;gap:8px}
#ug-barra .ug-marca img{width:22px;height:22px}
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

  const token = lerCookie(req);
  if (!token) {
    res.writeHead(302, { location: "/" });
    return res.end();
  }

  const quem = await identificar(token, modulo);

  if (quem.erro === 401) {
    res.writeHead(302, { location: "/" });
    return res.end();
  }
  if (quem.erro === 403) {
    return responder(res, 403, "Você não tem acesso a este módulo. Fale com o administrador.");
  }
  if (quem.erro) {
    return responder(res, 503, "Não foi possível validar seu acesso agora. Tente novamente.");
  }

  // A identidade vai em cabecalhos. O modulo confia neles porque so a Fachada
  // alcanca a rede privada — e confere a chave compartilhada.
  const extras = {
    "x-ug-key": CHAVE,
    "x-ug-id": quem.id,
    "x-ug-nome": encodeURIComponent(quem.nome || ""),
    "x-ug-email": quem.email || "",
    "x-ug-papel": quem.papel || "",
    "x-ug-super": quem.superAdmin ? "1" : "0",
    "x-ug-base": "/" + modulo,
  };

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
