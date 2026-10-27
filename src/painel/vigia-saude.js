'use strict';
/**
 * [NOVO] Vigia de saúde do painel: a cada VERIFICAR_MS confere o /health dos serviços.
 * Um serviço fora do ar há mais de LIMITE_MS vira um aviso (uma vez por queda); quando
 * ele volta, outro aviso diz quanto tempo ficou fora.
 *
 * Não avisa: o atualizador (fora do ar não para a operação), com a automação desligada
 * ou mudando de estado, o componente desligado pelo painel, e o PC que não está agindo
 * de verdade (o reserva ou a simulação) — assim os dois PCs não avisam em dobro.
 */

const { horaLocal } = require('../utils/datas');

const LIMITE_MS = 5 * 60_000;
const VERIFICAR_MS = 30_000;
const IGNORAR = ['atualizador'];

const emMinutos = (ms) => {
  const m = Math.floor(ms / 60_000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min`;
};

class VigiaSaude {
  constructor({ servicos, automacao, notificador, fuso, logger, agora = Date.now, limiteMs = LIMITE_MS }) {
    Object.assign(this, { servicos, automacao, notificador, fuso, log: logger, agora, limiteMs });
    /** serviço → { desde, nome, avisado } */
    this.fora = new Map();
  }

  async verificar() {
    const e = this.automacao.estado();
    if (e.estado !== 'ligada' || !this.automacao.agindoDeVerdade()) {
      this.fora.clear();
      return;
    }
    const saude = await this.servicos.saude();
    const agora = this.agora();
    for (const [servico, s] of Object.entries(saude)) {
      if (IGNORAR.includes(servico) || e.componentes?.[`benura-${servico}`]?.desligado) {
        this.fora.delete(servico);
        continue;
      }
      const queda = this.fora.get(servico);
      if (s.online) {
        if (queda?.avisado) await this.avisar('info', `${s.nome} voltou`, `O ${s.nome} voltou a responder depois de ${emMinutos(agora - queda.desde)} fora do ar.`);
        this.fora.delete(servico);
      } else if (!queda) {
        this.fora.set(servico, { desde: agora, avisado: false });
      } else if (!queda.avisado && agora - queda.desde >= this.limiteMs) {
        queda.avisado = true;
        await this.avisar('erro', `${s.nome} fora do ar`,
          `O ${s.nome} não responde desde ${horaLocal(this.fuso, new Date(queda.desde)).slice(0, 5)} (${emMinutos(agora - queda.desde)}). Veja no painel: Serviços; no PC do BenURA, "npx pm2 status".`);
      }
    }
  }

  avisar(nivel, titulo, texto) {
    return this.notificador.notificar({ titulo: `BenURA: ${titulo}`, texto, nivel });
  }

  /** @returns {{ parar(): void }} */
  iniciar() {
    const id = setInterval(() => {
      this.verificar().catch((err) => this.log.aviso(`Vigia de saúde: ${err.message}`));
    }, VERIFICAR_MS);
    return { parar: () => clearInterval(id) };
  }
}

module.exports = { VigiaSaude, LIMITE_MS };
