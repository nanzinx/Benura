'use strict';
/**
 * Transferências de operador entre grupos com "esfriamento" por ramal.
 *
 * Se a Argus RECUSA a transferência de um ramal (erro de negócio: ex. operador
 * não vinculado à campanha), tentar de novo a cada 500 ms só gera ruído. O ramal
 * fica em espera crescente (1 min por falha, até 5 min). Falhas de rede não
 * contam: são passageiras e a próxima rodada tenta de novo normalmente.
 */

const { ArgusError } = require('../integrations/argus/argus.client');

const ESFRIAMENTO_POR_FALHA_MS = 60_000;
const ESFRIAMENTO_MAXIMO_MS = 5 * 60_000;
const FALHAS_PARA_ALERTA = 3;

/** Recusa da Argus (codStatus < 1 ou falha individual), não falha de transporte. */
const ehRecusaDeNegocio = (e) => e instanceof ArgusError && Boolean(e.resposta);

class Transferencias {
  /**
   * @param {object} deps
   * @param {import('../integrations/argus/argus.client').ArgusClient} deps.client
   * @param {{ dryRun: boolean }} deps.cfg
   * @param {object} deps.logger
   */
  constructor({ client, cfg, logger }) {
    this.client = client;
    this.cfg = cfg;
    this.log = logger;
    this.falhas = new Map(); // ramal → falhas seguidas
    this.liberadoEm = new Map(); // ramal → timestamp a partir do qual pode tentar de novo
  }

  emEspera(ramal) {
    return (this.liberadoEm.get(ramal) || 0) > Date.now();
  }

  /** @returns {Promise<boolean>} true se transferiu */
  async transferir(ramal, grupoDestinoId) {
    if (this.emEspera(ramal)) return false;
    if (this.cfg.dryRun) {
      this.log.info(`[DRY_RUN] Transferiria ramal ${ramal} → grupo ${grupoDestinoId}`);
      return true;
    }

    try {
      await this.client.transferirOperador(ramal, grupoDestinoId);
      this.falhas.delete(ramal);
      return true;
    } catch (e) {
      this.registrarFalha(ramal, e);
      return false;
    }
  }

  registrarFalha(ramal, e) {
    this.log.debug(`Transferência do ramal ${ramal} falhou: ${e.message}`);
    if (!ehRecusaDeNegocio(e)) return;

    const falhas = (this.falhas.get(ramal) || 0) + 1;
    this.falhas.set(ramal, falhas);
    this.liberadoEm.set(ramal, Date.now() + Math.min(falhas * ESFRIAMENTO_POR_FALHA_MS, ESFRIAMENTO_MAXIMO_MS));
    if (falhas >= FALHAS_PARA_ALERTA) this.log.aviso(`Ramal ${ramal}: transferência recusada ${falhas} vezes seguidas (${e.message}).`);
  }
}

module.exports = { Transferencias };
