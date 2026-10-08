'use strict';
/**
 * PM2 — ATUALIZADOR DA PRODUÇÃO (separado: NÃO sobe com `npm run pm2:iniciar`)
 *
 * Liga o deploy automático nesta máquina: a cada minuto verifica a main no
 * GitHub e, fora do expediente, atualiza e recarrega benura-roteador e
 * benura-rodizio — com volta automática se os testes ou o /health falharem.
 *
 *   npm run atualizador:iniciar
 *   npm run atualizador:parar
 *   npm run atualizador:agora                        uma verificação agora (respeita a janela)
 *   npm run atualizador:agora -- --ignorar-janela    emergência: atualiza mesmo no expediente
 *
 * Histórico de deploys: logs/deploy.jsonl
 */

const path = require('path');

const LOGS = path.join(__dirname, 'logs');

module.exports = {
  apps: [
    {
      name: 'benura-atualizador',
      script: 'atualizador.js',
      cwd: __dirname,
      // Depois de um deploy o atualizador encerra de propósito para voltar com o código novo.
      autorestart: true,
      restart_delay: 5000,
      kill_timeout: 12_000,
      shutdown_with_message: true,
      time: true,
      out_file: path.join(LOGS, 'atualizador.out.log'),
      error_file: path.join(LOGS, 'atualizador.err.log'),
      env: { NODE_ENV: 'production' },
    },
  ],
};
