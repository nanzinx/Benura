'use strict';
/**
 * Executa comandos de sistema (git, npm, npx pm2) com timeout.
 * No Windows usa o shell, onde `npm`/`npx` são arquivos .cmd.
 */

const { spawn } = require('child_process');

const LIMITE_SAIDA = 4000; // guarda só o fim da saída (para logs)

/**
 * @param {{ cwd: string, logger: object }} opcoes
 * @returns {(comando: string, args: string[], opcoes?: { timeoutMs?: number }) => Promise<{ ok: boolean, codigo: number|null, saida: string }>}
 */
function criarExecutor({ cwd, logger }) {
  return function executar(comando, args, { timeoutMs = 10 * 60_000 } = {}) {
    return new Promise((resolve) => {
      logger.debug(`$ ${comando} ${args.join(' ')}`);
      const filho = spawn(comando, args, { cwd, shell: process.platform === 'win32', windowsHide: true });
      let saida = '';
      const coletar = (d) => { saida = (saida + d).slice(-LIMITE_SAIDA); };
      filho.stdout.on('data', coletar);
      filho.stderr.on('data', coletar);

      const timer = setTimeout(() => {
        saida += `\n[tempo esgotado após ${timeoutMs} ms]`;
        filho.kill();
      }, timeoutMs);

      filho.on('error', (e) => {
        clearTimeout(timer);
        resolve({ ok: false, codigo: null, saida: `${saida}\n${e.message}` });
      });
      filho.on('close', (codigo) => {
        clearTimeout(timer);
        resolve({ ok: codigo === 0, codigo, saida: saida.trim() });
      });
    });
  };
}

module.exports = { criarExecutor };
