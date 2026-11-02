'use strict';
/**
 * [NOVO] Os dois serviços (rodízio de pessoas e robôs) no RodizioService: o retrato da URA, a troca de
 * eventos, a rede de segurança dos 30 s e o ciclo do benura-robos. O formato da conversa está em
 * separacao.js. Aplicado em RodizioService.prototype: `this` é o próprio serviço.
 */

const { Classe } = require('../domain/rodizio');
const { mapearComLimite } = require('../utils/concorrencia');
const { montarRetrato, aplicarRetrato, montarResposta, aplicarResposta } = require('./separacao');

const metodosDaSeparacao = {
  /**
   * Quando a regra do ocioso devolve este ramal (o primeiro instante em que deveDevolver vale), ou
   * null se não sai (fixo, travado, em atendimento, em transferência). Vai no retrato para o de robôs.
   */
  saidaPrevista(ramal, agora) {
    if (this.deveDevolver(ramal, agora)) return agora;
    const info = this.statusUra.get(ramal);
    const desde = info?.presoLivreDesde ?? (info?.classe === Classe.LIVRE ? info.livreDesde : null);
    if (desde == null) return null;
    const saiEm = desde + this.limiteOciosoMs(ramal);
    return saiEm > agora && this.deveDevolver(ramal, saiEm) ? saiEm : null;
  },

  /** O retrato da URA que o de pessoas manda ao de robôs. */
  retratoDaUra(agora = Date.now()) {
    return montarRetrato(this, agora);
  },

  /** O de robôs tem um retrato recente? (vale por 3 ciclos da URA, pelo menos 15 s) */
  retratoFresco(agora = Date.now()) {
    const validadeMs = Math.max(3 * (this.cfg.pollUraMs ?? 5000), 15_000);
    return this.retratoRecebidoEm != null && agora - this.retratoRecebidoEm <= validadeMs;
  },

  /**
   * POST /interno/ura no de robôs: aplica o retrato e os eventos novos, responde na hora e decide
   * os robôs em seguida (a resposta não espera a Argus).
   */
  receberRetrato(corpo, agora = Date.now()) {
    this.filaParaOutroLado.confirmar(corpo?.ack);
    aplicarRetrato(this, corpo?.retrato, agora);
    for (const e of this.recebidosDoOutroLado.novos(corpo)) this.comCuidado(() => this.aplicarEventoDePessoas(e), e);
    const resposta = montarResposta(this);
    setImmediate(() => this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após o retrato da URA: ${e.message}`)));
    return resposta;
  },

  /** Um evento que não deu para aplicar fica no log; os outros (e a conversa) seguem. */
  comCuidado(fn, evento) {
    try {
      fn();
    } catch (e) {
      this.log.aviso(`Evento "${evento?.tipo}" do outro serviço não aplicado: ${e.message}`);
    }
  },

  /** No de robôs: derivação (a taxa e a URA passiva) e callback do webhook (o ajuste), vindos do de pessoas. */
  aplicarEventoDePessoas(e) {
    if (e.tipo === 'derivacao') this.registrarDerivacao(e.ts, e.esperaMs ?? null, e.ramal ?? null);
    else if (e.tipo === 'callback' && e.callback) this.ajustarPorCallback(e.callback, e.situacao ?? 'webhook do rodízio de pessoas', e.ts);
  },

  /** No de pessoas: pânico (TPA), encerramentos e callbacks do relatório de ligações, vindos do de robôs. */
  aplicarEventoDosRobos(e) {
    if (e.tipo === 'panico') this.estatisticas?.registrarPanico(e.panico, e.ts);
    else if (e.tipo === 'encerramento' && e.encerramento) this.estatisticas?.registrarEncerramento(e.ts, e.encerramento, 'relatório');
    else if (e.tipo === 'callback') this.termometro?.registrarCallback(e.ts);
  },

  /** No de pessoas: manda o retrato ao de robôs. Chamadas juntas não se sobrepõem (vai mais uma depois). */
  async enviarAosRobos() {
    if (!this.ligacaoRobos) return;
    if (this.enviandoAosRobos) {
      this.reenviarAosRobos = true;
      return;
    }
    this.enviandoAosRobos = true;
    try {
      do {
        this.reenviarAosRobos = false;
        await this.trocarComRobos(Date.now());
      } while (this.reenviarAosRobos);
    } finally {
      this.enviandoAosRobos = false;
    }
  },

  async trocarComRobos(agora = Date.now()) {
    const corpo = { retrato: this.retratoDaUra(agora), ...this.filaParaOutroLado.pendentes(), ack: this.recebidosDoOutroLado.ack() };
    let resposta;
    try {
      resposta = await this.ligacaoRobos.enviar(corpo);
    } catch (e) {
      await this.vigiarServicoDosRobos(agora, e);
      return;
    }
    if (this.robosSemResposta) this.log.info('Serviço dos robôs respondendo de novo.');
    this.robosRespondeuEm = agora;
    this.robosSemResposta = false;
    this.emergenciaDosRobos = false;
    aplicarResposta(this, resposta);
  },

  /**
   * Rede de segurança: o de robôs sem responder por ROBOS_SEM_RESPOSTA_S (30 s), os robôs parados
   * param de discar (os em ligação terminam). Uma vez por queda; o vigia de saúde do painel avisa.
   */
  async vigiarServicoDosRobos(agora, erro) {
    const semMs = agora - (this.robosRespondeuEm ?? this.iniciadoEm);
    if (!this.robosSemResposta) {
      this.robosSemResposta = true;
      this.log.aviso(`Serviço dos robôs (benura-robos) não respondeu: ${erro.message}. Tentando de novo a cada ciclo.`);
    }
    if (semMs < (this.cfg.robosSemRespostaMs ?? 30_000) || this.emergenciaDosRobos || !this.robosDeEmergencia) return;
    this.emergenciaDosRobos = true;
    this.log.erro(`Serviço dos robôs sem responder há ${Math.round(semMs / 1000)} s: os robôs parados param de discar `
      + '(os em ligação terminam). Veja o benura-robos no painel (aba Serviços).');
    try {
      if (this.ramaisRobos.length) await this.robosDeEmergencia.sincronizar(this.ramaisRobos);
      await this.robosDeEmergencia.encerrarSemDerrubar('serviço dos robôs sem responder');
    } catch (e) {
      this.log.erro(`Não foi possível parar os robôs: ${e.message}`);
    }
  },

  /**
   * Ciclo do de robôs: com o retrato fresco, só decide; sem ele (o de pessoas parado ou caído), lê
   * a URA sozinho, só leitura: ninguém sai, ninguém é movido nem relogado.
   */
  async cicloDosRobos() {
    const agora = Date.now();
    if (!this.retratoFresco(agora)) {
      if (!this.lendoSozinho) {
        this.lendoSozinho = true;
        this.log.aviso('Sem o retrato da URA do rodízio de pessoas: os robôs leem a URA sozinhos (ninguém sai da URA enquanto isso).');
      }
      this.saidas = new Map();
      await mapearComLimite([...this.ramaisUra], this.cfg.concorrencia ?? 10, (ramal) => this.atualizarStatusUra(ramal));
    } else if (this.lendoSozinho) {
      this.lendoSozinho = false;
      this.log.info('Retrato da URA de volta: os robôs voltam a usar o do rodízio de pessoas.');
    }
    const automatico = this.modoDosRobos() === 'automatico';
    if (automatico) this.prepararSaidaDoUltimoLivre([...this.ramaisUra], agora);
    await this.avaliarRobos();
    this.registrarFoto(Date.now());
    if (automatico) this.verificarPassividade(agora);
  },

  /** [NOVO] O /health do benura-robos: o que o painel mostra dos robôs, e se o retrato da URA está chegando. */
  resumoDosRobos(agora = Date.now()) {
    const r = this.resumo();
    return {
      papel: this.papel,
      robos: r.robos,
      panico: r.panico,
      ajusteRobos: r.ajusteRobos,
      ultimoLivreSaindo: r.ultimoLivreSaindo,
      dryRun: r.dryRun,
      desligandoAutomacao: r.desligandoAutomacao,
      ramaisRobos: [...this.ramaisRobos],
      saudeArgus: r.saudeArgus,
      retratoDaUra: {
        fresco: this.retratoFresco(agora),
        haMs: this.retratoRecebidoEm != null ? agora - this.retratoRecebidoEm : null,
        lendoSozinho: Boolean(this.lendoSozinho),
      },
    };
  },
};

module.exports = { metodosDaSeparacao };
