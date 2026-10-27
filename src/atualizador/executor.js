'use strict';
/**
 * Executa comandos de sistema (git, npm, npx pm2) com timeout.
 * No Windows usa o shell, onde `npm`/`npx` são arquivos .cmd.
 *
 * [NOVO] Nunca espera resposta: ninguém está olhando para responder. No servidor, um `git pull`
 * disparou a faxina automática (gc) e o Git for Windows perguntou "Unlink of file ... failed.
 * Should I try again? (y/n)" (um arquivo de pacote estava aberto). Aqui:
 *  - a entrada vem fechada, e GIT_ASK_YESNO=false responde "não" sozinho;
 *  - GIT_TERMINAL_PROMPT=0: sem pedir usuário e senha;
 *  - o git roda sem a faxina automática (-c gc.auto=0), que é o que segura e apaga os pacotes.
 */

const { spawn } = require('child_process');

const LIMITE_SAIDA = 4000; // guarda só o fim da saída (para logs)
const SEM_PERGUNTAS = { GIT_ASK_YESNO: 'false', GIT_TERMINAL_PROMPT: '0' };

/** Para o git, sem a faxina automática; os outros comandos ficam como estão. */
const argumentosDe = (comando, args) => (comando === 'git' ? ['-c', 'gc.auto=0', '-c', 'maintenance.auto=false', ...args] : args);

/**
 * @param {{ cwd: string, logger: object }} opcoes
 * @returns {(comando: string, args: string[], opcoes?: { timeoutMs?: number }) => Promise<{ ok: boolean, codigo: number|null, saida: string }>}
 */
function criarExecutor({ cwd, logger }) {
  return function executar(comando, args, { timeoutMs = 10 * 60_000 } = {}) {
    return new Promise((resolve) => {
      logger.debug(`$ ${comando} ${args.join(' ')}`);
      const filho = spawn(comando, argumentosDe(comando, args), {
        cwd, shell: process.platform === 'win32', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, ...SEM_PERGUNTAS },
      });
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

module.exports = { criarExecutor, argumentosDe };
