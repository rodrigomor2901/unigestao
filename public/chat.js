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
  var canais = [];                  // o canal do meu departamento (hoje, um so)
  var grupos = [];                  // grupos com gente escolhida a dedo
  var atual = null;                 // com quem — ou onde — estou falando
  var conversaId = null;
  var minhaSituacao = "online";     // online | ocupado | reuniao
  var euSou = null;                 // { nome, situacao, departamento }
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

  // Pessoa ou canal — o chat trata os dois como "destino".
  //
  // O id do canal comeca com "#" (ex.: "#COMERCIAL"), e nenhum id de pessoa
  // comeca assim. Com isso as abas, o contador de nao lidas e a busca
  // continuam valendo para os dois sem nenhum caso especial.
  function destinos() {
    return canais.concat(grupos, pessoas);
  }

  function acharDestino(id) {
    return destinos().filter(function (d) { return d.id === id; })[0] || null;
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
      '  <div class="ug-busca">',
      '    <input type="text" placeholder="Buscar pessoa...">',
      '    <button class="ug-novo-grupo" title="Criar um grupo">+ grupo</button>',
      "  </div>",
      '  <div class="ug-criar">',
      '    <input class="ug-grupo-nome" type="text" placeholder="Nome do grupo (ex.: Gestores)">',
      '    <div class="ug-grupo-gente"></div>',
      '    <div class="ug-grupo-aviso"></div>',
      '    <div class="ug-grupo-acoes">',
      '      <button class="ug-grupo-cancelar">Cancelar</button>',
      '      <button class="ug-grupo-criar">Criar grupo</button>',
      "    </div>",
      "  </div>",
      '  <div class="ug-lista"></div>',
      '  <div class="ug-conversa">',
      '    <div class="ug-membros"></div>',
      '    <div class="ug-balas"></div>',
      '    <div class="ug-anexo"><img alt=""><span></span><button type="button">remover</button></div>',
      '    <div class="ug-aviso"></div>',
      '    <div class="ug-emojis"></div>',
      '    <div class="ug-escrever">',
      '      <button class="ug-emoji" title="Emojis">&#128512;</button>',
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
    raiz.querySelector(".ug-novo-grupo").addEventListener("click", abrirCriacaoDeGrupo);
    raiz.querySelector(".ug-grupo-cancelar").addEventListener("click", function () {
      raiz.classList.remove("criando-grupo", "so-incluir");
    });
    raiz.querySelector(".ug-grupo-criar").addEventListener("click", criarGrupo);
    raiz.querySelector(".ug-sub").addEventListener("click", function () {
      // So em canal e grupo: numa conversa de dois, "quem esta aqui" nao e
      // pergunta.
      if (!atual || (!atual.canal && !atual.grupo)) return;
      raiz.classList.toggle("vendo-membros");
      if (raiz.classList.contains("vendo-membros")) desenharMembros();
    });
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
    document.addEventListener("click", function () {
      raiz.classList.remove("menu-aberto");
      raiz.classList.remove("emojis-abertos");
    });
    raiz.querySelector(".ug-convite-sim").addEventListener("click", pedirPermissao);
    raiz.querySelector(".ug-convite-nao").addEventListener("click", function () {
      // Adia por uma semana, e nao para sempre: "para sempre" deixaria a pessoa
      // sem caminho de volta pela tela do sistema.
      guardar(CONVITE, String(Date.now() + 7 * 24 * 60 * 60 * 1000));
      mostrarConvite();
    });
    raiz.querySelector(".ug-voltar").addEventListener("click", voltarParaLista);
    montarEmojis(raiz.querySelector(".ug-emojis"));
    raiz.querySelector(".ug-emoji").addEventListener("click", function (ev) {
      ev.stopPropagation();
      raiz.classList.toggle("emojis-abertos");
      if (raiz.classList.contains("emojis-abertos")) caixa.focus();
    });
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
    raiz.classList.remove("na-conversa", "no-canal");
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
      var d = acharDestino(id);
      // Pessoa desativada, ou canal de uma area que nao e mais a sua,
      // simplesmente nao volta.
      return d ? { id: d.id, nome: d.canal ? "#" + d.nome : d.nome } : null;
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
        var d = acharDestino(proxima.id);
        if (d) { abrirConversa(d); return; }
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
      var p = acharDestino(a.id) || {};
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
        var d = acharDestino(id);
        if (d) abrirConversa(d);
      });
      el.querySelector(".ug-aba-x").addEventListener("click", function (ev) {
        ev.stopPropagation();
        fecharAba(id);
      });
    });
  }

  // ------------------------------------------------------------ criar grupo
  // Qualquer pessoa cria, sem passar por administrador.
  //
  // Com 45 pessoas, uma fila para criar um grupo de tres significa que o grupo
  // nao vai existir — a conversa acontece no WhatsApp, que e exatamente o que
  // este comunicador veio evitar.
  function abrirCriacaoDeGrupo() {
    raiz.classList.add("criando-grupo");
    raiz.classList.remove("so-incluir");
    raiz.querySelector(".ug-grupo-nome").value = "";
    mostrarAvisoDoGrupo("");

    var gente = raiz.querySelector(".ug-grupo-gente");
    gente.innerHTML = pessoas.map(function (p) {
      return '<label class="ug-escolher"><input type="checkbox" value="' + esc(p.id) + '"> ' +
             "<span>" + esc(p.nome) +
             (p.departamento ? ' <small>' + esc(p.departamento) + "</small>" : "") +
             "</span></label>";
    }).join("");

    raiz.querySelector(".ug-grupo-nome").focus();
  }

  function mostrarAvisoDoGrupo(texto) {
    var el = raiz.querySelector(".ug-grupo-aviso");
    el.textContent = texto || "";
    el.classList.toggle("tem", Boolean(texto));
  }

  function criarGrupo() {
    var nome = raiz.querySelector(".ug-grupo-nome").value.trim();
    var marcados = Array.prototype.filter.call(
      raiz.querySelectorAll(".ug-grupo-gente input"), function (c) { return c.checked; }
    ).map(function (c) { return c.value; });

    if (!marcados.length) return mostrarAvisoDoGrupo("Escolha ao menos uma pessoa.");

    // A mesma tela serve para INCLUIR gente num grupo que ja existe: a pergunta
    // e a mesma ("quem?"), e duas telas para a mesma pergunta seriam duas telas
    // para manter em pe.
    if (raiz.classList.contains("so-incluir")) {
      api("/grupo/" + encodeURIComponent(atual.conversaId) + "/membros", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ membros: marcados }),
      })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d) return mostrarAvisoDoGrupo("Não consegui incluir.");
          membrosDoGrupoAberto = d.membros || membrosDoGrupoAberto;
          atual.quantos = (membrosDoGrupoAberto || []).length;
          raiz.classList.remove("criando-grupo", "so-incluir");
          desenharMembros();
          carregarPessoas();
        })
        .catch(function () { mostrarAvisoDoGrupo("Sem conexão. Tente de novo."); });
      return;
    }

    if (!nome) return mostrarAvisoDoGrupo("Dê um nome ao grupo.");

    api("/grupos", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ nome: nome, membros: marcados }),
    })
      .then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        if (!res.ok) return mostrarAvisoDoGrupo(res.d.erro || "Não consegui criar o grupo.");
        raiz.classList.remove("criando-grupo");
        return carregarPessoas().then(function () {
          var novo = acharDestino("g" + res.d.conversaId);
          if (novo) abrirConversa(novo);
        });
      })
      .catch(function () { mostrarAvisoDoGrupo("Sem conexão. Tente de novo."); });
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
        canais = (d.canais || []).map(function (c) {
          return {
            id: "#" + c.nome, nome: c.nome, canal: true,
            conversaId: c.conversaId, quantos: c.quantos,
            naoLidas: c.naoLidas, ultima: c.ultima,
          };
        });
        grupos = (d.grupos || []).map(function (g) {
          return {
            id: "g" + g.conversaId, nome: g.nome, grupo: true,
            conversaId: g.conversaId, quantos: g.quantos, souDono: g.souDono,
            naoLidas: g.naoLidas, ultima: g.ultima,
          };
        });
        if (d.eu) {
          euSou = d.eu;
          if (d.eu.situacao) { minhaSituacao = d.eu.situacao; desenharSituacao(); }
        }
        desenharLista();
        desenharAbas();
        atualizarSelo();
      })
      .catch(function () { /* sem rede: a proxima batida tenta de novo */ });
  }

  function previaDe(d) {
    if (!d.ultima) return "";
    var t;
    if (d.ultima.apagada) t = "mensagem apagada";
    else if (d.ultima.temImagem && !d.ultima.texto) t = "📷 print";
    else t = d.ultima.texto;
    if (d.ultima.minha) return "Você: " + t;
    // No canal, saber QUEM falou e metade da informacao.
    if ((d.canal || d.grupo) && d.ultima.autor) {
      return String(d.ultima.autor).split(/\s+/)[0] + ": " + t;
    }
    return t;
  }

  function desenharLista() {
    var filtro = (painelBusca.value || "").trim().toLowerCase();
    var combina = function (texto) {
      return !filtro || String(texto).toLowerCase().indexOf(filtro) >= 0;
    };

    var meusCanais = canais.filter(function (c) { return combina(c.nome); });
    var meusGrupos = grupos.filter(function (g) { return combina(g.nome); });
    var mostrar = pessoas.filter(function (p) {
      return combina(p.nome + " " + p.departamento + " " + p.cargo);
    });

    if (!meusCanais.length && !meusGrupos.length && !mostrar.length) {
      lista.innerHTML = '<div class="ug-vazio">Ninguém encontrado.</div>';
      return;
    }

    // O canal do departamento vem primeiro: e a conversa que a pessoa mais usa
    // no dia, e procurar por ela no meio de 45 nomes seria trabalho a toa.
    var topo = meusCanais.concat(meusGrupos).map(function (c) {
      return [
        '<button class="ug-pessoa ug-canal" data-id="' + esc(c.id) + '">',
        '  <span class="ug-foto ug-marca-canal">' + (c.grupo ? "\u25CF" : "#") + "</span>",
        '  <span class="ug-quem">',
        '    <span class="ug-nome">' + esc(c.nome) + "</span>",
        '    <span class="ug-previa">' +
          esc(previaDe(c) || (c.quantos + (c.quantos === 1 ? " pessoa" : " pessoas") +
              (c.grupo ? " neste grupo" : " nesta área"))) +
          "</span>",
        "  </span>",
        c.naoLidas ? '<span class="ug-conta">' + c.naoLidas + "</span>" : "",
        "</button>",
      ].join("");
    }).join("");

    lista.innerHTML = topo + mostrar.map(function (p) {
      var previa = p.ultima ? previaDe(p) : (p.departamento || p.cargo || "");
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
        var d = acharDestino(b.getAttribute("data-id"));
        if (d) abrirConversa(d);
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
  function abrirConversa(destino) {
    atual = destino;
    raiz.classList.add("na-conversa");
    raiz.classList.toggle("no-canal", Boolean(destino.canal));
    raiz.querySelector(".ug-voltar").hidden = false;
    raiz.querySelector(".ug-titulo").textContent =
      destino.canal ? "# " + destino.nome : destino.nome;

    raiz.classList.remove("vendo-membros");
    raiz.classList.toggle("no-grupo", Boolean(destino.grupo));
    if (destino.grupo) {
      raiz.querySelector(".ug-sub").textContent =
        destino.quantos + (destino.quantos === 1 ? " pessoa" : " pessoas") +
        " no grupo \u2014 ver quem";
    } else if (destino.canal) {
      raiz.querySelector(".ug-sub").textContent =
        destino.quantos + (destino.quantos === 1 ? " pessoa" : " pessoas") +
        " desta área — ver quem";
    } else {
      var situacao = destino.situacao || (destino.online ? "online" : "offline");
      raiz.querySelector(".ug-sub").textContent =
        (ROTULO[situacao] || "Offline") + (destino.departamento ? " · " + destino.departamento : "");
    }

    abrirAba(destino);
    balas.innerHTML = '<div class="ug-vazio">Carregando...</div>';

    api(caminhoDe(destino))
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) { balas.innerHTML = '<div class="ug-vazio">Não consegui abrir a conversa.</div>'; return; }
        conversaId = d.conversaId;
        lidoAte = Number(d.lidoAte || 0);
        // O grupo traz os membros junto: quem esta nele foi ESCOLHIDO, entao
        // nao da para deduzir a lista do cadastro como se faz no canal.
        membrosDoGrupoAberto = d.membros || null;
        if (d.souDono !== undefined) destino.souDono = d.souDono;
        balas.innerHTML = "";
        ultimoDia = "";
        if (!d.mensagens.length) {
          balas.innerHTML = (destino.canal || destino.grupo)
            ? '<div class="ug-vazio">Ninguém escreveu aqui ainda. Comece você.</div>'
            : '<div class="ug-vazio">Nenhuma mensagem ainda.</div>';
        }
        d.mensagens.forEach(function (m) { acrescentar(m); });
        rolar();
        destino.naoLidas = 0;
        atualizarSelo();
        desenharAbas();
        caixa.focus();
      });
  }

  var ultimoDia = "";
  var membrosDoGrupoAberto = null;
  var lidoAte = 0;                  // ate onde o outro leu, na conversa aberta

  // Cada tipo de conversa tem seu endereco. Ficam juntos aqui para nao se
  // espalharem por cinco funcoes e saírem de sincronia.
  function caminhoDe(d) {
    if (d.canal) return "/canal";
    if (d.grupo) return "/grupo/" + encodeURIComponent(d.conversaId);
    return "/com/" + encodeURIComponent(d.id);
  }

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
    // No canal, cada balao dos outros leva o nome em cima. Sem isso a conversa
    // de uma area inteira vira um monte de falas sem dono.
    if (m.autor && !m.minha && atual && (atual.canal || atual.grupo)) {
      partes.push('<div class="ug-autor">' + esc(m.autor) + "</div>");
    }
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
    // O "visto", so nas MINHAS mensagens e so na conversa de dois.
    //
    // Em grupo e canal isto viraria "visto por quem?", que e outra pergunta e
    // outra tela — e um tique unico ali mentiria, porque dizer "visto" quando
    // um leu e cinco nao leram e pior do que nao dizer nada.
    var risco = "";
    if (m.minha && !m.apagada && atual && !atual.canal && !atual.grupo) {
      var visto = m.id <= lidoAte;
      risco = '<span class="ug-visto' + (visto ? " lido" : "") +
              '" data-msg="' + m.id + '" title="' +
              (visto ? "Visto" : "Enviada") + '">' + (visto ? "\u2713\u2713" : "\u2713") +
              "</span>";
    }
    partes.push('<div class="ug-hora">' + risco + hora(m.em) + "</div>");
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

  // Quem esta no canal.
  //
  // Sai da lista que ja veio carregada — os membros de um canal sao exatamente
  // as pessoas com aquele departamento no cadastro. Nao ha consulta nova a
  // fazer, e nao ha lista guardada que possa discordar da verdade.
  function membrosDoCanal(nomeDaArea) {
    var mesma = function (a, b) {
      return String(a || "").trim().toLowerCase() === String(b || "").trim().toLowerCase();
    };
    var lista = pessoas.filter(function (p) { return mesma(p.departamento, nomeDaArea); });

    // A lista de pessoas nao inclui quem esta pedindo — e o proprio nome e o
    // primeiro que se procura ao abrir "quem esta aqui".
    if (euSou && mesma(euSou.departamento, nomeDaArea)) {
      lista = lista.concat([{
        id: "eu", nome: euSou.nome || "Você", souEu: true,
        situacao: minhaSituacao, cargo: "", temFoto: false,
      }]);
    }
    return lista.sort(function (a, b) { return a.nome.localeCompare(b.nome, "pt-BR"); });
  }

  function desenharMembros() {
    var caixaMembros = raiz.querySelector(".ug-membros");
    if (!atual || (!atual.canal && !atual.grupo)) { caixaMembros.innerHTML = ""; return; }

    // No canal a lista se deduz do cadastro; no grupo ela veio do servidor,
    // porque foi escolhida a dedo.
    var gente = atual.canal ? membrosDoCanal(atual.nome) : (membrosDoGrupoAberto || []);
    if (!gente.length) {
      caixaMembros.innerHTML = atual.canal
        ? '<div class="ug-vazio">Ningu\u00e9m com este departamento no cadastro.</div>'
        : '<div class="ug-vazio">Grupo sem ningu\u00e9m.</div>';
      return;
    }

    var rodape = atual.grupo
      ? '<div class="ug-membros-acoes">' +
        (atual.souDono
          ? '<button class="ug-add-membro">+ incluir gente</button>'
          : "") +
        '<button class="ug-sair-grupo">Sair do grupo</button></div>'
      : "";

    caixaMembros.innerHTML =
      '<div class="ug-membros-titulo">Quem est\u00e1 em ' +
        (atual.canal ? "# " : "") + esc(atual.nome) + "</div>" + rodape +
      gente.map(function (p) {
        var situacao = p.situacao || (p.online ? "online" : "offline");
        // No canal a propria pessoa vem marcada; no grupo a lista vem do
        // servidor, sem marca nenhuma — por isso a comparacao pelo id, que
        // vale nos dois casos. Sem ela, o dono ganhava um botao para se tirar
        // do proprio grupo, ao lado do "Sair" que ja existe logo acima.
        var ehEu = p.souEu || Boolean(euSou && p.id === euSou.id);
        return [
          '<div class="ug-membro">',
          '  <span class="ug-foto"' + (p.temFoto ? ' data-foto="' + esc(p.id) + '"' : "") + ">",
          '    <span class="ug-iniciais">' + esc(iniciais(p.nome)) + "</span>",
          '    <span class="ug-luz ' + esc(situacao) + '"></span>',
          "  </span>",
          '  <span class="ug-quem">',
          '    <span class="ug-nome">' + esc(p.nome) +
            (ehEu ? " <b>(você)</b>" : "") + "</span>",
          '    <span class="ug-previa">' +
            esc((ROTULO[situacao] || "Offline") + (p.cargo ? " · " + p.cargo : "")) + "</span>",
          "  </span>",
          atual.grupo && atual.souDono && !ehEu
            ? '<button class="ug-tirar" data-id="' + esc(p.id) + '" title="Tirar do grupo">&#215;</button>'
            : "",
          "</div>",
        ].join("");
      }).join("");

    var incluir = caixaMembros.querySelector(".ug-add-membro");
    if (incluir) incluir.addEventListener("click", abrirInclusaoNoGrupo);

    var sair = caixaMembros.querySelector(".ug-sair-grupo");
    if (sair) sair.addEventListener("click", sairDoGrupo);

    Array.prototype.forEach.call(caixaMembros.querySelectorAll(".ug-tirar"), function (b) {
      b.addEventListener("click", function () { tirarDoGrupo(b.getAttribute("data-id")); });
    });

    carregarFotos(caixaMembros);
  }

  // Incluir gente reaproveita a mesma tela de criar grupo, so que sem o nome:
  // a pergunta e a mesma ("quem?"), e duas telas para a mesma pergunta seriam
  // duas telas para manter.
  function abrirInclusaoNoGrupo() {
    var jaEstao = (membrosDoGrupoAberto || []).map(function (m) { return m.id; });
    var deFora = pessoas.filter(function (p) { return jaEstao.indexOf(p.id) === -1; });
    if (!deFora.length) return mostrarAviso("Todo mundo já está neste grupo.");

    raiz.classList.add("criando-grupo", "so-incluir");
    raiz.querySelector(".ug-grupo-nome").value = atual.nome;
    mostrarAvisoDoGrupo("");
    raiz.querySelector(".ug-grupo-gente").innerHTML = deFora.map(function (p) {
      return '<label class="ug-escolher"><input type="checkbox" value="' + esc(p.id) + '"> ' +
             "<span>" + esc(p.nome) +
             (p.departamento ? ' <small>' + esc(p.departamento) + "</small>" : "") +
             "</span></label>";
    }).join("");
  }

  function tirarDoGrupo(id) {
    var quem = (membrosDoGrupoAberto || []).filter(function (m) { return m.id === id; })[0];
    if (!quem || !window.confirm("Tirar " + quem.nome + " do grupo?")) return;

    api("/grupo/" + encodeURIComponent(atual.conversaId) + "/membros/" + encodeURIComponent(id),
        { method: "DELETE" })
      .then(function (r) {
        if (!r.ok) return;
        membrosDoGrupoAberto = (membrosDoGrupoAberto || [])
          .filter(function (m) { return m.id !== id; });
        atual.quantos = membrosDoGrupoAberto.length;
        desenharMembros();
      });
  }

  function sairDoGrupo() {
    if (!euSou || !euSou.id) return;
    if (!window.confirm("Sair do grupo " + atual.nome + "?\n\n" +
                        "As mensagens que você escreveu continuam lá.")) return;

    api("/grupo/" + encodeURIComponent(atual.conversaId) +
        "/membros/" + encodeURIComponent(euSou.id), { method: "DELETE" })
      .then(function (r) {
        if (!r.ok) return;
        // Sair fecha a conversa e tira a aba: o grupo deixou de ser meu.
        fecharAba(atual.id);
        voltarParaLista();
      });
  }

  // Alguem leu do outro lado: os tiques das minhas mensagens ate ali viram
  // duplos. Mexe so no que mudou, em vez de redesenhar a conversa inteira —
  // redesenhar tiraria a pessoa do lugar onde estava lendo.
  function marcarVistoAte(ate) {
    lidoAte = Math.max(lidoAte, Number(ate || 0));
    Array.prototype.forEach.call(balas.querySelectorAll(".ug-visto"), function (el) {
      if (Number(el.getAttribute("data-msg")) <= lidoAte) {
        el.classList.add("lido");
        el.textContent = "\u2713\u2713";
        el.setAttribute("title", "Visto");
      }
    });
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

    api(caminhoDe(atual), {
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

  // ------------------------------------------------------------------ emojis
  // Uma bandeja curta, escrita a mao.
  //
  // Emoji ja funcionava aqui desde o primeiro dia — e texto como qualquer
  // outro, e quem sabe do atalho do Windows (tecla Windows + ponto) sempre pode
  // usar. Isto e para quem nao sabe do atalho, que e quase todo mundo.
  //
  // Sao os que se usam no trabalho, e nao um catalogo de mil: bandeja grande
  // vira rolagem, e rolagem para escolher uma carinha e mais trabalho do que
  // digitar a frase.
  var EMOJIS = [
    "\uD83D\uDC4D", "\uD83D\uDC4C", "\uD83D\uDE42", "\uD83D\uDE00", "\uD83D\uDE05",
    "\uD83D\uDE02", "\uD83E\uDD23", "\uD83D\uDE09", "\uD83D\uDE0E", "\uD83E\uDD14",
    "\uD83D\uDE44", "\uD83D\uDE10", "\uD83D\uDE13", "\uD83D\uDE22", "\uD83D\uDE21",
    "\uD83D\uDE31", "\uD83D\uDE4F", "\uD83D\uDCAA", "\uD83D\uDC4F", "\uD83E\uDD1D",
    "\u2705", "\u274C", "\u26A0\uFE0F", "\u2757", "\u2753",
    "\uD83D\uDCCC", "\uD83D\uDCC5", "\u23F0", "\uD83D\uDCDE", "\uD83D\uDCE7",
    "\uD83D\uDCC4", "\uD83D\uDCCA", "\uD83D\uDCB0", "\uD83D\uDE97", "\uD83C\uDFE2",
    "\uD83D\uDD25", "\u2B50", "\u2764\uFE0F", "\uD83C\uDF89", "\u2615",
  ];

  function montarEmojis(bandeja) {
    bandeja.innerHTML = EMOJIS.map(function (e) {
      return '<button type="button">' + e + "</button>";
    }).join("");

    Array.prototype.forEach.call(bandeja.querySelectorAll("button"), function (b) {
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        porNaCaixa(b.textContent);
      });
    });
  }

  // Entra onde o cursor esta, e nao no fim: quem ja escreveu a frase inteira e
  // volta para por a carinha no meio nao quer ela colada no ponto final.
  function porNaCaixa(texto) {
    var ini = caixa.selectionStart;
    var fim = caixa.selectionEnd;
    if (typeof ini !== "number") {
      caixa.value += texto;
    } else {
      caixa.value = caixa.value.slice(0, ini) + texto + caixa.value.slice(fim);
      var pos = ini + texto.length;
      caixa.setSelectionRange(pos, pos);
    }
    caixa.focus();
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

    fluxo.addEventListener("leitura", function (ev) {
      var d;
      try { d = JSON.parse(ev.data); } catch (e) { return; }
      if (conversaId && Number(d.conversaId) === Number(conversaId)) marcarVistoAte(d.lidoAte);
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
    api(caminhoDe(quem))
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
    // De quem e esta mensagem: de uma pessoa, ou do canal de uma area.
    var deQuem = d.canal ? "#" + d.canal : (d.grupo ? "g" + d.grupo : d.outroId);
    var naTela = atual && deQuem === atual.id && raiz.classList.contains("aberto");
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

    destinos().forEach(function (x) { if (x.id === deQuem) x.naoLidas = (x.naoLidas || 0) + 1; });
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
    var total = destinos().reduce(function (s, p) { return s + (p.naoLidas || 0); }, 0);
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
        var p = acharDestino(o.pessoaId);
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
        canais = (d.canais || []).map(function (c) {
          return {
            id: "#" + c.nome, nome: c.nome, canal: true,
            conversaId: c.conversaId, quantos: c.quantos,
            naoLidas: c.naoLidas, ultima: c.ultima,
          };
        });
        grupos = (d.grupos || []).map(function (g) {
          return {
            id: "g" + g.conversaId, nome: g.nome, grupo: true,
            conversaId: g.conversaId, quantos: g.quantos, souDono: g.souDono,
            naoLidas: g.naoLidas, ultima: g.ultima,
          };
        });
        if (d.eu) euSou = d.eu;
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
