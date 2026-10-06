"use strict";

// ============================================================================
// LEITOR DE PLANILHA (.xlsx / .xls do Nexti)
// ----------------------------------------------------------------------------
// Le uma planilha e devolve linhas de texto. So isso: nao escreve planilha, nao
// entende formula, nao formata. E o que a agenda de visitas precisa.
//
// POR QUE ESCRITO A MAO, E NAO UMA BIBLIOTECA
// O Core tem quatro dependencias (express, pg, bcryptjs, qrcode) e esse numero
// e um ativo: cada biblioteca a mais e atualizacao de seguranca para
// acompanhar. As bibliotecas de planilha sao grandes porque fazem tudo —
// escrever, estilo, grafico, formula. Aqui so se LE texto de celula, e isso sao
// duas coisas que o Node ja tem: zlib para descompactar e um varredor de XML.
//
// O QUE E UM .xlsx POR DENTRO
// Um ZIP com XMLs. O arquivo que o Nexti chama de .XLS e um .xlsx (confirmado
// no proprio export: comeca com "PK"). Dentro:
//   xl/worksheets/sheet1.xml   as celulas
//   xl/sharedStrings.xml       o texto, quando a planilha reaproveita strings
//
// AS TRES ARMADILHAS DO ZIP, todas presentes no export do Nexti:
//
// 1. O cabecalho local pode MENTIR o tamanho. Quando o bit 3 das flags esta
//    ligado (e esta: as flags do export sao 0x0808), tamanho e CRC vem DEPOIS
//    dos dados, num descritor. Por isso aqui se le o DIRETORIO CENTRAL, no fim
//    do arquivo, que sempre tem os valores certos.
// 2. O nome do arquivo e o campo "extra" tem tamanhos proprios no cabecalho
//    local, diferentes dos do diretorio central. Pular pelo tamanho errado cai
//    no meio dos dados e o inflate falha com "invalid distance".
// 3. A entrada pode estar sem compressao (metodo 0) ou deflacionada (metodo 8).
//    As duas aparecem em planilhas reais.
// ============================================================================

const zlib = require("zlib");

// Teto de seguranca: planilha vem de upload, e um zip pode prometer gigabytes
// em poucos kilobytes ("zip bomb"). 60 MB descomprimidos cobre com folga uma
// planilha de dezenas de milhares de linhas.
const MAX_DESCOMPRIMIDO = 60 * 1024 * 1024;

class ErroPlanilha extends Error {
  constructor(mensagem) {
    super(mensagem);
    this.name = "ErroPlanilha";
  }
}

// ---------------------------------------------------------------------------
// ZIP
// ---------------------------------------------------------------------------

// Acha o "fim do diretorio central" (assinatura PK\5\6), varrendo de tras para
// frente — o comentario final do zip, se houver, fica depois dele.
function fimDoDiretorio(buf) {
  const ASSINATURA = 0x06054b50;
  const minimo = Math.max(0, buf.length - 66000);
  for (let i = buf.length - 22; i >= minimo; i--) {
    if (buf.readUInt32LE(i) === ASSINATURA) return i;
  }
  return -1;
}

function lerZip(buf) {
  const fim = fimDoDiretorio(buf);
  if (fim < 0) throw new ErroPlanilha("Arquivo não parece uma planilha (.xlsx)");

  const quantas = buf.readUInt16LE(fim + 10);
  let p = buf.readUInt32LE(fim + 16);
  const entradas = new Map();

  for (let i = 0; i < quantas; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;       // cabecalho do diretorio
    const metodo = buf.readUInt16LE(p + 10);
    const comprimido = buf.readUInt32LE(p + 20);
    const descomprimido = buf.readUInt32LE(p + 24);
    const tamNome = buf.readUInt16LE(p + 28);
    const tamExtra = buf.readUInt16LE(p + 30);
    const tamComentario = buf.readUInt16LE(p + 32);
    const offsetLocal = buf.readUInt32LE(p + 42);
    const nome = buf.toString("utf8", p + 46, p + 46 + tamNome);
    entradas.set(nome, { metodo, comprimido, descomprimido, offsetLocal });
    p += 46 + tamNome + tamExtra + tamComentario;
  }
  return entradas;
}

function extrair(buf, entrada) {
  const p = entrada.offsetLocal;
  if (buf.readUInt32LE(p) !== 0x04034b50) throw new ErroPlanilha("Planilha corrompida");
  // Os tamanhos de nome e extra do cabecalho LOCAL, que podem diferir dos do
  // diretorio central — e e justamente por aqui que o conteudo comeca.
  const tamNome = buf.readUInt16LE(p + 26);
  const tamExtra = buf.readUInt16LE(p + 28);
  const inicio = p + 30 + tamNome + tamExtra;

  if (entrada.descomprimido > MAX_DESCOMPRIMIDO) {
    throw new ErroPlanilha("Planilha grande demais");
  }
  const dados = buf.subarray(inicio, inicio + entrada.comprimido);
  if (entrada.metodo === 0) return dados;
  if (entrada.metodo === 8) {
    return zlib.inflateRawSync(dados, { maxOutputLength: MAX_DESCOMPRIMIDO });
  }
  throw new ErroPlanilha("Compressão não suportada na planilha");
}

// ---------------------------------------------------------------------------
// XML — varredura simples, sem parser de verdade
// ---------------------------------------------------------------------------

const DESESCAPAR = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&apos;": "'" };

function texto(s) {
  return String(s || "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&(amp|lt|gt|quot|apos);/g, (m) => DESESCAPAR[m]);
}

// Junta o texto de todos os <t> de um trecho: uma celula pode vir quebrada em
// varios pedacos quando tem formatacao no meio da palavra.
function juntarT(trecho) {
  const partes = String(trecho || "").match(/<t[^>]*>([\s\S]*?)<\/t>/g) || [];
  return partes.map((p) => texto(p.replace(/<[^>]+>/g, ""))).join("");
}

function lerStringsCompartilhadas(xml) {
  const itens = String(xml).match(/<si>[\s\S]*?<\/si>/g) || [];
  return itens.map(juntarT);
}

// "C7" -> 2 (coluna C, base zero). Preserva coluna vazia: sem isso, uma celula
// em branco deslocaria todas as seguintes e a planilha inteira sairia torta.
function colunaDe(ref) {
  const letras = String(ref || "").match(/^([A-Z]+)/);
  if (!letras) return -1;
  let n = 0;
  for (const c of letras[1]) n = n * 26 + (c.charCodeAt(0) - 64);
  return n - 1;
}

function lerAba(xml, compartilhadas) {
  const linhas = [];
  // A forma FECHADA vem primeiro nas duas expressoes, e isso nao e estilo:
  // `<c[^>]*>` tambem casa com `<c r="C4"/>` (o `[^>]*` engole a barra), e ai o
  // `[\s\S]*?</c>` seguiria ate o fim da PROXIMA celula — a vazia comia a de
  // depois e o valor aparecia na coluna errada. Celula vazia em tag curta e o
  // que o Excel grava; o export do Nexti nao usa, entao o defeito so apareceu
  // quando o teste passou a montar a planilha.
  const blocos = String(xml).match(/<row[^>]*\/>|<row[^>]*>[\s\S]*?<\/row>/g) || [];

  for (const bloco of blocos) {
    const celulas = bloco.match(/<c[^>]*\/>|<c[^>]*>[\s\S]*?<\/c>/g) || [];
    const linha = [];
    for (const celula of celulas) {
      const ref = (celula.match(/\sr="([A-Z]+\d+)"/) || [])[1];
      const tipo = (celula.match(/\st="([^"]+)"/) || [])[1] || "";
      let valor = "";

      if (tipo === "inlineStr") {
        valor = juntarT(celula);
      } else {
        const v = celula.match(/<v[^>]*>([\s\S]*?)<\/v>/);
        valor = v ? texto(v[1]) : "";
        if (tipo === "s" && v) valor = compartilhadas[Number(valor)] || "";
      }

      const col = colunaDe(ref);
      if (col >= 0) {
        while (linha.length < col) linha.push("");
        linha[col] = valor;
      } else {
        linha.push(valor);
      }
    }
    linhas.push(linha);
  }
  return linhas;
}

/**
 * Le a primeira aba da planilha e devolve as linhas, cada uma um array de
 * textos. Celula vazia vem como "" — a posicao das colunas e preservada.
 */
function lerPlanilha(buf) {
  if (!Buffer.isBuffer(buf)) buf = Buffer.from(buf);
  const entradas = lerZip(buf);

  const nomeAba = [...entradas.keys()]
    .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
    .sort()[0];
  if (!nomeAba) throw new ErroPlanilha("Planilha sem nenhuma aba");

  const compartilhadas = entradas.has("xl/sharedStrings.xml")
    ? lerStringsCompartilhadas(extrair(buf, entradas.get("xl/sharedStrings.xml")).toString("utf8"))
    : [];

  return lerAba(extrair(buf, entradas.get(nomeAba)).toString("utf8"), compartilhadas);
}

module.exports = { lerPlanilha, ErroPlanilha };
