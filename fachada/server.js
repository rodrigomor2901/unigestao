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
const MODULOS = {
  operacional:  { destino: process.env.URL_OPERACIONAL  || "" },
  documentos:   { destino: process.env.URL_DOCUMENTOS   || "" },
  eventos:      { destino: process.env.URL_EVENTOS      || "" },
  tarefas:      { destino: process.env.URL_TAREFAS      || "" },
  crm:          { destino: process.env.URL_CRM          || "" },
  precificacao: { destino: process.env.URL_PRECIFICACAO || "" },
};

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

function shim(base, usuario) {
  return `<script>(function(){
var BASE=${JSON.stringify(base)};
window.UNIGESTAO={base:BASE,usuario:${JSON.stringify(usuario)}};
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
})();</script>
<style>
#ug-barra{position:sticky;top:0;z-index:9999;display:flex;align-items:center;gap:14px;
padding:7px 16px;background:#1B3A6B;color:#fff;font:14px/1.4 'DM Sans',system-ui,sans-serif}
#ug-barra a{color:#fff;text-decoration:none;opacity:.9}
#ug-barra a:hover{opacity:1;text-decoration:underline}
#ug-barra .ug-marca{font-weight:600}
#ug-barra .ug-marca span{color:#F5820A}
#ug-barra .ug-dir{margin-left:auto;display:flex;gap:14px;align-items:center;font-size:13px}
</style>
<div id="ug-barra">
  <a class="ug-marca" href="/">Uni<span>Gestão</span></a>
  <a href="/">◂ Todos os módulos</a>
  <div class="ug-dir"><span>${escapeHtml(usuario.nome || "")}</span>
  <a href="/api/logout" onclick="event.preventDefault();fetch('/api/logout',{method:'POST'}).then(function(){location.href='/'})">Sair</a></div>
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

        const bloco = shim(injetar.base, injetar.usuario);
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
  <h1 style="font-size:20px;color:#1B3A6B;margin:0 0 8px">UniGestão</h1>
  <p style="color:#6b7280">${escapeHtml(msg)}</p>
  <p><a href="/" style="color:#1B3A6B">Voltar ao início</a></p>
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
  const destino = MODULOS[modulo].destino;
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
    usuario: { id: quem.id, nome: quem.nome, email: quem.email, papel: quem.papel },
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
