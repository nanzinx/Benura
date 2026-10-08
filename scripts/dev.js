#!/usr/bin/env node
'use strict';
/**
 * `npm run dev` multiplataforma: roteador com Carrossel e Argus simulados em
 * memória, sem rede e sem PM2. Funciona igual no Windows, Linux e macOS
 * (variáveis definidas aqui, não na linha de comando do npm).
 */

const PADROES_DEV = {
  BENURA_SEM_DOTENV: '1',
  USAR_MOCK: '1',
  GRUPO_URA_ID: '2',
  GRUPOS_ATIVOS_IDS: '1,3',
  HORARIO_CARGA: '00:00',
  HORARIO_FIM: '23:59',
  POLL_VENDAS_MS: '10000',
  DEBUG: '1',
};

for (const [nome, valor] of Object.entries(PADROES_DEV)) {
  if (process.env[nome] === undefined) process.env[nome] = valor;
}

require('../roteador-vendas');
