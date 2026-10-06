"use strict";

// Uma planilha de verdade, montada aqui: zip + XML, como o Excel faz.
//
// Existe para os testes da agenda nao dependerem de um arquivo do cliente —
// o relatorio exportado do Nexti tem nome de supervisor, cliente e posto, e
// isso nao entra no repositorio.
//
// Gera as duas formas que aparecem em planilha real: texto dentro da celula
// (inlineStr) e texto na tabela compartilhada (sharedStrings), com e sem
// compressao. Sao justamente os quatro caminhos do leitor em core/planilha.js.

const zlib = require("zlib");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function zipar(arquivos, { comprimir = false } = {}) {
  const locais = [];
  const central = [];
  let offset = 0;
  for (const [nome, texto] of Object.entries(arquivos)) {
    const cru = Buffer.from(texto, "utf8");
    const dados = comprimir ? zlib.deflateRawSync(cru) : cru;
    const metodo = comprimir ? 8 : 0;
    const nomeBuf = Buffer.from(nome, "utf8");

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(metodo, 8);
    local.writeUInt32LE(crc32(cru), 14);
    local.writeUInt32LE(dados.length, 18);
    local.writeUInt32LE(cru.length, 22);
    local.writeUInt16LE(nomeBuf.length, 26);
    locais.push(local, nomeBuf, dados);

    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    dir.writeUInt16LE(20, 6);
    dir.writeUInt16LE(metodo, 10);
    dir.writeUInt32LE(crc32(cru), 16);
    dir.writeUInt32LE(dados.length, 20);
    dir.writeUInt32LE(cru.length, 24);
    dir.writeUInt16LE(nomeBuf.length, 28);
    dir.writeUInt32LE(offset, 42);
    central.push(dir, nomeBuf);

    offset += local.length + nomeBuf.length + dados.length;
  }
  const corpo = Buffer.concat(locais);
  const dirBuf = Buffer.concat(central);
  const fim = Buffer.alloc(22);
  fim.writeUInt32LE(0x06054b50, 0);
  fim.writeUInt16LE(Object.keys(arquivos).length, 8);
  fim.writeUInt16LE(Object.keys(arquivos).length, 10);
  fim.writeUInt32LE(dirBuf.length, 12);
  fim.writeUInt32LE(corpo.length, 16);
  return Buffer.concat([corpo, dirBuf, fim]);
}

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;");
function planilhaDe(linhas, { compartilhadas = false, comprimir = false } = {}) {
  const letra = (i) => String.fromCharCode(65 + i);
  const textos = [];
  const corpo = linhas.map((linha, li) =>
    "<row r=\"" + (li + 1) + "\">" + linha.map((valor, ci) => {
      const ref = letra(ci) + (li + 1);
      if (valor === "") return "<c r=\"" + ref + "\"/>";
      if (compartilhadas) {
        let i = textos.indexOf(valor);
        if (i < 0) { textos.push(valor); i = textos.length - 1; }
        return "<c r=\"" + ref + "\" t=\"s\"><v>" + i + "</v></c>";
      }
      return "<c r=\"" + ref + "\" t=\"inlineStr\"><is><t>" + esc(valor) + "</t></is></c>";
    }).join("") + "</row>").join("");

  const arquivos = {
    "xl/worksheets/sheet1.xml":
      '<?xml version="1.0"?><worksheet><sheetData>' + corpo + "</sheetData></worksheet>",
  };
  if (compartilhadas) {
    arquivos["xl/sharedStrings.xml"] =
      '<?xml version="1.0"?><sst>' + textos.map((t) => "<si><t>" + esc(t) + "</t></si>").join("") + "</sst>";
  }
  return zipar(arquivos, { comprimir });
}


const CABECALHO = ["Matrícula", "Colaborador", "Centro de custo", "Posto", "Nome do checklist",
                   "Status", "Data do agendamento", "Data da visita", "InÍcio do deslocamento",
                   "Fim do deslocamento", "InÍcio da tarefa", "Fim da tarefa", "Cliente",
                   "Nome da Area", "Unidade de negócio", "Empresa"];

/** Uma linha do relatorio, com os campos que importam. */
function linhaDe(o) {
  const l = new Array(CABECALHO.length).fill("");
  l[0] = o.matricula || "1";
  l[1] = o.supervisor;
  l[3] = o.posto;
  l[4] = o.checklist || "VISITA DE ROTINA";
  l[5] = o.status || "Não realizada";
  l[6] = o.agendada;
  l[7] = o.visita || "";
  l[12] = o.cliente || "";
  return l;
}

/** O relatorio inteiro: titulo, linha em branco, cabecalho e as visitas. */
function relatorioDe(visitas, opcoes) {
  return planilhaDe([
    ["Relação de visitas  -   GRUPO SETER"],
    [],
    CABECALHO,
    ...visitas.map(linhaDe),
  ], opcoes);
}

module.exports = { planilhaDe, relatorioDe, linhaDe, CABECALHO };
