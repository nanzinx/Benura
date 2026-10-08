'use strict';
/**
 * Liga e desliga os robôs (operadores virtuais) da URA.
 *
 * Desligar é a ação de emergência: evita que clientes entrem numa fila sem
 * humano para atender. Por isso usa poucas tentativas rápidas em paralelo e
 * segue mesmo durante a pausa de limite da Argus.
 */

const { EstadoRobos, jaEstavaDeslogado } = require('../domain/rodizio');
const { esperar } = require('../utils/http-client');

const TENTATIVAS_DESLIGAR = 3;
const ESPERA_ENTRE_TENTATIVAS_MS = 500;

class ControleRobos {
  /**
   * @param {object} deps
   * @param {import('../integrations/argus/argus.client').ArgusClient} deps.client
   * @param {{ grupoRobosId: number, dryRun: boolean }} deps.cfg
   * @param {object} deps.logger
   */
  constructor({ client, cfg, logger }) {
    this.client = client;
    this.cfg = cfg;
    this.log = logger;
    this.estado = EstadoRobos.DESCONHECIDO;
    this.desligadosDesde = 0;
  }

  /** Para a regra de decisão (domain/rodizio.decidirRobos). */
  situacao() {
    return { estado: this.estado, desligadosDesde: this.desligadosDesde };
  }

  /**
   * Desloga todos os robôs, re-tentando os que falharem.
   * Se algum continuar logado, o estado fica DESCONHECIDO para tentar de novo no próximo ciclo.
   */
  async desligar(ramais, motivo) {
    if (!ramais.length) {
      this.log.erro('Nenhum robô conhecido para desligar (grupo de robôs vazio ou ainda não lido).');
      return;
    }

    const inicio = process.hrtime.bigint();
    this.estado = EstadoRobos.DESLIGADOS;
    this.desligadosDesde = Date.now();

    const pendentes = await this.deslogarComTentativas(ramais);
    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    this.log.info(`ROBÔS DESLIGADOS (${motivo}): ${ramais.length - pendentes.length}/${ramais.length} em ${ms.toFixed(0)} ms`);

    if (pendentes.length) {
      this.log.aviso(`Robôs ainda logados: ${pendentes.join(', ')}. Nova tentativa no próximo ciclo.`);
      this.estado = EstadoRobos.DESCONHECIDO;
    }
  }

  /** @returns {Promise<string[]>} ramais que não foi possível deslogar */
  async deslogarComTentativas(ramais) {
    let pendentes = ramais.map(String);
    for (let tentativa = 1; tentativa <= TENTATIVAS_DESLIGAR && pendentes.length; tentativa++) {
      if (tentativa > 1) await esperar(ESPERA_ENTRE_TENTATIVAS_MS * (tentativa - 1));
      const resultados = await Promise.all(pendentes.map((r) => this.deslogar(r)));
      pendentes = pendentes.filter((_, i) => !resultados[i]);
    }
    return pendentes;
  }

  /** @returns {Promise<boolean>} true se o robô ficou deslogado */
  async deslogar(ramal) {
    if (this.cfg.dryRun) {
      this.log.info(`[DRY_RUN] Deslogaria robô ${ramal}`);
      return true;
    }
    try {
      await this.client.deslogarOperador(ramal);
      return true;
    } catch (e) {
      return this.falhaAoDeslogar(ramal, e);
    }
  }

  /** "Já deslogado" conta como sucesso. @returns {boolean} */
  falhaAoDeslogar(ramal, e) {
    if (jaEstavaDeslogado(e.resposta?.descStatus)) return true;
    this.log.debug(`Falha ao deslogar robô ${ramal}: ${e.message}`);
    return false;
  }

  /** Aciona os robôs do grupo novamente. */
  async religar(motivo) {
    if (this.cfg.dryRun) {
      this.log.info(`[DRY_RUN] Religaria robôs do grupo ${this.cfg.grupoRobosId}`);
      this.estado = EstadoRobos.LIGADOS;
      return;
    }
    try {
      const r = await this.client.logarOperadoresVirtuais(this.cfg.grupoRobosId);
      this.estado = EstadoRobos.LIGADOS;
      this.log.info(`ROBÔS RELIGADOS (${motivo}): ${r.qtdeLogados ?? '?'} logados, ${r.qtdeFalhas ?? 0} falhas`);
    } catch (e) {
      this.log.aviso(`Falha ao religar robôs: ${e.message}`);
    }
  }
}

module.exports = { ControleRobos };
