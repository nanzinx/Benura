'use strict';
/**
 * Liga e desliga os robôs (operadores virtuais) da URA, um a um, para manter
 * a quantidade decidida pela regra (domain/rodizio.decidirRobos).
 *
 * Desligar é a ação de emergência: evita que clientes entrem numa fila sem
 * humano para atender. Por isso usa poucas tentativas rápidas em paralelo e
 * segue mesmo durante a pausa de limite da Argus. Ao reduzir (sem zerar),
 * desliga primeiro os robôs que não estão em ligação.
 *
 * Quem está ligado é lido da Argus (sincronizar, a cada atualização de grupos)
 * e atualizado a cada comando que dá certo.
 */

const { Classe, classificarStatus, escolherParaDesligar, jaEstavaDeslogado } = require('../domain/rodizio');
const { esperar } = require('../utils/http-client');
const { mapearComLimite } = require('../utils/concorrencia');

const TENTATIVAS_DESLIGAR = 3;
const ESPERA_ENTRE_TENTATIVAS_MS = 500;
const LIGAR_EM_PARALELO = 5;

class ControleRobos {
  /**
   * @param {object} deps
   * @param {import('../integrations/argus/argus.client').ArgusClient} deps.client
   * @param {{ dryRun: boolean, concorrencia: number, descricoesStatus: object }} deps.cfg
   * @param {object} deps.logger
   */
  constructor({ client, cfg, logger }) {
    this.client = client;
    this.cfg = cfg;
    this.log = logger;
    /** @type {Set<string>|null} ramais ligados; null = ainda não lido */
    this.ligados = null;
    this.ultimaReducao = 0;
    this.alvo = null;
  }

  /** Para a regra de decisão. */
  situacao(total) {
    return { ligados: this.ligados ? this.ligados.size : null, total, ultimaReducao: this.ultimaReducao };
  }

  /** Para o /health. */
  resumo() {
    return { ligados: this.ligados ? this.ligados.size : null, alvo: this.alvo };
  }

  /** Lê da Argus quais robôs estão logados (quem não respondeu mantém o que se sabia). */
  async sincronizar(ramais) {
    const lidos = await mapearComLimite(ramais, this.cfg.concorrencia, (r) => this.lerClasse(r));
    const anterior = this.ligados || new Set();
    this.ligados = new Set(lidos
      .filter(({ ramal, classe }) => (classe === Classe.ERRO ? anterior.has(ramal) : classe !== Classe.OFFLINE))
      .map(({ ramal }) => ramal));
  }

  async lerClasse(ramal) {
    try {
      return { ramal, classe: classificarStatus(await this.client.statusOperador(ramal), this.cfg.descricoesStatus) };
    } catch {
      return { ramal, classe: Classe.ERRO };
    }
  }

  /**
   * Reduz até `alvo`. Com alvo 0, desliga TODOS os robôs conhecidos (emergência,
   * sem consultar nada antes).
   */
  async reduzir(ramais, alvo, motivo) {
    this.alvo = alvo;
    if (alvo === 0) return this.desligar(ramais, motivo);
    const ligados = await Promise.all([...(this.ligados || [])].map((r) => this.lerClasse(r)));
    const excesso = ligados.length - alvo;
    if (excesso <= 0) return undefined;
    return this.desligar(escolherParaDesligar(ligados, excesso), motivo, alvo);
  }

  /**
   * Desloga os robôs indicados, re-tentando os que falharem.
   * Algum que resista continua contado como ligado e será tentado no próximo ciclo.
   */
  async desligar(ramais, motivo, alvo = 0) {
    if (!ramais.length) {
      this.log.erro('Nenhum robô conhecido para desligar (grupo de robôs vazio ou ainda não lido).');
      return;
    }

    const inicio = process.hrtime.bigint();
    this.ultimaReducao = Date.now();
    const pendentes = await this.deslogarComTentativas(ramais);
    const desligados = ramais.map(String).filter((r) => !pendentes.includes(r));
    // Quem resistiu continua contado como ligado (tenta de novo no próximo ciclo).
    const antes = [...(this.ligados || []), ...pendentes];
    this.ligados = new Set(antes.filter((r) => !desligados.includes(r)));

    const ms = Number(process.hrtime.bigint() - inicio) / 1e6;
    this.log.info(`ROBÔS ${alvo === 0 ? 'DESLIGADOS' : `REDUZIDOS para ${alvo}`} (${motivo}): `
      + `${desligados.length}/${ramais.length} em ${ms.toFixed(0)} ms | ligados agora: ${this.ligados.size}`);
    if (pendentes.length) this.log.aviso(`Robôs ainda logados: ${pendentes.join(', ')}. Nova tentativa no próximo ciclo.`);
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

  /** Liga, um a um, os robôs desligados que faltam para chegar ao alvo. */
  async aumentar(ramais, alvo, motivo) {
    this.alvo = alvo;
    const ligados = this.ligados || new Set();
    const candidatos = ramais.map(String).filter((r) => !ligados.has(r)).slice(0, alvo - ligados.size);
    if (!candidatos.length) return;

    const resultados = await mapearComLimite(candidatos, LIGAR_EM_PARALELO, (r) => this.logar(r));
    const ok = candidatos.filter((_, i) => resultados[i]);
    this.ligados = new Set([...ligados, ...ok]);
    this.log.info(`ROBÔS AUMENTADOS para ${alvo} (${motivo}): +${ok.length}/${candidatos.length} | ligados agora: ${this.ligados.size}`);
  }

  /** @returns {Promise<boolean>} true se o robô ficou logado */
  async logar(ramal) {
    if (this.cfg.dryRun) {
      this.log.info(`[DRY_RUN] Ligaria robô ${ramal}`);
      return true;
    }
    try {
      await this.client.logarOperadorVirtual(ramal);
      return true;
    } catch (e) {
      this.log.aviso(`Falha ao ligar robô ${ramal}: ${e.message}`);
      return false;
    }
  }
}

module.exports = { ControleRobos };
