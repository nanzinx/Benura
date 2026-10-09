'use strict';
/**
 * Leitura de planilhas (.xlsx) e CSV como lista de objetos { cabeçalho: valor }.
 *
 * O .xlsx é lido em streaming (a base mestra tem centenas de milhares de linhas).
 * O CSV aceita ";" ou "," (detectado pela primeira linha), aspas e UTF-8 ou
 * Windows-1252 (o padrão do Excel em português).
 */

const fs = require('fs');
const ExcelJS = require('exceljs');
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
  const nomes = cabecalho.map((c) => String(c ?? '').trim());
  return dados
    .filter((l) => l.some((v) => String(v ?? '').trim() !== ''))
    .map((l) => Object.fromEntries(nomes.map((n, i) => [n, l[i] ?? ''])));
}

/**
 * Lê uma aba de um .xlsx. Sem `aba`, usa a primeira.
 * @returns {Promise<object[]>}
 */
async function lerXlsx(arquivo, { aba } = {}) {
  const leitor = new ExcelJS.stream.xlsx.WorkbookReader(arquivo, {
    sharedStrings: 'cache', hyperlinks: 'ignore', styles: 'ignore', worksheets: 'emit',
  });
  const alvo = aba ? normalizarNome(aba) : null;
  const abas = [];
  for await (const planilha of leitor) {
    abas.push(planilha.name);
    if (alvo && normalizarNome(planilha.name) !== alvo) continue;
    const linhas = [];
    for await (const linha of planilha) linhas.push(linha.values.slice(1).map(valorDaCelula));
    return paraObjetos(linhas);
  }
  throw new Error(`Aba "${aba}" não encontrada em ${arquivo}. Abas: ${abas.join(', ')}`);
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

module.exports = { lerTabela, lerCsv, lerXlsx, separarCsv, detectarSeparador, decodificar };
