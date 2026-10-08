'use strict';
/**
 * Rotas HTTP do rodízio: saúde e webhooks da Argus.
 *
 * Um único endereço recebe todos os webhooks configurados na Argus e os
 * distribui: início de atendimento → rodízio; encerramento de URA → retorno da fila.
 */

const { interpretarWebhook } = require('../domain/rodizio');

/**
 * @param {object} deps
 * @param {import('./rodizio.service').RodizioService} deps.rodizio
 * @param {import('../retorno-fila/retorno-fila.service').RetornoFilaService} [deps.retornoFila]
 * @param {{ ultimoCicloUra(): number, ultimoCicloAtivo(): number }} deps.ciclos
 * @param {object} deps.logger
 */
function criarRotasDoRodizio({ rodizio, retornoFila, ciclos, logger }) {
  async function health() {
    return {
      status: 200,
      corpo: {
        // Campos do script original (monitoramentos existentes continuam funcionando)
        lastLoopUra: ciclos.ultimoCicloUra(),
        lastLoopAtivo: ciclos.ultimoCicloAtivo(),
        uptime: process.uptime(),
        ...rodizio.resumo(),
      },
    };
  }

  /** Início de atendimento de um operador → rodízio (URA e robôs). */
  function encaminharAoRodizio(corpo) {
    const evento = interpretarWebhook(corpo);
    if (evento) rodizio.registrarAtendimento(evento.ramal);
  }

  /** Encerramento de URA → retorno da fila. Não bloqueia a resposta à Argus. */
  function encaminharAoRetorno(corpo) {
    if (!retornoFila) return;
    retornoFila.processar(corpo).catch((e) => logger.erro(`Retorno da fila falhou: ${e.message}`));
  }

  async function webhook({ corpo }) {
    logger.debug(`Webhook recebido (tipo ${corpo?.idTipoWebhook ?? '?'}).`);
    encaminharAoRodizio(corpo);
    encaminharAoRetorno(corpo);
    return { status: 200, corpo: { ok: true } };
  }

  return [
    { metodo: 'GET', caminho: '/health', handler: health },
    { metodo: 'POST', caminho: '/webhook', handler: webhook, protegida: true, prefixo: true },
  ];
}

module.exports = { criarRotasDoRodizio };
