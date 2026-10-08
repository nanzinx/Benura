'use strict';
/**
 * PM2 — PRODUÇÃO
 *
 * Roda os serviços usando a configuração do arquivo .env:
 *   benura-roteador  roteador de vendas (Carrossel → URA/Ativo)          porta PORT (3001)
 *   benura-rodizio   rodízio Ativo ↔ URA + robôs + retorno da fila       porta RODIZIO_PORT (3000)
 *   benura-rotinas   rotinas diárias (fim de expediente)                 porta ROTINAS_PORT (3003)
 *
 *   npm run pm2:iniciar     (ou: npx pm2 start ecosystem.config.js)
 *   npx pm2 start ecosystem.config.js --only benura-rodizio   (só um deles)
 *   npx pm2 logs
 *   npm run pm2:parar
 *
 * Para subir junto com o sistema: `npx pm2 save` e `npx pm2 startup`
 * (no Windows, use o pacote pm2-installer ou o Agendador de Tarefas).
 *
 * Para testar sem Carrossel/Argus reais, use ecosystem.simulacao.config.js.
 */

const path = require('path');

const LOGS = path.join(__dirname, 'logs');

const comum = {
  cwd: __dirname,
  // Reinício automático com espera crescente se o processo cair repetidamente.
  autorestart: true,
  exp_backoff_restart_delay: 1000,
  // Tempo para o desligamento gracioso salvar o estado (o app espera até 10s).
  kill_timeout: 12_000,
  shutdown_with_message: true,
  time: true,
  env: { NODE_ENV: 'production' },
};

module.exports = {
  apps: [
    {
      ...comum,
      name: 'benura-roteador',
      script: 'roteador-vendas.js',
      out_file: path.join(LOGS, 'roteador.out.log'),
      error_file: path.join(LOGS, 'roteador.err.log'),
    },
    {
      ...comum,
      name: 'benura-rodizio',
      script: 'argus-automacao.js',
      out_file: path.join(LOGS, 'rodizio.out.log'),
      error_file: path.join(LOGS, 'rodizio.err.log'),
    },
    {
      ...comum,
      name: 'benura-rotinas',
      script: 'rotinas.js',
      out_file: path.join(LOGS, 'rotinas.out.log'),
      error_file: path.join(LOGS, 'rotinas.err.log'),
    },
  ],
};
