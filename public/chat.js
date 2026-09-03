/* ==========================================================================
   COMUNICADOR INTERNO — a tela
   --------------------------------------------------------------------------
   Um arquivo so, carregado em dois lugares diferentes:

     - nas telas do portal, direto de /chat.js
     - dentro dos seis modulos, injetado pela Fachada junto com a barra

   E por isso que ele vive num canto fixo da tela e nao no meio da pagina: o
   chat acompanha a pessoa quando ela troca de sistema. Comeca no CRM, continua
   nas Tarefas, e a mesma conversa.

   Duas regras que valem para tudo aqui dentro, por causa dos modulos com
   politica de seguranca estrita (o CRM manda "script-src 'self'"):
     1. nenhum estilo embutido — a aparencia esta toda em chat.css
     2. nenhum onclick no HTML — os eventos sao ligados por addEventListener
   ========================================================================== */
(function () {
  "use strict";

  // Onde chamar a API.
  //
  // Dentro de um modulo a pagina esta sob /<modulo>/, e o UniGestao expoe o
  // chat em /<modulo>/__ug/chat/*. No portal e /api/chat direto. Montar o
  // caminho aqui — e nao confiar no atalho que corrige enderecos — faz o
  // <img src> do print funcionar igual ao fetch, que e o que quebraria calado.
  var BASE = (window.UNIGESTAO && window.UNIGESTAO.base) || "";
  var API = BASE ? BASE + "/__ug/chat" : "/api/chat";

  var LIMITE_BYTES = 1200 * 1024;   // igual ao teto do servidor (core/chat.js)

  var pessoas = [];
  var atual = null;                 // com quem estou falando
  var conversaId = null;
  var anexo = null;                 // { dados: base64, tipo, previa }
  var tituloOriginal = document.title;
  var fluxo = null;
  var caixa, lista, balas, selo, aviso, botaoEnviar, painelBusca, lupa, anexoBarra;

  // ---------------------------------------------------------------- utilidades
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function hora(iso) {
    var d = new Date(iso);
    return ("0" + d.getHours()).slice(-2) + ":" + ("0" + d.getMinutes()).slice(-2);
  }

  function dia(iso) {
    var d = new Date(iso);
    var hoje = new Date();
    var ontem = new Date(Date.now() - 86400000);
    var igual = function (a, b) { return a.toDateString() === b.toDateString(); };
    if (igual(d, hoje)) return "Hoje";
    if (igual(d, ontem)) return "Ontem";
    return d.toLocaleDateString("pt-BR");
  }

  function iniciais(nome) {
    var p = String(nome || "?").trim().split(/\s+/);
    return (p[0] || "?").charAt(0).toUpperCase() + (p.length > 1 ? p[p.length - 1].charAt(0).toUpperCase() : "");
  }

  function api(caminho, opcoes) {
    return fetch(API + caminho, Object.assign({ headers: { accept: "application/json" } }, opcoes || {}));
  }

  // ------------------------------------------------------------------- montagem
  function montar() {
    var raiz = document.createElement("div");
    raiz.id = "ug-chat";
    raiz.innerHTML = [
      '<div class="ug-painel">',
      '  <div class="ug-topo">',
      '    <button class="ug-icone ug-voltar" title="Voltar" hidden>&#8592;</button>',
      '    <div><b class="ug-titulo">Conversas</b><span class="ug-sub"></span></div>',
      '    <button class="ug-icone ug-empurra ug-fechar" title="Fechar">&#215;</button>',
      "  </div>",
      '  <div class="ug-busca"><input type="text" placeholder="Buscar pessoa..."></div>',
      '  <div class="ug-lista"></div>',
      '  <div class="ug-conversa">',
      '    <div class="ug-balas"></div>',
      '    <div class="ug-anexo"><img alt=""><span></span><button type="button">remover</button></div>',
      '    <div class="ug-aviso"></div>',
      '    <div class="ug-escrever">',
      '      <button class="ug-clipe" title="Anexar print (ou cole com Ctrl+V)">&#128206;</button>',
      '      <input type="file" class="ug-arquivo" accept="image/png,image/jpeg,image/webp">',
      '      <textarea rows="1" placeholder="Escreva ou cole um print..."></textarea>',
      '      <button class="ug-enviar">Enviar</button>',
      "    </div>",
      "  </div>",
      "</div>",
      '<div class="ug-canto">',
      '  <button class="ug-abrir" title="Conversas">&#128172;</button>',
      '  <span class="ug-selo"></span>',
      "</div>",
      '<div class="ug-lupa"><img alt="Print"></div>',
    ].join("\n");
    document.body.appendChild(raiz);

    lista = raiz.querySelector(".ug-lista");
    balas = raiz.querySelector(".ug-balas");
    caixa = raiz.querySelector("textarea");
    selo = raiz.querySelector(".ug-selo");
    aviso = raiz.querySelector(".ug-aviso");
    botaoEnviar = raiz.querySelector(".ug-enviar");
    painelBusca = raiz.querySelector(".ug-busca input");
    lupa = raiz.querySelector(".ug-lupa");
    anexoBarra = raiz.querySelector(".ug-anexo");

    raiz.querySelector(".ug-abrir").addEventListener("click", alternar);
    raiz.querySelector(".ug-fechar").addEventListener("click", function () { abrirPainel(false); });
    raiz.querySelector(".ug-voltar").addEventListener("click", voltarParaLista);
    raiz.querySelector(".ug-clipe").addEventListener("click", function () {
      raiz.querySelector(".ug-arquivo").click();
    });
    raiz.querySelector(".ug-arquivo").addEventListener("change", function (ev) {
      if (ev.target.files && ev.target.files[0]) prepararImagem(ev.target.files[0]);
      ev.target.value = "";
    });
    anexoBarra.querySelector("button").addEventListener("click", limparAnexo);
    botaoEnviar.addEventListener("click", enviar);
    painelBusca.addEventListener("input", desenharLista);
    lupa.addEventListener("click", function () { lupa.classList.remove("tem"); });

    caixa.addEventListener("keydown", function (ev) {
      // Enter manda; Shift+Enter pula linha. E o que todo mundo ja espera de
      // qualquer comunicador, e quem escreve texto longo usa o Shift.
      if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); enviar(); }
    });
    caixa.addEventListener("input", function () {
      caixa.style.height = "auto";
      caixa.style.height = Math.min(90, caixa.scrollHeight) + "px";
    });

    // Colar print direto na caixa — e assim que a maioria manda tela: Print
    // Screen e Ctrl+V, sem passar por arquivo.
    caixa.addEventListener("paste", function (ev) {
      var itens = (ev.clipboardData && ev.clipboardData.items) || [];
      for (var i = 0; i < itens.length; i++) {
        if (itens[i].type && itens[i].type.indexOf("image/") === 0) {
          var arquivo = itens[i].getAsFile();
          if (arquivo) { ev.preventDefault(); prepararImagem(arquivo); return; }
        }
      }
    });

    return raiz;
  }

  var raiz = null;

  function alternar() { abrirPainel(!raiz.classList.contains("aberto")); }

  function abrirPainel(abrir) {
    raiz.classList.toggle("aberto", Boolean(abrir));
    if (abrir) { carregarPessoas(); if (atual) marcarLido(); }
  }

  function voltarParaLista() {
    atual = null;
    conversaId = null;
    raiz.classList.remove("na-conversa");
    raiz.querySelector(".ug-voltar").hidden = true;
    raiz.querySelector(".ug-titulo").textContent = "Conversas";
    raiz.querySelector(".ug-sub").textContent = "";
    limparAnexo();
    carregarPessoas();
  }

  // --------------------------------------------------------------------- lista
  function carregarPessoas() {
    return api("/pessoas")
      .then(function (r) {
        if (r.status === 401) { desligar(); return null; }
        return r.ok ? r.json() : null;
      })
      .then(function (d) {
        if (!d) return;
        pessoas = d.pessoas || [];
        desenharLista();
        atualizarSelo();
      })
      .catch(function () { /* sem rede: a proxima batida tenta de novo */ });
  }

  function desenharLista() {
    var filtro = (painelBusca.value || "").trim().toLowerCase();
    var mostrar = pessoas.filter(function (p) {
      if (!filtro) return true;
      return (p.nome + " " + p.departamento + " " + p.cargo).toLowerCase().indexOf(filtro) >= 0;
    });

    if (!mostrar.length) {
      lista.innerHTML = '<div class="ug-vazio">Ninguém encontrado.</div>';
      return;
    }

    lista.innerHTML = mostrar.map(function (p) {
      var previa = "";
      if (p.ultima) {
        if (p.ultima.apagada) previa = "mensagem apagada";
        else if (p.ultima.temImagem && !p.ultima.texto) previa = "📷 print";
        else previa = p.ultima.texto;
        if (p.ultima.minha) previa = "Você: " + previa;
      } else {
        previa = p.departamento || p.cargo || "";
      }
      return [
        '<button class="ug-pessoa" data-id="' + esc(p.id) + '">',
        '  <span class="ug-foto"' + (p.temFoto ? ' data-foto="' + esc(p.id) + '"' : "") + ">",
        '    <span class="ug-iniciais">' + esc(iniciais(p.nome)) + "</span>",
        '    <span class="ug-luz' + (p.online ? " on" : "") + '"></span>',
        "  </span>",
        '  <span class="ug-quem">',
        '    <span class="ug-nome">' + esc(p.nome) + "</span>",
        '    <span class="ug-previa">' + esc(previa) + "</span>",
        "  </span>",
        p.naoLidas ? '<span class="ug-conta">' + p.naoLidas + "</span>" : "",
        "</button>",
      ].join("");
    }).join("");

    Array.prototype.forEach.call(lista.querySelectorAll(".ug-pessoa"), function (b) {
      b.addEventListener("click", function () {
        var p = pessoas.filter(function (x) { return x.id === b.getAttribute("data-id"); })[0];
        if (p) abrirConversa(p);
      });
    });
    carregarFotos(lista);
  }

  // A foto entra como fundo depois de carregar, e nao direto no HTML: um <img>
  // ainda em branco no meio da lista fica pior do que as iniciais. So quem tem
  // foto e pedido — quem nao tem fica nas iniciais e nao gera pedido nenhum.
  function carregarFotos(onde) {
    Array.prototype.forEach.call(onde.querySelectorAll("[data-foto]"), function (el) {
      var id = el.getAttribute("data-foto");
      var img = new Image();
      img.onload = function () {
        // Trocar so as iniciais pela foto. Limpar o elemento inteiro levaria
        // junto a bolinha de online, que e irma delas aqui dentro.
        el.style.backgroundImage = "url(" + API + "/foto/" + encodeURIComponent(id) + ")";
        var ini = el.querySelector(".ug-iniciais");
        if (ini) ini.remove();
      };
      img.src = API + "/foto/" + encodeURIComponent(id);
    });
  }

  // ------------------------------------------------------------------ conversa
  function abrirConversa(pessoa) {
    atual = pessoa;
    raiz.classList.add("na-conversa");
    raiz.querySelector(".ug-voltar").hidden = false;
    raiz.querySelector(".ug-titulo").textContent = pessoa.nome;
    raiz.querySelector(".ug-sub").textContent =
      (pessoa.online ? "online" : "offline") + (pessoa.departamento ? " · " + pessoa.departamento : "");
    balas.innerHTML = '<div class="ug-vazio">Carregando...</div>';

    api("/com/" + encodeURIComponent(pessoa.id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) { balas.innerHTML = '<div class="ug-vazio">Não consegui abrir a conversa.</div>'; return; }
        conversaId = d.conversaId;
        balas.innerHTML = "";
        ultimoDia = "";
        if (!d.mensagens.length) {
          balas.innerHTML = '<div class="ug-vazio">Nenhuma mensagem ainda.</div>';
        }
        d.mensagens.forEach(function (m) { acrescentar(m); });
        rolar();
        pessoa.naoLidas = 0;
        atualizarSelo();
        caixa.focus();
      });
  }

  var ultimoDia = "";

  function acrescentar(m) {
    var vazio = balas.querySelector(".ug-vazio");
    if (vazio) vazio.remove();

    // "Hoje", "Ontem", a data — uma vez por dia, nao a cada mensagem.
    var d = dia(m.em);
    if (d !== ultimoDia) {
      var sep = document.createElement("div");
      sep.className = "ug-dia";
      sep.textContent = d;
      balas.appendChild(sep);
      ultimoDia = d;
    }

    var el = document.createElement("div");
    el.className = "ug-bala " + (m.minha ? "minha" : "deles") + (m.apagada ? " apagada" : "");
    el.setAttribute("data-id", m.id);

    var partes = [];
    if (m.sobre) {
      var alvo = m.link ? (BASE && m.link.indexOf(BASE) !== 0 ? BASE + m.link : m.link) : null;
      partes.push(alvo
        ? '<a class="ug-sobre" href="' + esc(alvo) + '">Sobre: ' + esc(m.sobre) + "</a>"
        : '<span class="ug-sobre">Sobre: ' + esc(m.sobre) + "</span>");
    }
    if (m.apagada) {
      partes.push('<div class="ug-txt">mensagem apagada</div>');
    } else {
      if (m.texto) partes.push('<div class="ug-txt">' + esc(m.texto) + "</div>");
      if (m.temImagem) {
        partes.push('<img class="ug-print" alt="print" src="' + API + "/mensagem/" + m.id + '/imagem">');
      }
      if (m.minha) partes.push('<button class="ug-apagar" title="Apagar">&#128465;</button>');
    }
    partes.push('<div class="ug-hora">' + hora(m.em) + "</div>");
    el.innerHTML = partes.join("");

    var print = el.querySelector(".ug-print");
    if (print) {
      print.addEventListener("click", function () {
        lupa.querySelector("img").src = print.src;
        lupa.classList.add("tem");
      });
    }
    var apagar = el.querySelector(".ug-apagar");
    if (apagar) apagar.addEventListener("click", function () { apagarMensagem(m.id, el); });

    balas.appendChild(el);
  }

  function rolar() { balas.scrollTop = balas.scrollHeight; }

  function apagarMensagem(id, el) {
    if (!window.confirm("Apagar esta mensagem?")) return;
    api("/mensagem/" + id, { method: "DELETE" }).then(function (r) {
      if (!r.ok) return;
      el.classList.add("apagada");
      var txt = el.querySelector(".ug-txt");
      if (txt) txt.textContent = "mensagem apagada"; else el.insertAdjacentHTML("afterbegin", '<div class="ug-txt">mensagem apagada</div>');
      var img = el.querySelector(".ug-print");
      if (img) img.remove();
      var bt = el.querySelector(".ug-apagar");
      if (bt) bt.remove();
    });
  }

  // -------------------------------------------------------------------- enviar
  function mostrarAviso(texto) {
    aviso.textContent = texto || "";
    aviso.classList.toggle("tem", Boolean(texto));
  }

  function enviar() {
    if (!atual) return;
    var texto = caixa.value.trim();
    if (!texto && !anexo) return;

    botaoEnviar.disabled = true;
    mostrarAviso("");

    var corpo = { texto: texto };
    if (anexo) { corpo.imagem = anexo.dados; corpo.imagemTipo = anexo.tipo; }
    if (pendenteSobre) { corpo.sobre = pendenteSobre.sobre; corpo.link = pendenteSobre.link; }

    api("/com/" + encodeURIComponent(atual.id), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(corpo),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        botaoEnviar.disabled = false;
        if (!res.ok) { mostrarAviso(res.d.erro || "Não consegui enviar."); return; }
        conversaId = res.d.conversaId;
        caixa.value = "";
        caixa.style.height = "auto";
        limparAnexo();
        pendenteSobre = null;
        acrescentar(res.d.mensagem);
        rolar();
      })
      .catch(function () {
        botaoEnviar.disabled = false;
        mostrarAviso("Sem conexão. Tente de novo.");
      });
  }

  // ------------------------------------------------------------------- o print
  function limparAnexo() {
    anexo = null;
    anexoBarra.classList.remove("tem");
    anexoBarra.querySelector("img").removeAttribute("src");
  }

  // Reduz antes de mandar.
  //
  // Print de tela cheia costuma passar de 2 MB, e o servidor recusa em 1,2 MB.
  // Tenta PNG primeiro porque texto de print fica nitido; so cai para JPEG
  // quando o PNG nao couber — que e o unico jeito de aceitar tela de 4K sem
  // devolver "imagem muito grande" para quem so queria mostrar um erro.
  function prepararImagem(arquivo) {
    mostrarAviso("");
    var url = URL.createObjectURL(arquivo);
    var img = new Image();
    img.onload = function () {
      var maior = Math.max(img.width, img.height);
      var dados = null;
      var tipo = "image/png";

      [1600, 1600, 1280, 1024].forEach(function (limite, passo) {
        if (dados && cabe(dados)) return;
        var escala = Math.min(1, limite / maior);
        var cv = document.createElement("canvas");
        cv.width = Math.round(img.width * escala);
        cv.height = Math.round(img.height * escala);
        cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
        if (passo === 0) { dados = cv.toDataURL("image/png"); tipo = "image/png"; }
        else { dados = cv.toDataURL("image/jpeg", 0.82); tipo = "image/jpeg"; }
      });

      URL.revokeObjectURL(url);
      if (!dados || !cabe(dados)) { mostrarAviso("Print muito grande, mesmo reduzido."); return; }

      anexo = { dados: dados.split(",")[1], tipo: tipo, previa: dados };
      anexoBarra.querySelector("img").src = dados;
      anexoBarra.querySelector("span").textContent = "print anexado";
      anexoBarra.classList.add("tem");
      caixa.focus();
    };
    img.onerror = function () { mostrarAviso("Não consegui ler essa imagem."); };
    img.src = url;
  }

  function cabe(dataUrl) {
    var base64 = dataUrl.split(",")[1] || "";
    return base64.length * 0.75 <= LIMITE_BYTES;
  }

  // ---------------------------------------------------------------- tempo real
  function ligarFluxo() {
    if (!window.EventSource) return;      // navegador muito antigo: so o polling
    try {
      fluxo = new EventSource(API + "/stream");
    } catch (e) {
      return;
    }

    // Ao (re)conectar, recarrega: a conexao pode ter caido e mensagens desse
    // intervalo nao viriam pelo fluxo. Sem isto, uma queda de rede de 10
    // segundos faria a mensagem sumir para sempre — na tela de um lado so.
    fluxo.addEventListener("open", function () {
      carregarPessoas();
      if (atual) recarregarConversaAberta();
    });

    fluxo.addEventListener("mensagem", function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      chegou(d);
    });
  }

  function recarregarConversaAberta() {
    if (!atual) return;
    var quem = atual;
    api("/com/" + encodeURIComponent(quem.id))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d || !atual || atual.id !== quem.id) return;
        balas.innerHTML = "";
        ultimoDia = "";
        d.mensagens.forEach(function (m) { acrescentar(m); });
        rolar();
      });
  }

  function chegou(d) {
    var estaAberta = atual && d.outroId === atual.id && raiz.classList.contains("aberto");

    if (estaAberta) {
      if (!balas.querySelector('[data-id="' + d.mensagem.id + '"]')) {
        acrescentar(d.mensagem);
        rolar();
      }
      if (!d.mensagem.minha) marcarLido();
    }

    if (!d.mensagem.minha && !estaAberta) {
      pessoas.forEach(function (p) { if (p.id === d.outroId) p.naoLidas = (p.naoLidas || 0) + 1; });
      atualizarSelo();
      desenharLista();
      apitar();
    } else {
      carregarPessoas();
    }
  }

  function marcarLido() {
    if (!conversaId) return;
    api("/conversa/" + conversaId + "/lido", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    }).then(function () {
      if (atual) atual.naoLidas = 0;
      atualizarSelo();
    });
  }

  function atualizarSelo() {
    var total = pessoas.reduce(function (s, p) { return s + (p.naoLidas || 0); }, 0);
    selo.textContent = total > 99 ? "99+" : String(total);
    selo.classList.toggle("tem", total > 0);
    // O titulo da aba avisa quem esta em outra janela — sem isso o chat so
    // funciona para quem ja esta olhando para ele.
    document.title = total > 0 ? "(" + total + ") " + tituloOriginal : tituloOriginal;
  }

  // Um bip curto, gerado na hora. Arquivo de som seria mais bonito e traria
  // dois problemas: mais um pedido de rede e a politica de conteudo dos
  // modulos, que bloqueia midia de fora.
  function apitar() {
    try {
      var Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      var ctx = new Ctx();
      var osc = ctx.createOscillator();
      var vol = ctx.createGain();
      osc.frequency.value = 880;
      vol.gain.value = 0.06;
      osc.connect(vol); vol.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.12);
      setTimeout(function () { ctx.close(); }, 400);
    } catch (e) { /* navegador bloqueou som sem interacao: tudo bem */ }
  }

  function desligar() {
    if (fluxo) { fluxo.close(); fluxo = null; }
    if (raiz) raiz.remove();
  }

  // --------------------------------------------- "conversar sobre isto"
  // Deixa um assunto engatilhado: a proxima mensagem sai citando o item, com
  // link para ele. E o que amarra a conversa ao trabalho — e a diferenca entre
  // este chat e o WhatsApp que todo mundo ja tem no bolso.
  //
  // Os modulos chamam assim:
  //   window.UGChat.conversarSobre({ pessoaId: 'u123',
  //                                  sobre: 'Tarefa 4021 — troca de escala',
  //                                  link: '/tarefas/?id=4021' });
  var pendenteSobre = null;

  window.UGChat = {
    abrir: function () { abrirPainel(true); },
    conversarSobre: function (o) {
      o = o || {};
      pendenteSobre = { sobre: o.sobre || "", link: o.link || "" };
      abrirPainel(true);
      var achar = function () {
        var p = pessoas.filter(function (x) { return x.id === o.pessoaId; })[0];
        if (p) { abrirConversa(p); caixa.focus(); }
      };
      if (pessoas.length) achar(); else carregarPessoas().then(achar);
    },
  };

  // ------------------------------------------------------------------- inicio
  function comecar() {
    // A pagina de login nao tem chat. Testar pelo endereco seria frágil (a
    // Fachada serve o portal em varios caminhos); testar pela resposta da API
    // e o que realmente responde "esta pessoa esta logada?".
    api("/pessoas")
      .then(function (r) {
        if (!r.ok) return null;
        return r.json();
      })
      .then(function (d) {
        if (!d) return;
        raiz = montar();
        pessoas = d.pessoas || [];
        desenharLista();
        atualizarSelo();
        ligarFluxo();
        // Rede de seguranca: se o fluxo cair e o navegador demorar a reconectar,
        // a contagem ainda se atualiza sozinha.
        setInterval(function () { if (!document.hidden) carregarPessoas(); }, 60000);
      })
      .catch(function () { /* Core fora do ar: a pagina segue funcionando */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", comecar);
  } else {
    comecar();
  }
})();
