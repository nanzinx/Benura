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
 *
 * [NOVO] Ordem fixa, como a supervisão faz à mão (domain/rodizio.ordenarRobos):
 * liga em ordem crescente (OPER VIRTUAL 1, 2… e os DTMF no fim), um após o outro,
 * e reduz do último para o primeiro, pulando quem está em ligação.
 */

const { Classe, classificarStatus, escolherParaDesligar, jaEstavaDeslogado, ordenarRobos } = require('../domain/rodizio');
const { esperar } = require('../utils/http-client');
const { mapearComLimite } = require('../utils/concorrencia');

const TENTATIVAS_DESLIGAR = 3;
/** Depois de um comando nosso, a Argus pode demorar a refletir: não é mudança "por fora". */
const CARENCIA_COMANDO_MS = 15_000;
/** Avisa no máximo uma vez nesse intervalo sobre robôs mexidos por fora. */
const INTERVALO_AVISO_FORA_MS = 5 * 60_000;
const ESPERA_ENTRE_TENTATIVAS_MS = 500;

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
    this.ultimoAumento = 0;
    this.alvo = null;
    /** ramal → quando o BenURA mandou ligar/desligar */
    this.ultimoComando = new Map();
    /** robôs ligados/desligados por fora do BenURA (outra cópia, script antigo, painel) */
    this.mudancasPorFora = 0;
    this.ultimoAvisoForaEm = 0;
    /** último "mantidos em ligação" logado (evita repetir a cada ciclo) */
    this.ultimoMantidos = null;
    /** [NOVO] ramal → nome do robô (do statusoperador): dá a ordem "OPER VIRTUAL 1, 2…" */
    this.nomes = new Map();
  }

  /** [NOVO] Os ramais na ordem de ligar (a de desligar é a inversa). */
  emOrdem(ramais) {
    return ordenarRobos(ramais, (r) => this.nomes.get(String(r)) ?? null);
  }

  /** Para a regra de decisão. */
  situacao(total) {
    return { ligados: this.ligados ? this.ligados.size : null, total, ultimaReducao: this.ultimaReducao, ultimoAumento: this.ultimoAumento };
  }

  /** Para o /health. */
  resumo() {
    return { ligados: this.ligados ? this.ligados.size : null, alvo: this.alvo, mudancasPorFora: this.mudancasPorFora };
  }

  /** Lê da Argus quais robôs estão logados (quem não respondeu mantém o que se sabia). */
  async sincronizar(ramais) {
    const lidos = await mapearComLimite(ramais, this.cfg.concorrencia, (r) => this.lerClasse(r));
    const anterior = this.ligados;
    this.ligados = new Set(lidos
      .filter(({ ramal, classe }) => (classe === Classe.ERRO ? (anterior || new Set()).has(ramal) : classe !== Classe.OFFLINE))
      .map(({ ramal }) => ramal));
    if (anterior) this.conferirMudancasPorFora(anterior, this.ligados);
  }

  /**
   * Robô que mudou de estado sem comando nosso recente foi mexido por fora:
   * outra cópia do rodízio, o script antigo ou alguém no painel. As duas partes
   * brigando fazem os robôs oscilarem sem parar; o aviso diz isso no log.
   */
  conferirMudancasPorFora(esperados, lidos, agora = Date.now()) {
    if (this.cfg.dryRun) return; // em DRY_RUN nada muda de verdade: a diferença é esperada
    if (this.cfg.robosModo === 'panico') return; // no modo pânico, quem liga os robôs é a supervisão
    const recente = (r) => agora - (this.ultimoComando.get(r) || 0) < CARENCIA_COMANDO_MS;
    const ligadosFora = [...lidos].filter((r) => !esperados.has(r) && !recente(r));
    const desligadosFora = [...esperados].filter((r) => !lidos.has(r) && !recente(r));
    const total = ligadosFora.length + desligadosFora.length;
    if (!total) return;

    this.mudancasPorFora += total;
    if (agora - this.ultimoAvisoForaEm < INTERVALO_AVISO_FORA_MS) return;
    this.ultimoAvisoForaEm = agora;
    this.log.aviso(`Robôs mexidos por fora do BenURA: ${ligadosFora.length} ligado(s), ${desligadosFora.length} desligado(s) `
      + 'sem comando nosso. Outra cópia do rodízio, o script antigo ou alguém no painel? '
      + 'Para a supervisão assumir os robôs, use POST /robos/manual.');
  }

  async lerClasse(ramal) {
    try {
      const status = await this.client.statusOperador(ramal);
      if (status?.nome) this.nomes.set(String(ramal), String(status.nome).trim());
      return { ramal, classe: classificarStatus(status, this.cfg.descricoesStatus) };
    } catch {
      return { ramal, classe: Classe.ERRO };
    }
  }

  /**
   * Reduz até `alvo`.
   * - Alvo 0 (ninguém livre na URA): desliga TODOS os robôs conhecidos na hora,
   *   inclusive os em ligação. É a emergência: não há quem receba a derivação.
   * - Alvo > 0: desliga só os que não estão em ligação. Os que estão falando
   *   continuam contados como ligados e saem num próximo ciclo, ao terminar.
   */
  async reduzir(ramais, alvo, motivo) {
    this.alvo = alvo;
    if (alvo === 0) return this.desligar(ramais, motivo);
    return this.reduzirPoupando(alvo, motivo);
  }

  /**
   * Para de discar sem derrubar ligação: desliga os robôs parados; os que estão
   * em ligação terminam a chamada e saem num próximo ciclo. Usado enquanto o
   * último livre da URA espera para voltar ao Ativo.
   */
  async encerrarSemDerrubar(motivo) {
    this.alvo = 0;
    return this.reduzirPoupando(0, motivo);
  }

  /** Desliga o excesso sobre `alvo`, só entre os robôs que não estão em ligação. */
  async reduzirPoupando(alvo, motivo) {
    // Do último para o primeiro da ordem: os primeiros da lista são os últimos a sair.
    const emOrdemDeSaida = this.emOrdem([...(this.ligados || [])]).reverse();
    const ligados = await Promise.all(emOrdemDeSaida.map((r) => this.lerClasse(r)));
    const excesso = ligados.length - alvo;
    if (excesso <= 0) return undefined;

    const escolhidos = escolherParaDesligar(ligados, excesso);
    const mantidos = excesso - escolhidos.length;
    if (!escolhidos.length) return this.logarMantidos(alvo, motivo, mantidos);
    return this.desligar(escolhidos, motivo, alvo, mantidos);
  }

  /** Nada a desligar agora: todo o excesso está em ligação. Avisa uma vez por alvo. */
  logarMantidos(alvo, motivo, mantidos) {
    const chave = `${alvo}:${mantidos}`;
    if (this.ultimoMantidos === chave) return;
    this.ultimoMantidos = chave;
    this.log.info(`ROBÔS: alvo ${alvo} (${motivo}), mas ${mantidos} em ligação mantidos até terminar.`);
  }

  /**
   * Desloga os robôs indicados, re-tentando os que falharem.
   * Algum que resista continua contado como ligado e será tentado no próximo ciclo.
   */
  async desligar(ramais, motivo, alvo = 0, mantidos = 0) {
    this.ultimoMantidos = null;
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
      + `${desligados.length}/${ramais.length} em ${ms.toFixed(0)} ms | ligados agora: ${this.ligados.size}`
      + `${mantidos ? ` | ${mantidos} em ligação mantidos até terminar` : ''}`);
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
    this.ultimoComando.set(String(ramal), Date.now());
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

  /**
   * Liga os robôs que faltam para o alvo, no máximo `degrauSubida` por vez: todos
   * discando no mesmo segundo trazem derivações juntas e o excedente vira callback.
   */
  async aumentar(ramais, alvo, motivo) {
    this.alvo = alvo;
    const ligados = this.ligados || new Set();
    const faltam = alvo - ligados.size;
    const degrau = this.cfg.degrauSubida > 0 ? Math.min(faltam, this.cfg.degrauSubida) : faltam;
    // Os próximos da ordem crescente que ainda não estão ligados, um após o outro (como à mão).
    const candidatos = this.emOrdem(ramais).filter((r) => !ligados.has(r)).slice(0, degrau);
    if (!candidatos.length) return;
    this.ultimoAumento = Date.now();

    const ok = [];
    for (const r of candidatos) if (await this.logar(r)) ok.push(r);
    this.ligados = new Set([...ligados, ...ok]);
    const resto = alvo - this.ligados.size;
    this.log.info(`ROBÔS AUMENTADOS para ${alvo} (${motivo}): +${ok.length}/${candidatos.length} | ligados agora: ${this.ligados.size}`
      + `${resto > 0 ? ` | faltam ${resto} (próximo degrau)` : ''}`);
  }

  /** @returns {Promise<boolean>} true se o robô ficou logado */
  async logar(ramal) {
    this.ultimoComando.set(String(ramal), Date.now());
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
