'use strict';
/**
 * Leitura de planilhas (.xlsx) e CSV como lista de objetos { cabeçalho: valor }.
 *
 * O .xlsx é lido em streaming (a base mestra tem centenas de milhares de linhas).
 * O nome de cada aba vem do workbook.xml, lido antes: o leitor em streaming do
 * exceljs depende da ordem das partes dentro do arquivo e às vezes entrega a
 * aba antes de saber o nome dela (quebrava no Windows).
 * O CSV aceita ";" ou "," (detectado pela primeira linha), aspas e UTF-8 ou
 * Windows-1252 (o padrão do Excel em português).
 */

const fs = require('fs');
const ExcelJS = require('exceljs');
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

/** Valor "plano" de uma célula do ExcelJS (texto rico, fórmula, link, data). */
function valorDaCelula(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'object') return v;
  if ('result' in v) return valorDaCelula(v.result);
  if (Array.isArray(v.richText)) return v.richText.map((p) => p.text).join('');
  if ('text' in v) return v.text;
  return '';
}

/** Monta objetos a partir de linhas já separadas (a primeira é o cabeçalho). */
function paraObjetos(linhas) {
  const [cabecalho = [], ...dados] = linhas;
  const nomes = Array.from(cabecalho, (c) => String(c ?? '').trim()); // Array.from: linhas do Excel podem ter "buracos"
  return dados
    .filter((l) => l.some((v) => String(v ?? '').trim() !== ''))
    .map((l) => Object.fromEntries(nomes.map((n, i) => [n, l[i] ?? ''])));
}

const atributo = (tag, nome) => (tag.match(new RegExp(`\\b${nome}="([^"]*)"`)) || [])[1];
const desescapar = (s) => s.replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

/**
 * Abas do .xlsx, na ordem do Excel, com o número do arquivo de cada uma
 * (xl/worksheets/sheetN.xml). Lê só o workbook.xml e os rels (pequenos).
 * @returns {Promise<Array<{ nome: string, arquivo: string }>>}
 */
async function abasDoXlsx(arquivo) {
  const zip = await JSZip.loadAsync(await fs.promises.readFile(arquivo));
  const [workbook, rels] = await Promise.all(['xl/workbook.xml', 'xl/_rels/workbook.xml.rels'].map((p) => zip.file(p)?.async('string') ?? ''));
  const alvoDe = new Map((rels.match(/<Relationship\b[^>]*>/g) || []).map((t) => [atributo(t, 'Id'), atributo(t, 'Target')]));
  return (workbook.match(/<sheet\b[^>]*>/g) || []).map((t) => ({
    nome: desescapar(atributo(t, 'name') || ''),
    arquivo: ((alvoDe.get(atributo(t, 'r:id')) || '').match(/sheet(\d+)\.xml$/) || [])[1],
  }));
}

/**
 * Lê uma aba de um .xlsx. Sem `aba`, usa a primeira.
 * @returns {Promise<object[]>}
 */
async function lerXlsx(arquivo, { aba } = {}) {
  const abas = await abasDoXlsx(arquivo);
  const escolhida = aba ? abas.find((a) => normalizarNome(a.nome) === normalizarNome(aba)) : abas[0];
  if (!escolhida) throw new Error(`Aba "${aba}" não encontrada em ${arquivo}. Abas: ${abas.map((a) => a.nome).join(', ')}`);

  const leitor = new ExcelJS.stream.xlsx.WorkbookReader(arquivo, {
    sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit',
  });
  leitor.model = { sheets: [] }; // o exceljs troca pelo modelo real ao ler o workbook.xml
  const nomesReais = new Set(abas.map((a) => a.nome));
  for await (const planilha of leitor) {
    // Sem o workbook.xml lido, o exceljs usa um nome provisório ("Sheet2") e o id é o número do arquivo.
    const provisorio = !nomesReais.has(planilha.name);
    const ehAlvo = planilha.name === escolhida.nome || (provisorio && String(planilha.id) === escolhida.arquivo);
    if (ehAlvo) return lerLinhas(planilha);
    for await (const _linha of planilha); // o exceljs exige consumir cada aba antes da próxima
  }
  return lerXlsxCompleto(arquivo, escolhida.nome);
}

/** Último recurso: lê o arquivo inteiro na memória (mais lento e pesado, mas não depende da ordem). */
async function lerXlsxCompleto(arquivo, nomeAba) {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(arquivo);
  const planilha = wb.worksheets.find((w) => w.name === nomeAba);
  if (!planilha) throw new Error(`Aba "${nomeAba}" não pôde ser lida em ${arquivo}.`);
  const linhas = [];
  planilha.eachRow({ includeEmpty: true }, (linha) => linhas.push(Array.from(linha.values, valorDaCelula).slice(1)));
  return paraObjetos(linhas);
}

async function lerLinhas(planilha) {
  const linhas = [];
  for await (const linha of planilha) linhas.push(Array.from(linha.values, valorDaCelula).slice(1));
  return paraObjetos(linhas);
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

module.exports = { lerTabela, lerCsv, lerXlsx, lerXlsxCompleto, abasDoXlsx, separarCsv, detectarSeparador, decodificar };
