'use strict';
/**
 * Leitura de planilhas (.xlsx) e CSV como lista de objetos { cabeçalho: valor }.
 *
 * O .xlsx (um zip de XMLs) é lido direto: workbook.xml para achar a aba,
 * sharedStrings.xml para os textos e o XML da aba para as linhas. Antes era
 * usado o leitor em streaming do exceljs, que no Windows às vezes não achava
 * a aba ou a devolvia vazia, dependendo da ordem das partes no arquivo.
 * Conferido contra o exceljs nas planilhas reais: mesmas linhas e valores.
 * O CSV aceita ";" ou "," (detectado pela primeira linha), aspas e UTF-8 ou
 * Windows-1252 (o padrão do Excel em português).
 */

const fs = require('fs');
const JSZip = require('jszip');
const { normalizarNome } = require('./texto');

/** Arquivo .xlsx começa com "PK" (é um zip), mesmo que o nome diga .csv. */
function ehXlsx(arquivo) {
  const fd = fs.openSync(arquivo, 'r');
  try {
    const assinatura = Buffer.alloc(2);
    fs.readSync(fd, assinatura, 0, 2, 0);
    return assinatura.toString('latin1') === 'PK';
  } finally {
    fs.closeSync(fd);
  }
}

/** Monta objetos a partir de linhas já separadas (a primeira é o cabeçalho). */
function paraObjetos(linhas) {
  const [cabecalho = [], ...dados] = linhas;
  const nomes = Array.from(cabecalho, (c) => String(c ?? '').trim()); // Array.from: linhas podem ter "buracos"
  return dados
    .filter((l) => Array.from(l).some((v) => String(v ?? '').trim() !== ''))
    .map((l) => Object.fromEntries(nomes.map((n, i) => [n, l[i] ?? ''])));
}

// ───────────────────────────── .xlsx ─────────────────────────────

const atributo = (tag, nome) => (tag.match(new RegExp(`\\b${nome}="([^"]*)"`)) || [])[1];

/** Entidades XML: &amp; &lt; &gt; &quot; &apos; &#10; &#x41; */
const ENTIDADES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function desescapar(texto) {
  return texto.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (inteira, e) => {
    if (e[0] !== '#') return ENTIDADES[e] ?? inteira;
    return String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
  });
}

/** Texto de um <si> ou <is>: junta os <t> (texto rico vem em vários pedaços), ignora a fonética (<rPh>). */
const textoDosT = (xml) => [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/g, '').matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)]
  .map((m) => desescapar(m[1])).join('');

/** "AB12" → 27 (índice da coluna, a partir de 0). */
function indiceDaColuna(ref) {
  const letras = /^[A-Z]+/.exec(ref)?.[0] || '';
  return [...letras].reduce((n, l) => n * 26 + (l.charCodeAt(0) - 64), 0) - 1;
}

/** Valor de uma célula <c> conforme o tipo (t="s" compartilhado, inlineStr, str, b, n...). */
function valorDaCelula(attrs, corpo, compartilhadas) {
  const tipo = atributo(attrs, 't');
  if (tipo === 'inlineStr') return textoDosT(corpo);
  const v = /<v>([\s\S]*?)<\/v>/.exec(corpo)?.[1];
  if (v === undefined) return '';
  if (tipo === 's') return compartilhadas[Number(v)] ?? '';
  if (tipo === 'str' || tipo === 'e' || tipo === 'd') return desescapar(v);
  if (tipo === 'b') return v === '1';
  const n = Number(v);
  return Number.isFinite(n) ? n : desescapar(v);
}

/** Valores de uma <row>, cada um na sua coluna (as células vazias não vêm no XML). */
function celulasDaLinha(corpoLinha, compartilhadas) {
  const linha = [];
  let proxima = 0;
  for (const [, attrs, corpo = ''] of corpoLinha.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
    const ref = atributo(attrs, 'r');
    const coluna = ref ? indiceDaColuna(ref) : proxima;
    linha[coluna] = valorDaCelula(attrs, corpo, compartilhadas);
    proxima = coluna + 1;
  }
  return Array.from(linha, (v) => v ?? '');
}

/** Linhas de uma aba (XML do sheetN.xml) como arrays de valores. */
const linhasDaAba = (xml, compartilhadas) => [...xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)]
  .map(([, corpoLinha = '']) => celulasDaLinha(corpoLinha, compartilhadas));

/** Caminho da parte dentro do zip a partir do Target dos rels ("worksheets/sheet1.xml" ou "/xl/worksheets/sheet1.xml"). */
const caminhoNoZip = (alvo) => (alvo.startsWith('/') ? alvo.slice(1) : `xl/${alvo}`);

/** @returns {Promise<{ zip: JSZip, abas: Array<{ nome: string, parte: string }> }>} */
async function abrirXlsx(arquivo) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(arquivo));
  const ler = (p) => zip.file(p)?.async('string') ?? Promise.resolve('');
  const [workbook, rels] = await Promise.all([ler('xl/workbook.xml'), ler('xl/_rels/workbook.xml.rels')]);
  const alvoDe = new Map((rels.match(/<Relationship\b[^>]*>/g) || []).map((t) => [atributo(t, 'Id'), atributo(t, 'Target')]));
  const abas = (workbook.match(/<sheet\b[^>]*>/g) || []).map((t) => ({
    nome: desescapar(atributo(t, 'name') || ''),
    parte: caminhoNoZip(alvoDe.get(atributo(t, 'r:id')) || ''),
  }));
  return { zip, abas };
}

/** Nomes das abas, na ordem do Excel. */
async function abasDoXlsx(arquivo) {
  return (await abrirXlsx(arquivo)).abas.map((a) => a.nome);
}

/**
 * Lê uma aba de um .xlsx direto do XML (sem depender da ordem das partes no
 * arquivo nem do sistema operacional). Sem `aba`, usa a primeira.
 * Datas vêm como número de série do Excel; textos e números como estão.
 * @returns {Promise<object[]>}
 */
async function lerXlsx(arquivo, { aba } = {}) {
  const { zip, abas } = await abrirXlsx(arquivo);
  const escolhida = aba ? abas.find((a) => normalizarNome(a.nome) === normalizarNome(aba)) : abas[0];
  if (!escolhida) throw new Error(`Aba "${aba}" não encontrada em ${arquivo}. Abas: ${abas.map((a) => a.nome).join(', ')}`);
  const parte = zip.file(escolhida.parte);
  if (!parte) throw new Error(`Aba "${escolhida.nome}" sem conteúdo (${escolhida.parte}) em ${arquivo}.`);

  const compartilhadasXml = await (zip.file('xl/sharedStrings.xml')?.async('string') ?? '');
  const compartilhadas = (compartilhadasXml.match(/<si\b[\s\S]*?<\/si>/g) || []).map(textoDosT);
  return paraObjetos(linhasDaAba(await parte.async('string'), compartilhadas));
}

/** UTF-8 quando válido; senão Windows-1252 (latin1 cobre os acentos do português). */
function decodificar(buffer) {
  const utf8 = buffer.toString('utf8');
  const texto = utf8.includes('�') ? buffer.toString('latin1') : utf8;
  return texto.replace(/^﻿/, '');
}

/** Separa um CSV em linhas e campos, respeitando aspas ("a;b" e aspas duplas ""). */
function separarCsv(texto, separador) {
  const linhas = [];
  let linha = [];
  let campo = '';
  let aspas = false;
  for (let i = 0; i < texto.length; i++) {
    const c = texto[i];
    if (aspas && c === '"' && texto[i + 1] === '"') {
      campo += '"';
      i++;
      continue;
    }
    if (c === '"') {
      aspas = !aspas;
      continue;
    }
    if (aspas || (c !== separador && c !== '\n' && c !== '\r')) {
      campo += c;
      continue;
    }
    linha.push(campo);
    campo = '';
    if (c === separador) continue;
    if (c === '\r' && texto[i + 1] === '\n') i++;
    linhas.push(linha);
    linha = [];
  }
  if (campo !== '' || linha.length) linhas.push([...linha, campo]);
  return linhas;
}

/** Detecta o separador pela primeira linha. */
function detectarSeparador(texto) {
  const primeira = texto.slice(0, texto.search(/\r?\n|$/));
  return (primeira.match(/;/g) || []).length >= (primeira.match(/,/g) || []).length ? ';' : ',';
}

/** Lê um CSV. @returns {object[]} */
function lerCsv(arquivo) {
  const texto = decodificar(fs.readFileSync(arquivo));
  return paraObjetos(separarCsv(texto, detectarSeparador(texto)));
}

/**
 * Lê .xlsx ou CSV (pelo conteúdo, não pela extensão: o Vanguard exporta .xlsx com nome .csv às vezes).
 * @param {string} arquivo
 * @param {{ aba?: string }} [opcoes] - aba do .xlsx
 * @returns {Promise<object[]>}
 */
async function lerTabela(arquivo, opcoes = {}) {
  if (ehXlsx(arquivo)) return lerXlsx(arquivo, opcoes);
  return lerCsv(arquivo);
}

module.exports = { lerTabela, lerCsv, lerXlsx, abasDoXlsx, separarCsv, detectarSeparador, decodificar };
