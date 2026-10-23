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
 * Na primeira leitura, o callback de ligação que começou antes de o BenURA subir
 * só é marcado (não é dele e não há fotos da URA daquela hora); o que começou
 * depois é entregue normalmente (ex.: reinício logo após um callback).
 *
 * [NOVO] Leads derivados e transbordos do painel: cada ligação lida também conta nas
 * estatísticas do dia ("ATENDIMENTO" = lead derivado; abandono em fila e sem agente =
 * transbordo), sem depender dos webhooks 4 e 5. Ao subir (e na virada do dia), lê o dia
 * desde 00:00 só para isso. A chave é o idLigacao, a mesma do webhook: não conta em dobro.
 */

const { semDadosDeCliente, tipoDaLigacao, textoDaHora, duracaoDaLigacao } = require('../domain/diagnostico-callbacks');
const { instanteLocal } = require('../domain/raio-x-callback');
const { dataLocal, horaLocal } = require('../utils/datas');
const { escolherCampanha } = require('../integrations/argus/campanha');

/** Ligações vistas são esquecidas depois disso (a janela lida é bem menor). */
const LEMBRAR_MS = 30 * 60_000;
/** Só lê se houve robô ligado neste intervalo. */
const ROBO_RECENTE_MS = 10 * 60_000;
/** [NOVO] Resultado do relatório → lead derivado ou transbordo (o resto não conta). */
const ENCERRAMENTOS = Object.freeze({
  derivou: { derivou: true, motivo: 'derivou' },
  callback: { derivou: false, motivo: 'abandonou a fila' },
  semAgente: { derivou: false, motivo: 'sem agente' },
});
/** [NOVO] A leitura do dia inteiro pode ser longa. */
const PAGINAS_DO_DIA = 200;
/** [NOVO] A leitura do dia que falhou só é tentada de novo depois disso (é um relatório pesado). */
const DIA_DE_NOVO_MS = 5 * 60_000;

class VigiaCallbacks {
  /**
   * @param {object} deps
   * @param {{ ligacoesDetalhadas: Function, listarCampanhas: Function }} deps.client
   * @param {{ iniciadoEm: number, teveRoboLigado(agora: number, janelaMs: number): boolean, registrarCallbackDoRelatorio(c: object): void }} deps.rodizio
   * @param {{ gruposRobosIds: number[], idCampanha?: number, janelaMin?: number, fuso: string }} deps.cfg
   * @param {object} deps.logger
   */
  constructor({ client, rodizio, cfg, logger, perfis = null }) {
    Object.assign(this, { client, rodizio, cfg: { janelaMin: 5, ...cfg }, log: logger, perfis });
    /** idLigacao → quando foi vista */
    this.vistas = new Map();
    this.primeiraLeitura = true;
    this.falhando = false;
  }

  /** Um ciclo: lê o relatório e entrega os callbacks novos. */
  async verificar(agora = Date.now()) {
    await this.lerDiaSePreciso(agora);
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
    this.contarNosPerfis(ligacoes, agora);
    this.contarEncerramentos(ligacoes);
    const novos = ligacoes.map(semDadosDeCliente).filter((l) => tipoDaLigacao(l) === 'callback' && this.marcarNova(l, agora));
    const entregar = this.primeiraLeitura ? novos.filter((l) => this.depoisDoInicio(l)) : novos;
    if (this.primeiraLeitura && novos.length > entregar.length) {
      this.log.info(`Vigia de callbacks: ${novos.length - entregar.length} callback(s) de antes de o BenURA subir (não contam).`);
    }
    this.primeiraLeitura = false;
    for (const ligacao of entregar) this.entregar(ligacao);
  }

  /** Perfis de clientes: cada ligação final conta (na 1ª leitura, só as de depois de o BenURA subir: senão um reinício contaria em dobro). */
  contarNosPerfis(ligacoes, agora) {
    if (!this.perfis) return;
    for (const l of ligacoes) if (!this.primeiraLeitura || this.depoisDoInicio(l)) this.perfis.registrarLigacao(l, agora);
    this.perfis.manter(agora);
  }

  /** A ligação começou depois de o BenURA subir? (sem hora no relatório, não dá para saber: não conta) */
  depoisDoInicio(ligacao) {
    const inicio = instanteLocal(textoDaHora(ligacao), this.cfg.fuso);
    return inicio != null && inicio >= (this.rodizio.iniciadoEm ?? Infinity);
  }

  async lerLigacoes(ultimosMinutos = this.cfg.janelaMin, maxPaginas = 5) {
    this.idCampanha ??= await escolherCampanha(this.client, this.cfg.idCampanha);
    const todas = [];
    for (const idGrupoUsuario of this.cfg.gruposRobosIds) {
      for (const l of await this.client.ligacoesDetalhadas({ idCampanha: this.idCampanha, idGrupoUsuario, ultimosMinutos }, { maxPaginas })) todas.push(l);
    }
    return todas;
  }

  /**
   * [NOVO] Ao subir e na virada do dia: lê o dia desde 00:00, só para os leads derivados e os
   * transbordos (nada de ajuste dos robôs nem raio-x de callback antigo). Falhou: tenta de novo.
   */
  async lerDiaSePreciso(agora) {
    const hoje = dataLocal(this.cfg.fuso, new Date(agora));
    if (this.diaLido === hoje || !this.rodizio.registrarEncerramentoDoRelatorio) return;
    if (this.diaFalhouEm != null && agora - this.diaFalhouEm < DIA_DE_NOVO_MS) return;
    const [h, m] = horaLocal(this.cfg.fuso, new Date(agora)).split(':').map(Number);
    let lidas = 0;
    let novas = 0;
    try {
      // Página por página, sem juntar o dia inteiro na memória.
      this.idCampanha ??= await escolherCampanha(this.client, this.cfg.idCampanha);
      for (const idGrupoUsuario of this.cfg.gruposRobosIds) {
        await this.client.ligacoesDetalhadas({ idCampanha: this.idCampanha, idGrupoUsuario, ultimosMinutos: h * 60 + m + 1 }, {
          maxPaginas: PAGINAS_DO_DIA,
          aoReceber: (pagina) => { lidas += pagina.length; novas += this.contarEncerramentos(pagina); },
        });
      }
    } catch (e) {
      this.diaFalhouEm = agora;
      this.log.aviso(`Vigia de callbacks: não foi possível ler o dia desde 00:00 (${e.message}). Tenta de novo em ${DIA_DE_NOVO_MS / 60_000} min.`);
      return;
    }
    this.diaLido = hoje;
    this.diaFalhouEm = null;
    this.log.info(`Vigia de callbacks: dia lido desde 00:00 (${lidas} ligação(ões) dos robôs; ${novas} nova(s) nos leads derivados e transbordos).`);
  }

  /** [NOVO] Cada ligação lida conta uma vez nos leads derivados e transbordos. @returns {number} quantas eram novas */
  contarEncerramentos(ligacoes) {
    if (!this.rodizio.registrarEncerramentoDoRelatorio) return 0;
    let novas = 0;
    for (const bruta of ligacoes) {
      const l = semDadosDeCliente(bruta);
      const tipo = ENCERRAMENTOS[tipoDaLigacao(l)];
      if (!tipo) continue;
      const contou = this.rodizio.registrarEncerramentoDoRelatorio({
        chave: chaveDaLigacao(l), ...tipo, filaSeg: null, quando: instanteLocal(textoDaHora(l), this.cfg.fuso),
      });
      if (contou) novas += 1;
    }
    return novas;
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
