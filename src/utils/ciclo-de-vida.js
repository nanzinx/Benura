'use strict';
/**
 * Desligamento gracioso comum aos serviços (roteador e rodízio).
 *
 * Atende SIGINT, SIGTERM e a mensagem "shutdown" do PM2 (Windows não tem SIGTERM).
 * Executa as etapas em ordem; se algo travar, força a saída após o prazo.
 */

const PRAZO_DESLIGAMENTO_MS = 10_000;

/**
 * @param {object} opcoes
 * @param {object} opcoes.logger
 * @param {Array<() => Promise<void>|void>} opcoes.etapas - Ex.: parar laços, fechar servidor, salvar estado
 */
function registrarDesligamento({ logger, etapas }) {
  let encerrando = false;

  async function encerrar(motivo, codigo = 0) {
    if (encerrando) return;
    encerrando = true;
    logger.info(`Encerrando (${motivo})...`);
    setTimeout(() => process.exit(codigo || 1), PRAZO_DESLIGAMENTO_MS).unref();

    try {
      for (const etapa of etapas) await etapa();
      logger.info('Estado salvo. Até logo.');
    } catch (e) {
      logger.erro('Erro durante o desligamento:', e);
    }
    process.exit(codigo);
  }

  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('message', (msg) => msg === 'shutdown' && encerrar('PM2 shutdown'));
  process.on('uncaughtException', (e) => {
    logger.erro('Exceção não tratada:', e);
    encerrar('uncaughtException', 1);
  });
  process.on('unhandledRejection', (e) => logger.erro('Promise rejeitada não tratada:', e));
  return encerrar;
}

/** Fecha um servidor HTTP sem esperar conexões keep-alive ociosas. */
function fecharServidor(servidor) {
  const fechado = new Promise((r) => servidor.close(r));
  servidor.closeIdleConnections?.();
  return fechado;
}

/** server.listen como Promise (rejeita se a porta estiver ocupada). */
function escutar(servidor, porta) {
  return new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(porta, resolve);
  });
}

module.exports = { registrarDesligamento, fecharServidor, escutar };
