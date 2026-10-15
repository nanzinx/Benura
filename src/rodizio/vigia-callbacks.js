'use strict';
/**
 * Vigia de callbacks pelo relatório da Argus (só leitura; vale também em DRY_RUN).
 *
 * Os webhooks da Argus nem sempre estão configurados. Sem eles, o BenURA não
 * sabia de callback nenhum: o ajuste dos robôs não descia e a análise dependia
 * de print. Aqui, a cada CALLBACKS_VERIFICAR_SEG, lê as ligações dos últimos
 * minutos dos grupos de robôs; cada callback novo ("abandono em fila") vai para
 * o rodízio, que faz o raio-x da URA naquela hora (callbacks.txt) e desce o ajuste.
 *
 * Só lê enquanto houve robô ligado nos últimos 10 min (sem robô, não há callback).
 * A primeira leitura só marca o que já existia: o callback de antes de o BenURA
 * subir não é dele.
 */

const { semDadosDeCliente, tipoDaLigacao, textoDaHora, duracaoDaLigacao } = require('../domain/diagnostico-callbacks');
const { instanteLocal } = require('../domain/raio-x-callback');
const { escolherCampanha } = require('../integrations/argus/campanha');

/** Ligações vistas são esquecidas depois disso (a janela lida é bem menor). */
const LEMBRAR_MS = 30 * 60_000;
/** Só lê se houve robô ligado neste intervalo. */
const ROBO_RECENTE_MS = 10 * 60_000;

class VigiaCallbacks {
  /**
   * @param {object} deps
   * @param {{ ligacoesDetalhadas: Function, listarCampanhas: Function }} deps.client
   * @param {{ teveRoboLigado(agora: number, janelaMs: number): boolean, registrarCallbackDoRelatorio(c: object): void }} deps.rodizio
   * @param {{ gruposRobosIds: number[], idCampanha?: number, janelaMin?: number, fuso: string }} deps.cfg
   * @param {object} deps.logger
   */
  constructor({ client, rodizio, cfg, logger }) {
    Object.assign(this, { client, rodizio, cfg: { janelaMin: 5, ...cfg }, log: logger });
    /** idLigacao → quando foi vista */
    this.vistas = new Map();
    this.primeiraLeitura = true;
    this.falhando = false;
  }

  /** Um ciclo: lê o relatório e entrega os callbacks novos. */
  async verificar(agora = Date.now()) {
    if (!this.rodizio.teveRoboLigado(agora, ROBO_RECENTE_MS)) return;
    let ligacoes;
    try {
      ligacoes = await this.lerLigacoes();
    } catch (e) {
      this.avisarFalha(e);
      return;
    }
    if (this.falhando) this.log.info('Relatório de ligações da Argus voltou a ser lido (vigia de callbacks).');
    this.falhando = false;

    for (const [id, quando] of this.vistas) if (agora - quando > LEMBRAR_MS) this.vistas.delete(id);
    const novos = ligacoes.map(semDadosDeCliente).filter((l) => tipoDaLigacao(l) === 'callback' && this.marcarNova(l, agora));
    if (this.primeiraLeitura) {
      this.primeiraLeitura = false;
      if (novos.length) this.log.info(`Vigia de callbacks: ${novos.length} callback(s) de antes de o BenURA começar a vigiar (não contam).`);
      return;
    }
    for (const ligacao of novos) this.entregar(ligacao);
  }

  async lerLigacoes() {
    this.idCampanha ??= await escolherCampanha(this.client, this.cfg.idCampanha);
    const todas = [];
    for (const idGrupoUsuario of this.cfg.gruposRobosIds) {
      todas.push(...await this.client.ligacoesDetalhadas(
        { idCampanha: this.idCampanha, idGrupoUsuario, ultimosMinutos: this.cfg.janelaMin }, { maxPaginas: 5 },
      ));
    }
    return todas;
  }

  /** @returns {boolean} true se ainda não tinha sido vista */
  marcarNova(ligacao, agora) {
    const id = chaveDaLigacao(ligacao);
    if (this.vistas.has(id)) return false;
    this.vistas.set(id, agora);
    return true;
  }

  entregar(ligacao) {
    const inicio = instanteLocal(textoDaHora(ligacao), this.cfg.fuso);
    const duracaoS = duracaoDaLigacao(ligacao) ?? 0;
    const resultado = Object.entries(ligacao).find(([c, v]) => /result/i.test(c) && typeof v === 'string')?.[1] ?? 'abandono em fila';
    this.rodizio.registrarCallbackDoRelatorio({
      motivo: resultado.toLowerCase(),
      chave: ligacao.idLigacao != null ? `ligacao:${ligacao.idLigacao}` : null,
      inicio,
      fim: inicio == null ? null : inicio + duracaoS * 1000,
      robo: ligacao.usuarioOperador ?? null,
    });
  }

  /** Avisa uma vez até voltar a funcionar (o relatório pode estar fora do ar ou sem permissão). */
  avisarFalha(e) {
    if (this.falhando) return;
    this.falhando = true;
    this.log.aviso(`Vigia de callbacks: não foi possível ler o relatório de ligações da Argus (${e.message}). Tenta de novo no próximo ciclo.`);
  }
}

/** idLigacao; sem ele, hora + robô. */
const chaveDaLigacao = (l) => (l.idLigacao != null ? `ligacao:${l.idLigacao}` : `${textoDaHora(l)}|${l.usuarioOperador ?? ''}`);

module.exports = { VigiaCallbacks };
