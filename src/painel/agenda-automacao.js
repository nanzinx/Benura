'use strict';
/**
 * [NOVO] Agenda da automação: o painel aperta sozinho "Desligar automação" às
 * AGENDA_DESLIGAR (18:00) e "Religar automação" às AGENDA_RELIGAR (08:00), de
 * segunda a sexta. Assim a noite e o fim de semana não entram no relatório do dia.
 *
 *  - Só age na hora marcada (até JANELA_MIN depois): quem religar à mão de noite,
 *    para hora extra, continua ligado; um reinício do painel fora da hora não faz nada.
 *  - Às 08:00 só religa o que ela mesma desligou: desligada à mão fica desligada
 *    (e no PC reserva, que fica desligado, ela não liga nada).
 *  - Sem horário no .env, não faz nada.
 *  - [NOVO] Antes de desligar, aoFimDoDia() (o resumo do dia para o BenHub), com o rodízio
 *    ainda no ar. Se ele falhar, desliga do mesmo jeito.
 */

const { dataLocal, horaLocal, diaDaSemanaLocal } = require('../utils/datas');

const POR_AGENDA = 'agenda do BenURA';
const JANELA_MIN = 5;
const DIAS_UTEIS = [1, 2, 3, 4, 5];
const VERIFICAR_MS = 30_000;

const minutos = (hhmm) => {
  const [h, m] = String(hhmm).split(':').map(Number);
  return h * 60 + m;
};
const naHora = (hora, alvo) => {
  const d = minutos(hora) - minutos(alvo);
  return d >= 0 && d < JANELA_MIN;
};

class AgendaAutomacao {
  /**
   * @param {object} deps
   * @param {{ estado(): { estado: string, por: string|null }, desligar(por: string): object, religar(por: string): object,
   *          prepararParaAgir?(por: string): Promise<{ ok: boolean, motivo?: string }> }} deps.automacao
   * @param {{ desligarAs: string, religarAs: string, fuso: string }} deps.cfg
   * @param {() => Promise<void>} [deps.aoFimDoDia] - [NOVO] logo antes do desligamento das 18:00
   */
  constructor({ automacao, cfg, logger, agora = Date.now, aoFimDoDia = null }) {
    Object.assign(this, { automacao, cfg, log: logger, agora, aoFimDoDia });
    this.feitas = new Set(); // "AAAA-MM-DD desligar|religar"
  }

  get ativa() {
    return Boolean(this.cfg.desligarAs || this.cfg.religarAs);
  }

  verificar() {
    if (!this.ativa) return;
    const agora = new Date(this.agora());
    const { fuso } = this.cfg;
    const dia = dataLocal(fuso, agora);
    const hora = horaLocal(fuso, agora);
    const util = DIAS_UTEIS.includes(diaDaSemanaLocal(fuso, agora));
    if (util && this.cfg.desligarAs && naHora(hora, this.cfg.desligarAs)) return this.uma(`${dia} desligar`, () => this.desligar());
    if (util && this.cfg.religarAs && naHora(hora, this.cfg.religarAs)) return this.uma(`${dia} religar`, () => this.religar());
    return undefined;
  }

  uma(chave, acao) {
    if (this.feitas.has(chave)) return;
    this.feitas.add(chave);
    if (this.feitas.size > 20) this.feitas.delete(this.feitas.values().next().value);
    return acao();
  }

  desligar() {
    if (this.automacao.estado().estado !== 'ligada') return undefined;
    if (!this.aoFimDoDia) return this.desligarJa();
    return Promise.resolve()
      .then(() => this.aoFimDoDia())
      .catch((e) => this.log.aviso(`Agenda: o resumo do dia não saiu (${e.message}).`))
      .then(() => this.desligarJa());
  }

  desligarJa() {
    if (this.automacao.estado().estado !== 'ligada') return;
    const r = this.automacao.desligar(POR_AGENDA);
    this.log.aviso(r.iniciado ? `Agenda: desligando a automação (${this.cfg.desligarAs}).` : `Agenda: não deu para desligar a automação (${r.motivo}).`);
  }

  religar() {
    const e = this.automacao.estado();
    if (e.estado !== 'desligada' || e.por !== POR_AGENDA) return undefined;
    // Como o botão: pega antes a trava dos dois PCs (com o outro PC agindo, não religa).
    if (!this.automacao.prepararParaAgir) return this.religarJa();
    return this.automacao.prepararParaAgir(POR_AGENDA).then((p) => {
      if (p.ok) return this.religarJa();
      this.log.aviso(`Agenda: não religou a automação (${p.motivo}).`);
      return undefined;
    });
  }

  religarJa() {
    const r = this.automacao.religar(POR_AGENDA);
    this.log.aviso(r.iniciado ? `Agenda: religando a automação (${this.cfg.religarAs}).` : `Agenda: não deu para religar a automação (${r.motivo}).`);
  }

  /** Confere a cada VERIFICAR_MS. @returns {{ parar(): void }} */
  iniciar() {
    if (!this.ativa) return { parar() {} };
    this.log.info(`Agenda da automação: desliga às ${this.cfg.desligarAs || '—'} e religa às ${this.cfg.religarAs || '—'}, de segunda a sexta.`);
    const falhou = (e) => this.log.aviso(`Agenda da automação: ${e.message}`);
    const id = setInterval(() => {
      try {
        Promise.resolve(this.verificar()).catch(falhou);
      } catch (e) {
        falhou(e);
      }
    }, VERIFICAR_MS);
    return { parar: () => clearInterval(id) };
  }
}

module.exports = { AgendaAutomacao, POR_AGENDA };
