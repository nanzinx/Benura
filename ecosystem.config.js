'use strict';
/**
 * PM2 — PRODUÇÃO
 *
 * Roda o roteador de vendas usando a configuração do arquivo .env.
 *
 *   npm run pm2:iniciar     (ou: npx pm2 start ecosystem.config.js)
 *   npx pm2 logs benura-roteador
 *   npm run pm2:parar
 *
 * Para subir junto com o sistema: `npx pm2 save` e `npx pm2 startup`
 * (no Windows, use o pacote pm2-installer ou o Agendador de Tarefas).
 *
 * Para testar sem Carrossel/Argus reais, use ecosystem.simulacao.config.js.
 */

const path = require('path');

const LOGS = path.join(__dirname, 'logs');

module.exports = {
  apps: [
    {
      name: 'benura-roteador',
      script: 'roteador-vendas.js',
      cwd: __dirname,
      // Reinício automático com espera crescente se o processo cair repetidamente.
      autorestart: true,
      exp_backoff_restart_delay: 1000,
      // Tempo para o desligamento gracioso salvar o estado (o app espera até 10s).
      kill_timeout: 12_000,
      shutdown_with_message: true,
      time: true,
      out_file: path.join(LOGS, 'roteador.out.log'),
      error_file: path.join(LOGS, 'roteador.err.log'),
      env: { NODE_ENV: 'production' },
    },
  ],
};
