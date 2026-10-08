'use strict';
/**
 * Execução periódica sem sobreposição: a próxima rodada só começa quando a
 * anterior termina (setTimeout encadeado, descontando o tempo já gasto).
 * Erros são logados e não interrompem o laço.
 */

/**
 * @param {object} opcoes
 * @param {string} opcoes.nome - Para os logs
 * @param {number} opcoes.intervaloMs
 * @param {() => Promise<void>} opcoes.tarefa
 * @param {object} opcoes.logger
 * @param {number} [opcoes.alertaLentoMs=5000] - Avisa quando uma rodada demora mais que isso
 * @returns {{ parar(): Promise<void>, ultimaExecucao(): number }}
 */
function executarPeriodicamente({ nome, intervaloMs, tarefa, logger, alertaLentoMs = 5000 }) {
  let ativo = true;
  let timer = null;
  let rodadaAtual = Promise.resolve();
  let ultimaExecucao = 0;

  async function rodada() {
    const inicio = Date.now();
    try {
      await tarefa();
    } catch (e) {
      logger.erro(`Erro em ${nome}: ${e.message}`);
    }
    ultimaExecucao = Date.now();
    const duracao = ultimaExecucao - inicio;
    if (duracao > alertaLentoMs) logger.aviso(`${nome} demorou ${duracao} ms (intervalo: ${intervaloMs} ms).`);
    return duracao;
  }

  async function laco() {
    if (!ativo) return;
    rodadaAtual = rodada();
    const duracao = await rodadaAtual;
    if (ativo) timer = setTimeout(laco, Math.max(0, intervaloMs - duracao));
  }

  laco();
  return {
    async parar() {
      ativo = false;
      clearTimeout(timer);
      await rodadaAtual;
    },
    ultimaExecucao: () => ultimaExecucao,
  };
}

module.exports = { executarPeriodicamente };
