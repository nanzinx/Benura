'use strict';
/**
 * Rotas HTTP do rodízio: saúde e webhook de atendimento da Argus.
 */

const { interpretarWebhook } = require('../domain/rodizio');

/**
 * @param {object} deps
 * @param {import('./rodizio.service').RodizioService} deps.rodizio
 * @param {{ ultimoCicloUra(): number, ultimoCicloAtivo(): number }} deps.ciclos
 * @param {object} deps.logger
 */
function criarRotasDoRodizio({ rodizio, ciclos, logger }) {
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

  /** Webhook da Argus: só interessa o início de atendimento de um operador. */
  async function webhook({ corpo }) {
    const evento = interpretarWebhook(corpo);
    const ok = { status: 200, corpo: { ok: true } };
    if (!evento) {
      logger.debug(`Webhook ignorado (tipo ${corpo?.idTipoWebhook ?? '?'}).`);
      return ok;
    }
    rodizio.registrarAtendimento(evento.ramal);
    return ok;
  }

  return [
    { metodo: 'GET', caminho: '/health', handler: health },
    { metodo: 'POST', caminho: '/webhook', handler: webhook, protegida: true, prefixo: true },
  ];
}

module.exports = { criarRotasDoRodizio };
