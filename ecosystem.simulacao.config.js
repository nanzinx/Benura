'use strict';
/**
 * PM2 — SIMULAÇÃO LOCAL (sem Carrossel nem Argus reais)
 *
 * Sobe dois processos:
 *   benura-mock          servidor que imita a API do Carrossel e a API da Argus (porta 8081)
 *   benura-roteador-sim  o roteador de verdade, apontando para o mock (porta 3001)
 *
 * O roteador passa por todo o caminho real: HTTP, retry, diretório de usuários,
 * transferências... só que contra o mock. O .env NÃO é lido (BENURA_SEM_DOTENV=1),
 * então um .env de produção na pasta não interfere.
 *
 *   npm run sim:iniciar            sobe tudo
 *   npm run sim:logs               acompanha os logs
 *   npm run sim:status             mostra quem está na URA e no Ativo
 *   npm run sim:venda -- 1005 1500 simula uma venda do ramal 1005 (webhook)
 *   npm run sim:parar              derruba tudo
 *
 * Roteiro do mock: na carga inicial, quem vendeu > R$ 50 mil "ontem" vai para a URA.
 * Depois de 2 min, RICARDO MENDES (1004) vende; depois de 5 min, JULIANA ALVES (1005)
 * vende — e o roteador os sobe para a URA sozinho.
 */

const path = require('path');

const SIMULACAO = path.join(__dirname, '.simulacao');
const PORTA_MOCK = 8081;
const PORTA_ROTEADOR = 3001;

const comum = {
  cwd: __dirname,
  autorestart: true,
  restart_delay: 2000,
  kill_timeout: 12_000,
  shutdown_with_message: true,
  time: true,
};

module.exports = {
  apps: [
    {
      ...comum,
      name: 'benura-mock',
      script: 'test/mock-vendas.js',
      out_file: path.join(SIMULACAO, 'logs', 'mock.out.log'),
      error_file: path.join(SIMULACAO, 'logs', 'mock.err.log'),
      env: { MOCK_PORT: PORTA_MOCK },
    },
    {
      ...comum,
      name: 'benura-roteador-sim',
      script: 'roteador-vendas.js',
      out_file: path.join(SIMULACAO, 'logs', 'roteador.out.log'),
      error_file: path.join(SIMULACAO, 'logs', 'roteador.err.log'),
      env: {
        BENURA_SEM_DOTENV: '1',
        // Carrossel e Argus apontando para o mock
        CARROSSEL_API_URL: `http://localhost:${PORTA_MOCK}`,
        ARGUS_BASE: `http://localhost:${PORTA_MOCK}/apiargus/cmd`,
        ARGUS_TOKEN: 'simulacao',
        // Grupos do mock: 1 GABRIEL - COMERCIAL, 3 MAYSA - COMERCIAL, 2 URA, 9 TREINAMENTO
        GRUPO_URA_ID: '2',
        GRUPOS_ATIVOS_IDS: '1,3',
        // Expediente o dia todo, para a simulação funcionar a qualquer hora
        HORARIO_CARGA: '00:00',
        HORARIO_FIM: '23:59',
        POLL_VENDAS_MS: '20000',
        PORT: String(PORTA_ROTEADOR),
        WEBHOOK_TOKEN: 'simulacao',
        // Estado e auditoria separados dos de produção
        STATE_FILE: path.join(SIMULACAO, 'state-vendas.json'),
        AUDITORIA_FILE: path.join(SIMULACAO, 'auditoria-cadastro.jsonl'),
        VENDEDORES_RAMAIS_FILE: path.join(SIMULACAO, 'vendedores-ramais.json'),
        SUPERVISORES_GRUPOS_FILE: path.join(SIMULACAO, 'supervisores-grupos.json'),
      },
    },
  ],
};
