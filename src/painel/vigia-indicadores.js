'use strict';
/**
 * [NOVO] Alertas da operação, a partir do /health do rodízio (indicadores da última hora):
 *  - OPL alto: o OPL dos últimos 15 min passou de ALERTA_OPL_SEG. Avisa uma vez e de novo quando
 *    normalizar;
 *  - TOR subindo: mais de ALERTA_TOR_MIN minutos, na última hora, com alguém livre na URA e todos
 *    os robôs desligados. No máximo um aviso por hora.
 * Roda junto com o vigia de saúde (a mesma leitura do /health, sem chamada a mais). Só avisa com a
 * automação ligada e no PC que está agindo de verdade. 0 desliga cada alerta.
 */

const HORA_MS = 60 * 60_000;
/** O OPL é dos últimos 15 min: antes disso, os dados ainda não dizem nada. */
const COBERTURA_MIN = 15;

const tempo = (seg) => `${Math.floor(seg / 60)} min ${String(Math.round(seg % 60)).padStart(2, '0')} s`;

class VigiaIndicadores {
  /**
   * @param {{ automacao: object, notificador: object, cfg: { oplSeg: number, torMin: number }, logger: object, agora?: () => number }} deps
   */
  constructor({ automacao, notificador, cfg, logger, agora = Date.now }) {
    Object.assign(this, { automacao, notificador, cfg, log: logger, agora });
    this.oplAlto = false;
    this.torAvisadoEm = -Infinity;
  }

  /** @param {object|null|undefined} saudeDoRodizio - o corpo do /health do rodízio */
  async verificar(saudeDoRodizio) {
    if (this.automacao.estado().estado !== 'ligada' || !this.automacao.agindoDeVerdade()) {
      this.oplAlto = false;
      return;
    }
    const i = saudeDoRodizio?.indicadores;
    if (!i) return;
    await this.verificarOpl(i);
    await this.verificarTor(i);
  }

  async verificarOpl(i) {
    const limite = this.cfg.oplSeg;
    if (!(limite > 0) || !(i.coberturaMin >= COBERTURA_MIN)) return;
    const alto = i.opl15Seg != null && i.opl15Seg > limite;
    if (alto && !this.oplAlto) {
      this.oplAlto = true;
      await this.avisar('aviso', 'OPL alto', `OPL dos últimos 15 min: ${tempo(i.opl15Seg)} por lead (${i.derivacoes15 ?? 0} ligação(ões); o limite é ${tempo(limite)}). `
        + 'Tem gente demais livre para as ligações que chegam: confira o status da URA e os robôs no painel.');
    } else if (!alto && this.oplAlto) {
      this.oplAlto = false;
      await this.avisar('info', 'OPL normalizou', `OPL dos últimos 15 min voltou para ${i.opl15Seg != null ? tempo(i.opl15Seg) : '–'} por lead.`);
    }
  }

  async verificarTor(i) {
    const limite = this.cfg.torMin;
    if (!(limite > 0) || !(i.tor60Min > limite)) return;
    const agora = this.agora();
    if (agora - this.torAvisadoEm < HORA_MS) return;
    this.torAvisadoEm = agora;
    await this.avisar('aviso', 'TOR subindo', `${i.tor60Min} min na última hora com gente livre na URA e todos os robôs desligados (o limite é ${limite} min). `
      + 'Confira o pânico e o modo dos robôs no painel.');
  }

  avisar(nivel, titulo, texto) {
    return this.notificador.notificar({ titulo: `BenURA: ${titulo}`, texto, nivel });
  }
}

module.exports = { VigiaIndicadores };
