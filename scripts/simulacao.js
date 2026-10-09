#!/usr/bin/env node
'use strict';
/**
 * Utilitário da simulação local (ecosystem.simulacao.config.js).
 *
 *   node scripts/simulacao.js limpar              apaga o estado da simulação anterior
 *   node scripts/simulacao.js status              mostra URA / Ativo / pendências
 *   node scripts/simulacao.js venda <ramal> <valor>   simula uma venda via webhook
 *
 * Ramais do mock: 1001..1008 (veja src/integrations/argus/argus.mock-client.js).
 */

const fs = require('fs');
const path = require('path');

const PASTA = path.join(__dirname, '..', '.simulacao');
const ROTEADOR = `http://localhost:${process.env.PORT || 3001}`;
const TOKEN = process.env.WEBHOOK_TOKEN || 'simulacao';

/** Remove estado e auditoria da rodada anterior (os logs ficam). */
function limpar() {
  const arquivos = ['state-vendas.json', 'state-vendas.json.bak', 'state-vendas.json.tmp'];
  fs.mkdirSync(path.join(PASTA, 'logs'), { recursive: true });
  for (const nome of arquivos) fs.rmSync(path.join(PASTA, nome), { force: true });
  console.log(`Estado da simulação limpo em ${PASTA}`);
}

async function chamar(caminho, opcoes = {}) {
  let res;
  try {
    res = await fetch(`${ROTEADOR}${caminho}`, opcoes);
  } catch (e) {
    throw new Error(`Roteador não respondeu em ${ROTEADOR} (${e.cause?.code || e.message}). Ele está rodando? Veja: npm run sim:logs`);
  }
  return { status: res.status, corpo: await res.json() };
}

const linhaVendedor = (v) => `  ${v.ramal.padEnd(6)} ${String(v.nome).padEnd(26)} ${String(v.ultimoResultado).padEnd(15)}`
  + `${v.promovidoNoDia ? ` ← vendeu hoje (R$ ${v.vendaQueDisparou})` : ''}`;

async function status() {
  const { corpo: s } = await chamar('/status');
  console.log(`\nData: ${s.data || '—'} | carga inicial feita: ${s.cargaInicialFeita ? 'sim' : 'não'} | `
    + `último monitoramento: ${s.ultimoMonitoramento || '—'}`);
  console.log(`\nURA (${s.ura.length})`);
  s.ura.forEach((v) => console.log(linhaVendedor(v)));
  console.log(`\nATIVO (${s.ativo.length})`);
  s.ativo.forEach((v) => console.log(linhaVendedor(v)));
  if (s.pendentes.length) console.log(`\nPendentes de sincronizar: ${s.pendentes.join(', ')}`);
  console.log('');
}

async function venda(ramal, valor) {
  if (!ramal || !valor) throw new Error('Uso: npm run sim:venda -- <ramal> <valor>   (ex.: 1005 1500)');
  const { status: codigo, corpo } = await chamar('/webhook/venda', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ ramal, valor }),
  });
  console.log(`HTTP ${codigo}:`, corpo);
}

const comandos = { limpar, status, venda };

async function main([comando, ...args]) {
  const fn = comandos[comando];
  if (!fn) throw new Error(`Comando desconhecido. Use: ${Object.keys(comandos).join(' | ')}`);
  await fn(...args);
}

main(process.argv.slice(2)).catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
