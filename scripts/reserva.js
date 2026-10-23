#!/usr/bin/env node
'use strict';
/**
 * [NOVO] Dois PCs (servidor e reserva), pelo terminal. Usado pelos scripts do Windows.
 *
 *   node scripts/reserva.js simulacao   liga o Modo simulação, se ninguém escolheu ainda
 *                                       (a reserva sobe só simulando, sem a trava)
 *   node scripts/reserva.js estado      este PC está com a posse da trava? (verificar-servico.ps1)
 */

const fs = require('fs');
const { carregarConfig } = require('../src/config');
const { lerPosse, posseValida } = require('../src/utils/posse');

const cfg = carregarConfig();
const comando = process.argv[2];

if (comando === 'simulacao') {
  const arquivo = cfg.automacao.arquivoSimulacao;
  if (fs.existsSync(arquivo)) {
    console.log(`Modo simulação já escolhido antes (${arquivo}): mantido.`);
  } else {
    fs.writeFileSync(arquivo, JSON.stringify({ ligada: true, desde: new Date().toISOString(), por: 'instalação da reserva' }));
    console.log('Modo simulação LIGADO: este PC só mostra o que faria. Para agir de verdade, use o painel (pega a trava).');
  }
} else if (comando === 'estado') {
  if (!cfg.trava.url) {
    console.log('Trava dos dois PCs: não configurada (TRAVA_URL vazio).');
  } else {
    const p = lerPosse(cfg.automacao.posse.arquivo);
    const agindo = posseValida({ ...cfg.automacao.posse, exigir: true });
    console.log(`Trava dos dois PCs: este PC é "${cfg.trava.nomePc}"; ${agindo ? `está com a trava (renovada ${p.renovadaEm})` : 'não está com a trava (o outro PC age, ou este está desligado ou em simulação)'}.`);
    process.exitCode = agindo ? 0 : 2;
  }
} else {
  console.error('use: simulacao | estado');
  process.exitCode = 1;
}
