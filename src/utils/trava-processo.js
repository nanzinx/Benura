'use strict';
/**
 * Trava de instância única baseada em arquivo com o PID do dono.
 *
 * Diferente de uma trava "existe/não existe", uma trava deixada por um processo
 * que morreu (queda, `kill -9`, falta de energia) é detectada e reaproveitada —
 * senão o PM2 ficaria reiniciando o serviço para sempre sem conseguir subir.
 */

const fs = require('fs');

class TravaOcupadaError extends Error {
  constructor(caminho, pid) {
    super(`Outra instância (PID ${pid}) já está rodando. Trava: ${caminho}`);
    this.name = 'TravaOcupadaError';
    this.pid = pid;
  }
}

/** true se existe um processo com esse PID (mesmo que de outro usuário). */
function processoVivo(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function lerPid(caminho) {
  try {
    return Number.parseInt(fs.readFileSync(caminho, 'utf8'), 10);
  } catch {
    return NaN;
  }
}

/**
 * Adquire a trava ou lança TravaOcupadaError.
 * @returns {{ liberar(): void, reaproveitouOrfa: boolean, pidAnterior?: number }}
 */
/** Executa `fn` e devolve o erro lançado (ou null). */
function erroDe(fn) {
  try {
    fn();
    return null;
  } catch (e) {
    return e;
  }
}

/** Cria o arquivo só se ele não existir. @returns {boolean} false se já existia */
function criarSeNaoExistir(caminho, conteudo) {
  const erro = erroDe(() => fs.writeFileSync(caminho, conteudo, { flag: 'wx' }));
  if (!erro) return true;
  if (erro.code === 'EEXIST') return false;
  throw erro;
}

function adquirirTrava(caminho) {
  const pidAtual = String(process.pid);
  if (criarSeNaoExistir(caminho, pidAtual)) return criarTrava(caminho, false);

  const pidAnterior = lerPid(caminho);
  if (processoVivo(pidAnterior) && pidAnterior !== process.pid) throw new TravaOcupadaError(caminho, pidAnterior);

  fs.writeFileSync(caminho, pidAtual);
  return { ...criarTrava(caminho, true), pidAnterior };
}

function criarTrava(caminho, reaproveitouOrfa) {
  return {
    reaproveitouOrfa,
    liberar() {
      if (lerPid(caminho) !== process.pid) return; // não apaga trava de outro processo
      fs.rmSync(caminho, { force: true });
    },
  };
}

module.exports = { adquirirTrava, TravaOcupadaError, processoVivo };
