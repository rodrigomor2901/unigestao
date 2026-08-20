// ============================================================================
// Mural — tela
// ----------------------------------------------------------------------------
// Vai como arquivo, e nao embutido no HTML, por dois motivos: o navegador
// guarda em cache entre visitas, e o mesmo codigo serve a tela do mural e o
// pop-up da tela inicial sem duplicar nada.
// ============================================================================

var EU = null;
var PAGINA = 0;
var POR_PAGINA = 10;
var IMAGEM = null;   // { tipo, base64 } enquanto a pessoa nao publica

var TIPO_ROTULO = { aviso: 'Aviso', mudanca: 'Mudança', evento: 'Evento' };

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

function iniciais(nome) {
  var p = String(nome || '').trim().split(/\s+/);
  if (!p[0]) return '?';
  return (p[0][0] + (p.length > 1 ? p[p.length - 1][0] : '')).toUpperCase();
}

function quando(iso) {
  var min = Math.floor((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'agora';
  if (min < 60) return 'há ' + min + ' min';
  var h = Math.floor(min / 60);
  if (h < 24) return 'há ' + h + 'h';
  var d = Math.floor(h / 24);
  if (d === 1) return 'ontem';
  if (d < 7) return 'há ' + d + ' dias';
  return new Date(iso).toLocaleDateString('pt-BR');
}

function retrato(id, nome, classe) {
  return id
    ? '<img class="bolha ' + (classe || '') + '" src="/api/foto/' + encodeURIComponent(id) +
      '" alt="" onerror="this.replaceWith(Object.assign(document.createElement(\'div\'),' +
      '{className:\'bolha ' + (classe || '') + '\',textContent:' + JSON.stringify(iniciais(nome)) + '}))">'
    : '<div class="bolha ' + (classe || '') + '">' + esc(iniciais(nome)) + '</div>';
}

// ---------------------------------------------------------------------------
// Lista
// ---------------------------------------------------------------------------
async function carregar(mais) {
  if (!mais) PAGINA = 0;
  var r = await fetch('/api/mural?limite=' + POR_PAGINA + '&offset=' + (PAGINA * POR_PAGINA));
  if (!r.ok) { location.href = '/'; return; }
  var d = await r.json();

  if (d.podePublicar) document.getElementById('compor').style.display = '';

  var html = d.publicacoes.map(cartao).join('');
  var lista = document.getElementById('lista');
  if (mais) lista.insertAdjacentHTML('beforeend', html);
  else lista.innerHTML = html || '<div class="card fim">Nenhuma publicação ainda.</div>';

  var mostrados = (PAGINA + 1) * POR_PAGINA;
  var fim = document.getElementById('fim');
  if (d.total > mostrados) {
    fim.style.display = '';
    fim.innerHTML = '<button class="btn btn-sec" onclick="verMais()">Ver publicações anteriores</button>';
  } else {
    fim.style.display = d.total ? '' : 'none';
    fim.textContent = d.total ? 'Você chegou ao começo do mural.' : '';
  }
}

function verMais() { PAGINA++; carregar(true); }

function cartao(p) {
  var podeMexer = EU && (EU.superAdmin || p.autor_id === EU.id);
  return '<article class="card pub" id="pub-' + p.id + '">' +
    '<div class="pub-cab">' +
      retrato(p.autor_id, p.autor) +
      '<div class="pub-quem">' +
        '<b>' + esc(p.autor || 'Alguém') + '</b>' +
        '<small>' + esc([p.autor_cargo, quando(p.criado_em)].filter(Boolean).join(' · ')) + '</small>' +
      '</div>' +
      '<span class="selo-tipo ' + esc(p.tipo) + '">' + esc(TIPO_ROTULO[p.tipo] || p.tipo) + '</span>' +
      (podeMexer
        ? '<details class="pub-menu"><summary>⋯</summary><div class="itens">' +
            '<button onclick="editar(' + p.id + ')">Editar</button>' +
            '<button onclick="arquivar(' + p.id + ')">Remover do mural</button>' +
          '</div></details>'
        : '') +
    '</div>' +
    '<div class="pub-corpo">' +
      '<h3>' + esc(p.titulo) + '</h3>' +
      (p.texto ? '<p>' + esc(p.texto) + '</p>' : '') +
      (p.edicoes
        ? '<p class="editado" style="margin-top:8px">editado ' + esc(quando(p.editado_em)) +
          ' · <button onclick="verEdicoes(' + p.id + ')">ver o que mudou</button></p>'
        : '') +
    '</div>' +
    (p.tem_imagem ? '<img class="foto" src="/api/mural/' + p.id + '/imagem" alt="">' : '') +
    '<div class="pub-rodape">' +
      '<button class="' + (p.curti ? 'on' : '') + '" onclick="curtir(' + p.id + ')" id="curtir-' + p.id + '">' +
        (p.curti ? '★' : '☆') + ' <span>' + p.curtidas + '</span></button>' +
      '<button onclick="abrirComentarios(' + p.id + ')">💬 ' + p.comentarios + '</button>' +
      '<button class="' + (p.li ? 'on' : '') + '" onclick="marcarLido(' + p.id + ')" id="lido-' + p.id + '">' +
        (p.li ? '✓ lido' : 'marcar como lido') + '</button>' +
    '</div>' +
    '<div class="coments" id="coments-' + p.id + '"></div>' +
  '</article>';
}

// ---------------------------------------------------------------------------
// Interacoes
// ---------------------------------------------------------------------------
async function curtir(id) {
  var r = await fetch('/api/mural/' + id + '/curtir', { method: 'POST' });
  if (!r.ok) return;
  var d = await r.json();
  var b = document.getElementById('curtir-' + id);
  b.className = d.curti ? 'on' : '';
  b.innerHTML = (d.curti ? '★' : '☆') + ' <span>' + d.curtidas + '</span>';
}

async function marcarLido(id) {
  await fetch('/api/mural/' + id + '/lido', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  });
  var b = document.getElementById('lido-' + id);
  b.className = 'on';
  b.textContent = '✓ lido';
}

async function abrirComentarios(id) {
  var caixa = document.getElementById('coments-' + id);
  if (caixa.style.display === 'block') { caixa.style.display = 'none'; return; }
  caixa.style.display = 'block';
  caixa.innerHTML = '<div class="fim">Carregando…</div>';

  var d = await (await fetch('/api/mural/' + id + '/comentarios')).json();
  caixa.innerHTML = (d.comentarios || []).map(function (c) {
    return '<div class="coment" id="com-' + c.id + '">' +
      retrato(c.usuario_id, c.autor) +
      '<div class="txt"><b>' + esc(c.autor || 'Alguém') + '</b> ' +
        '<small>' + esc(quando(c.criado_em)) + '</small>' +
        '<p>' + esc(c.texto) + '</p></div>' +
      (c.podeApagar
        ? '<button class="apagar" onclick="apagarComentario(' + c.id + ')">apagar</button>' : '') +
    '</div>';
  }).join('') +
  '<div class="novo-coment">' +
    '<input id="novo-' + id + '" placeholder="Escreva um comentário…">' +
    '<button class="btn" onclick="comentar(' + id + ')">Enviar</button>' +
  '</div>';

  var campo = document.getElementById('novo-' + id);
  campo.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') comentar(id); });
}

async function comentar(id) {
  var campo = document.getElementById('novo-' + id);
  var texto = campo.value.trim();
  if (!texto) return;
  campo.value = '';
  var r = await fetch('/api/mural/' + id + '/comentarios', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ texto: texto }),
  });
  if (!r.ok) { campo.value = texto; return; }
  // Recarrega so os comentarios daquela publicacao: recarregar a lista inteira
  // faria a pessoa perder a posicao de leitura.
  document.getElementById('coments-' + id).style.display = 'none';
  await abrirComentarios(id);
}

async function apagarComentario(id) {
  if (!confirm('Apagar este comentário?')) return;
  var r = await fetch('/api/mural/comentarios/' + id, { method: 'DELETE' });
  if (r.ok) { var el = document.getElementById('com-' + id); if (el) el.remove(); }
}

async function verEdicoes(id) {
  var d = await (await fetch('/api/mural/' + id + '/edicoes')).json();
  var linhas = (d.edicoes || []).map(function (e) {
    return 'Em ' + new Date(e.editado_em).toLocaleString('pt-BR') +
           ', ' + (e.editor || 'alguém') + ' alterou.\n' +
           'Antes: "' + e.titulo_antes + '"\n' + (e.texto_antes || '') + '\n';
  }).join('\n──────────\n');
  alert(linhas || 'Sem histórico.');
}

// ---------------------------------------------------------------------------
// Publicar
// ---------------------------------------------------------------------------
function ligarComposicao() {
  document.getElementById('cPopup').addEventListener('change', function () {
    document.getElementById('lblDias').style.display = this.checked ? '' : 'none';
  });
  document.getElementById('btnImagem').addEventListener('click', function () {
    document.getElementById('arquivo').click();
  });
  document.getElementById('arquivo').addEventListener('change', async function () {
    var arq = this.files && this.files[0];
    this.value = '';
    if (!arq) return;
    IMAGEM = await reduzir(arq);
    var img = document.getElementById('previaImg');
    img.src = 'data:' + IMAGEM.tipo + ';base64,' + IMAGEM.base64;
    img.style.display = 'block';
  });
  document.getElementById('btnPublicar').addEventListener('click', publicar);
}

async function publicar() {
  var aviso = document.getElementById('avisoCompor');
  aviso.innerHTML = '';
  var corpo = {
    titulo: document.getElementById('cTitulo').value,
    texto: document.getElementById('cTexto').value,
    tipo: document.getElementById('cTipo').value,
    fixado: document.getElementById('cFixado').checked,
    popup: document.getElementById('cPopup').checked,
    popupDias: document.getElementById('cPopupDias').value,
  };
  if (IMAGEM) { corpo.imagem = IMAGEM.base64; corpo.imagemTipo = IMAGEM.tipo; }

  var r = await fetch('/api/mural', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(corpo),
  });
  var d = await r.json().catch(function () { return {}; });
  if (!r.ok) {
    aviso.innerHTML = '<div class="aviso aviso-erro">' + esc(d.erro || 'Falha ao publicar') + '</div>';
    return;
  }
  document.getElementById('cTitulo').value = '';
  document.getElementById('cTexto').value = '';
  document.getElementById('cFixado').checked = false;
  document.getElementById('cPopup').checked = false;
  document.getElementById('lblDias').style.display = 'none';
  document.getElementById('previaImg').style.display = 'none';
  IMAGEM = null;
  await carregar(false);
}

async function editar(id) {
  var pub = document.getElementById('pub-' + id);
  var titulo = prompt('Título', pub.querySelector('.pub-corpo h3').textContent);
  if (titulo === null) return;
  var pAtual = pub.querySelector('.pub-corpo p');
  var texto = prompt('Texto', pAtual && !pAtual.className ? pAtual.textContent : '');
  if (texto === null) return;
  var r = await fetch('/api/mural/' + id, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ titulo: titulo, texto: texto }),
  });
  if (r.ok) await carregar(false);
}

async function arquivar(id) {
  if (!confirm('Remover esta publicação do mural?')) return;
  var r = await fetch('/api/mural/' + id, { method: 'DELETE' });
  if (r.ok) await carregar(false);
}

// A imagem e reduzida no navegador antes de subir: foto de celular tem de 3 a
// 8 MB, e subir isso gastaria os dados moveis de quem envia.
function reduzir(arq) {
  var LADO = 1280;
  return new Promise(function (resolve, reject) {
    var img = new Image();
    var url = URL.createObjectURL(arq);
    img.onload = function () {
      URL.revokeObjectURL(url);
      var escala = Math.min(1, LADO / Math.max(img.width, img.height));
      var c = document.createElement('canvas');
      c.width = Math.round(img.width * escala);
      c.height = Math.round(img.height * escala);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      var dataUrl = c.toDataURL('image/jpeg', 0.82);
      resolve({ tipo: 'image/jpeg', base64: dataUrl.slice(dataUrl.indexOf(',') + 1) });
    };
    img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('Imagem inválida')); };
    img.src = url;
  });
}

// ---------------------------------------------------------------------------
// Inicio
// ---------------------------------------------------------------------------
(async function () {
  var r = await fetch('/api/eu');
  if (!r.ok) { location.href = '/'; return; }
  EU = (await r.json()).usuario;
  ligarComposicao();
  await carregar(false);
})();
