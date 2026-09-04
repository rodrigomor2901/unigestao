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

  // Modo janela: a mesma tela, ocupando uma janela so dela. Ver chat-janela.html.
  var MODO_JANELA = Boolean(document.body && document.body.getAttribute("data-janela"));

  var pessoas = [];
  var atual = null;                 // com quem estou falando
  var conversaId = null;
  var minhaSituacao = "online";     // online | ocupado | reuniao
  var abas = [];                    // conversas deixadas abertas, na ordem
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
      '    <div class="ug-cabeca"><b class="ug-titulo">Conversas</b><span class="ug-sub"></span></div>',
      '    <div class="ug-empurra ug-acoes">',
      '      <button class="ug-situacao" title="Sua situação"><i></i><span>Disponível</span></button>',
      '      <button class="ug-icone ug-janela" title="Abrir numa janela separada">&#9109;</button>',
      '      <button class="ug-icone ug-fechar" title="Fechar">&#215;</button>',
      "    </div>",
      "  </div>",
      '  <div class="ug-menu-situacao">',
      '    <button data-status="online"><i class="on"></i>Disponível</button>',
      '    <button data-status="ocupado"><i class="ocupado"></i>Ocupado <small>sem som</small></button>',
      '    <button data-status="reuniao"><i class="reuniao"></i>Em reunião <small>sem som</small></button>',
      "  </div>",
      '  <div class="ug-abas"></div>',
      '  <div class="ug-convite">',
      '    <span class="ug-convite-txt"></span>',
      '    <button class="ug-convite-sim">Ativar</button>',
      '    <button class="ug-convite-nao">Agora não</button>',
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
    raiz.querySelector(".ug-fechar").addEventListener("click", function () {
      // Na janela separada o "x" fecha a janela; embutido, fecha so o painel.
      if (MODO_JANELA) { try { window.close(); } catch (e) { /* nada */ } return; }
      abrirPainel(false);
    });
    raiz.querySelector(".ug-janela").addEventListener("click", abrirEmJanela);
    raiz.querySelector(".ug-situacao").addEventListener("click", function (ev) {
      ev.stopPropagation();
      raiz.classList.toggle("menu-aberto");
    });
    Array.prototype.forEach.call(raiz.querySelectorAll(".ug-menu-situacao button"), function (b) {
      b.addEventListener("click", function () {
        trocarSituacao(b.getAttribute("data-status"));
        raiz.classList.remove("menu-aberto");
      });
    });
    // Clicar em qualquer outro lugar fecha o menu — senao ele fica aberto por
    // cima da conversa e a pessoa acha que travou.
    document.addEventListener("click", function () { raiz.classList.remove("menu-aberto"); });
    raiz.querySelector(".ug-convite-sim").addEventListener("click", pedirPermissao);
    raiz.querySelector(".ug-convite-nao").addEventListener("click", function () {
      // Adia por uma semana, e nao para sempre: "para sempre" deixaria a pessoa
      // sem caminho de volta pela tela do sistema.
      guardar(CONVITE, String(Date.now() + 7 * 24 * 60 * 60 * 1000));
      mostrarConvite();
    });
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
    if (abrir) {
      carregarPessoas();
      if (atual) marcarLido();
      mostrarConvite();
    }
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

  // ------------------------------------------------------------------ situacao
  // Disponível / Ocupado / Em reunião.
  //
  // Ocupado e Em reunião calam o som e a caixinha para QUEM ESCOLHEU — e o
  // "nao perturbe". O contador continua subindo: a pessoa pediu para nao ser
  // interrompida, nao para deixar de saber que falaram com ela.
  function desenharSituacao() {
    var bt = raiz.querySelector(".ug-situacao");
    bt.className = "ug-situacao " + minhaSituacao;
    bt.querySelector("span").textContent = ROTULO[minhaSituacao] || "Disponível";
  }

  var ROTULO = { online: "Disponível", ocupado: "Ocupado", reuniao: "Em reunião", offline: "Offline" };

  function trocarSituacao(novo) {
    minhaSituacao = novo === "ocupado" || novo === "reuniao" ? novo : "online";
    desenharSituacao();
    api("/status", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: minhaSituacao === "online" ? null : minhaSituacao }),
    }).catch(function () { /* volta a valer na proxima carga da lista */ });
  }

  function calado() {
    // Nao perturbe da propria pessoa, ou existe uma janela separada aberta que
    // ja vai avisar por todos.
    return minhaSituacao !== "online" || temJanelaAberta();
  }

  // ------------------------------------------------------- janela separada
  // Uma janela do navegador so com o chat, para deixar de lado enquanto se
  // trabalha em outra coisa — inclusive fora do UniGestao.
  function abrirEmJanela() {
    var janela = window.open("/chat", "ug-chat-janela",
                             "width=430,height=680,menubar=no,toolbar=no,location=no");
    if (!janela) {
      mostrarAviso("O navegador bloqueou a janela. Libere os pop-ups deste site.");
      return;
    }
    try { janela.focus(); } catch (e) { /* nada */ }
    if (!MODO_JANELA) abrirPainel(false);
  }

  // As janelas conversam entre si.
  //
  // Sem isto, com a janela separada aberta a pessoa ouviria DOIS bips e veria
  // duas caixinhas por mensagem — uma de cada aba do UniGestao que estivesse
  // aberta. A janela avisa que esta viva; as telas embutidas ficam quietas e
  // deixam o aviso para ela.
  var canal = null;
  var janelaVistaEm = 0;
  try { canal = new window.BroadcastChannel("ug-chat"); } catch (e) { canal = null; }

  function temJanelaAberta() {
    return !MODO_JANELA && Date.now() - janelaVistaEm < 12000;
  }

  if (canal) {
    canal.onmessage = function (ev) {
      var d = ev && ev.data;
      if (!d) return;
      if (d.tipo === "janela-viva") janelaVistaEm = Date.now();
      // Leu numa janela, o contador cai nas outras.
      if (d.tipo === "mexeu") carregarPessoas();
    };
  }

  function avisarAsOutras(tipo) {
    if (canal) { try { canal.postMessage({ tipo: tipo }); } catch (e) { /* nada */ } }
  }

  // ---------------------------------------------------------------------- abas
  // Conversas deixadas abertas, para trocar sem voltar para a lista.
  //
  // Ficam guardadas no navegador, e nao no servidor: sao arranjo de tela desta
  // maquina. Quem abre no computador e no celular nao quer as mesmas abas nos
  // dois — quer as conversas que estava usando ali.
  var ABAS = "ug_chat_abas";
  var ABAS_MAX = 8;

  function guardarAbas() {
    guardar(ABAS, JSON.stringify(abas.map(function (a) { return a.id; })));
  }

  function restaurarAbas() {
    var ids = [];
    try { ids = JSON.parse(ler(ABAS) || "[]"); } catch (e) { ids = []; }
    if (!Array.isArray(ids)) return;
    abas = ids.map(function (id) {
      var p = pessoas.filter(function (x) { return x.id === id; })[0];
      // Pessoa desativada, ou que saiu da empresa, simplesmente nao volta.
      return p ? { id: p.id, nome: p.nome } : null;
    }).filter(Boolean).slice(0, ABAS_MAX);
    desenharAbas();
  }

  function abrirAba(pessoa) {
    var ja = abas.filter(function (a) { return a.id === pessoa.id; })[0];
    if (!ja) {
      abas.push({ id: pessoa.id, nome: pessoa.nome });
      if (abas.length > ABAS_MAX) abas.shift();
      guardarAbas();
    }
    desenharAbas();
  }

  function fecharAba(id) {
    abas = abas.filter(function (a) { return a.id !== id; });
    guardarAbas();
    if (atual && atual.id === id) {
      // Fechou a que estava aberta: vai para a aba do lado, se houver.
      var proxima = abas[abas.length - 1];
      if (proxima) {
        var p = pessoas.filter(function (x) { return x.id === proxima.id; })[0];
        if (p) { abrirConversa(p); return; }
      }
      voltarParaLista();
      return;
    }
    desenharAbas();
  }

  // O nome curto que cabe na aba.
  //
  // So o primeiro nome, EXCETO quando outra aba aberta tem o mesmo primeiro
  // nome — ai entra a inicial do sobrenome. No grupo ha tres Alexandres; com
  // "Alexandre" em duas abas, a pessoa tem que clicar para descobrir qual e
  // qual, e a aba deixa de servir para o que serve.
  function rotuloDaAba(nome, todos) {
    var partes = String(nome || "").trim().split(/\s+/);
    var primeiro = partes[0] || "?";
    var repetido = todos.filter(function (n) {
      return n !== nome && String(n || "").trim().split(/\s+/)[0] === primeiro;
    }).length > 0;
    if (!repetido || partes.length < 2) return primeiro;
    return primeiro + " " + partes[partes.length - 1].charAt(0).toUpperCase() + ".";
  }

  function desenharAbas() {
    var faixa = raiz.querySelector(".ug-abas");
    faixa.classList.toggle("tem", abas.length > 0);
    var nomes = abas.map(function (a) { return a.nome; });
    faixa.innerHTML = abas.map(function (a) {
      var p = pessoas.filter(function (x) { return x.id === a.id; })[0] || {};
      var naoLidas = p.naoLidas || 0;
      return '<span class="ug-aba' + (atual && atual.id === a.id ? " aqui" : "") +
             (naoLidas ? " nova" : "") + '" data-id="' + esc(a.id) +
             '" title="' + esc(a.nome) + '">' +
             '<button class="ug-aba-nome">' + esc(rotuloDaAba(a.nome, nomes)) +
             (naoLidas ? ' <b>' + naoLidas + "</b>" : "") + "</button>" +
             '<button class="ug-aba-x" title="Fechar">&#215;</button></span>';
    }).join("");

    Array.prototype.forEach.call(faixa.querySelectorAll(".ug-aba"), function (el) {
      var id = el.getAttribute("data-id");
      el.querySelector(".ug-aba-nome").addEventListener("click", function () {
        var p = pessoas.filter(function (x) { return x.id === id; })[0];
        if (p) abrirConversa(p);
      });
      el.querySelector(".ug-aba-x").addEventListener("click", function (ev) {
        ev.stopPropagation();
        fecharAba(id);
      });
    });
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
        if (d.eu && d.eu.situacao) {
          minhaSituacao = d.eu.situacao;
          desenharSituacao();
        }
        desenharLista();
        desenharAbas();
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
      // Ocupado e Em reunião aparecem no lugar da previa: e a informacao que
      // muda a decisao de quem ia mandar mensagem agora.
      var situacao = p.situacao || (p.online ? "online" : "offline");
      if (situacao === "ocupado" || situacao === "reuniao") {
        previa = ROTULO[situacao] + (previa ? " · " + previa : "");
      }
      return [
        '<button class="ug-pessoa" data-id="' + esc(p.id) + '">',
        '  <span class="ug-foto"' + (p.temFoto ? ' data-foto="' + esc(p.id) + '"' : "") + ">",
        '    <span class="ug-iniciais">' + esc(iniciais(p.nome)) + "</span>",
        '    <span class="ug-luz ' + esc(situacao) + '"></span>',
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
    var situacao = pessoa.situacao || (pessoa.online ? "online" : "offline");
    raiz.querySelector(".ug-sub").textContent =
      (ROTULO[situacao] || "Offline") + (pessoa.departamento ? " · " + pessoa.departamento : "");
    abrirAba(pessoa);
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
        avisarAsOutras("mexeu");
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
    // "Na tela" e "sendo lida" sao coisas diferentes: a conversa pode estar
    // aberta com a janela minimizada. Tratar as duas como a mesma marcaria como
    // lida mensagem que ninguem viu — e o "visto" viraria mentira.
    var naTela = atual && d.outroId === atual.id && raiz.classList.contains("aberto");
    var olhando = !document.hidden;

    if (naTela && !balas.querySelector('[data-id="' + d.mensagem.id + '"]')) {
      acrescentar(d.mensagem);
      rolar();
    }

    if (d.mensagem.minha || (naTela && olhando)) {
      if (naTela && olhando && !d.mensagem.minha) marcarLido();
      carregarPessoas();
      return;
    }

    pessoas.forEach(function (p) { if (p.id === d.outroId) p.naoLidas = (p.naoLidas || 0) + 1; });
    atualizarSelo();
    desenharLista();
    desenharAbas();

    // O contador SEMPRE sobe. O que "nao perturbe" e a janela separada calam e
    // so a interrupcao — o bip e a caixinha.
    if (calado()) return;
    apitar();
    if (deveAvisarNaTela(d, document.hidden)) avisarNaTela(d);
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
      desenharAbas();
      avisarAsOutras("mexeu");
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

  // ------------------------------------------------- aviso na tela do Windows
  // A caixinha do canto inferior direito, que aparece por cima do Excel. E o
  // unico aviso que alcanca quem esta trabalhando em outro programa — o selo e
  // o bip so servem para quem ja esta com o navegador na frente.
  //
  // REGRA: so avisa quando a janela esta ESCONDIDA (outra aba, navegador
  // minimizado, outro programa por cima). Com a pessoa olhando para a tela, o
  // selo vermelho e o bip ja contam a historia; a caixinha por cima seria
  // barulho em cima de aviso que ela ja recebeu.
  function deveAvisarNaTela(d, escondido) {
    if (!d || !d.mensagem || d.mensagem.minha) return false;
    return Boolean(escondido);
  }

  function temNotificacao() {
    return typeof window.Notification !== "undefined";
  }

  // O que a faixa do aviso deve dizer.
  //
  // Sao TRES situacoes, e a do meio foi a que me escapou na primeira versao:
  //
  //   "convite"    — o navegador ainda nao perguntou nada. Oferece ligar.
  //   "bloqueado"  — a pessoa (ou a politica do navegador) ja negou antes.
  //                  Aqui NAO adianta pedir de novo: o navegador simplesmente
  //                  ignora o pedido, sem nem mostrar a perguntinha. Entao a
  //                  faixa explica onde desbloquear.
  //   "nada"       — ja esta ligado, ou o navegador nao tem o recurso.
  //
  // Na primeira versao o "bloqueado" caia no mesmo balde do "ja ligado" e a
  // faixa sumia: quem estava bloqueado nao via botao nenhum e nao tinha como
  // descobrir por que. Sumir calado e pior do que dar trabalho.
  //
  // Pura de proposito — o teste confere os tres estados sem navegador.
  function estadoDoConvite(permissao, adiadoAte, agora) {
    if (!permissao || permissao === "granted") return "nada";
    if (adiadoAte && agora < adiadoAte) return "nada";
    return permissao === "denied" ? "bloqueado" : "convite";
  }

  // O pedido de permissao NAO sai sozinho ao abrir a pagina.
  //
  // Permissao pedida do nada, sem a pessoa ter feito nada, e o caminho mais
  // curto para ela clicar em "Bloquear" — e ai cai no caso "bloqueado" acima,
  // que so se desfaz nas configuracoes do navegador. Por isso o convite aparece
  // dentro do painel, ja com o chat aberto, e so depois de um clique dela.
  function mostrarConvite() {
    var faixa = raiz.querySelector(".ug-convite");
    var texto = faixa.querySelector(".ug-convite-txt");
    var sim = faixa.querySelector(".ug-convite-sim");
    var nao = faixa.querySelector(".ug-convite-nao");

    var estado = estadoDoConvite(
      temNotificacao() ? window.Notification.permission : null,
      Number(ler(CONVITE) || 0),
      Date.now()
    );

    faixa.classList.toggle("tem", estado !== "nada");
    if (estado === "nada") return;

    if (estado === "bloqueado") {
      texto.textContent = "Os avisos na tela estão bloqueados no navegador. " +
        "Para ligar: clique no cadeado ao lado do endereço, procure Notificações e escolha Permitir.";
      sim.hidden = true;
      nao.textContent = "Entendi";
    } else {
      texto.textContent = "Quer receber aviso na tela quando chegar mensagem?";
      sim.hidden = false;
      nao.textContent = "Agora não";
    }
  }

  function pedirPermissao() {
    if (!temNotificacao()) return;
    try {
      var r = window.Notification.requestPermission(function () { mostrarConvite(); });
      if (r && typeof r.then === "function") r.then(function () { mostrarConvite(); });
    } catch (e) {
      mostrarConvite();
    }
  }

  function avisarNaTela(d) {
    if (!temNotificacao() || window.Notification.permission !== "granted") return;
    try {
      var quem = pessoas.filter(function (p) { return p.id === d.outroId; })[0];
      var texto = d.mensagem.texto ||
                  (d.mensagem.temImagem ? "mandou um print" : "mandou uma mensagem");
      var opcoes = {
        body: texto.length > 140 ? texto.slice(0, 140) + "..." : texto,
        // Uma caixinha por conversa. Sem a etiqueta, dez mensagens seguidas da
        // mesma pessoa empilhariam dez avisos e a pessoa fecharia todos no
        // reflexo — inclusive o que importava.
        tag: "ug-chat-" + d.conversaId,
      };
      if (quem && quem.temFoto) opcoes.icon = API + "/foto/" + encodeURIComponent(quem.id);

      var caixinha = new window.Notification(d.autorNome || "Nova mensagem", opcoes);
      caixinha.onclick = function () {
        try { window.focus(); } catch (e) { /* nada */ }
        abrirPainel(true);
        if (quem) abrirConversa(quem);
        caixinha.close();
      };
    } catch (e) { /* navegador recusou: o selo e o bip continuam valendo */ }
  }

  // Memoria local, so para nao insistir com quem disse "agora nao". Se o
  // navegador nao deixar guardar (janela anonima), o convite volta na proxima
  // vez — chato, mas nao quebra nada.
  var CONVITE = "ug_chat_convite";
  function ler(chave) {
    try { return window.localStorage.getItem(chave); } catch (e) { return null; }
  }
  function guardar(chave, valor) {
    try { window.localStorage.setItem(chave, valor); } catch (e) { /* tudo bem */ }
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
    // Exposta so para tests/chat-aviso.test.js: a regra de quando a caixinha do
    // Windows aparece e dificil de conferir a olho (depende da janela estar
    // escondida) e facil de quebrar sem ninguem notar.
    _deveAvisarNaTela: deveAvisarNaTela,
    _estadoDoConvite: estadoDoConvite,
    _rotuloDaAba: rotuloDaAba,
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
        if (d.eu && d.eu.situacao) minhaSituacao = d.eu.situacao;
        desenharSituacao();

        if (MODO_JANELA) {
          // Na janela propria nao ha balaozinho para abrir: o painel E a janela.
          raiz.classList.add("janela", "aberto");
          // Avisa as telas embutidas que existe uma janela cuidando dos avisos,
          // para a pessoa nao ouvir dois bips por mensagem.
          avisarAsOutras("janela-viva");
          setInterval(function () { avisarAsOutras("janela-viva"); }, 5000);
        }

        restaurarAbas();
        desenharLista();
        atualizarSelo();
        ligarFluxo();
        // Rede de seguranca: se o fluxo cair e o navegador demorar a reconectar,
        // a contagem ainda se atualiza sozinha.
        setInterval(function () { if (!document.hidden) carregarPessoas(); }, 60000);

        // Voltar para a aba com a conversa aberta na frente conta como ler.
        // Sem isto, quem recebeu a mensagem de janela minimizada voltava, via a
        // mensagem na tela e continuava com o numero vermelho no balao.
        document.addEventListener("visibilitychange", function () {
          if (document.hidden) return;
          if (atual && raiz.classList.contains("aberto")) marcarLido();
          carregarPessoas();
        });
      })
      .catch(function () { /* Core fora do ar: a pagina segue funcionando */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", comecar);
  } else {
    comecar();
  }
})();
