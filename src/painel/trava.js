'use strict';
/**
 * [NOVO] Trava dos dois PCs (servidor e reserva): só um age de verdade na Argus.
 *
 * Fica na Cloudflare (functions/trava, base D1). Quem age de verdade (automação
 * ligada e fora do Modo simulação) segura a trava e a renova a cada TRAVA_RENOVAR_MS;
 * ela vale TRAVA_VALIDADE_MS. Cada renovação que dá certo vira a posse local
 * (utils/posse.js), que roteador, rodízio e rotinas exigem para agir.
 *
 *  - pegar: livre, já deste PC, ou (no clique: Religar, sair da simulação, Assumir)
 *    vencida. Com o outro PC agindo, recusa com o motivo.
 *  - soltar: ao desligar a automação ou ligar a simulação (automacao.js).
 *  - sozinho, este PC só retoma uma trava livre ou que era dele (ex.: reiniciou).
 *    A de outro PC, mesmo vencida, só com clique.
 *  - perdeu a trava (outro pegou) ou ficou sem resposta da Cloudflare por mais
 *    de metade da validade: tira a posse e pede ao rodízio para desligar os robôs.
 *
 * Sem TRAVA_URL, não faz nada (tudo como antes).
 */

const { gravarPosse, apagarPosse, lerPosse } = require('../utils/posse');

const hora = (ms) => (ms ? new Date(ms).toLocaleTimeString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit' }) : '?');

class Trava {
  /**
   * @param {object} deps
   * @param {object} deps.cfg - cfg.trava
   * @param {string} deps.arquivoPosse - cfg.automacao.posse.arquivo
   * @param {(motivo: string) => void} [deps.aoPerder] - desliga os robôs em ordem
   * @param {typeof fetch} [deps.fetch]
   * @param {object} deps.logger
   */
  constructor({ cfg, arquivoPosse, aoPerder = () => {}, fetch: buscar = globalThis.fetch, logger, agora = Date.now }) {
    Object.assign(this, { cfg, arquivoPosse, aoPerder, buscar, log: logger, agora });
    this.minha = false;
    this.ultimaOk = null; // última renovação (ou pegada) que deu certo
    this.remota = null; // o que a Cloudflare disse por último
    this.erro = null;
    this.perdeuAvisado = false;
  }

  get ativa() {
    return Boolean(this.cfg.url);
  }

  get nome() {
    return this.cfg.nomePc;
  }

  /** @returns {Promise<{ status: number, corpo: any }>} status 0: sem resposta */
  async pedir(metodo, acao, corpo) {
    const headers = {
      'X-Benura-Trava': this.cfg.segredo,
      ...(corpo ? { 'Content-Type': 'application/json' } : {}),
      ...(this.cfg.accessId ? { 'CF-Access-Client-Id': this.cfg.accessId, 'CF-Access-Client-Secret': this.cfg.accessSegredo } : {}),
    };
    try {
      const r = await this.buscar(`${this.cfg.url}${acao ? `/${acao}` : ''}`, {
        method: metodo, headers, body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(8000),
      });
      const json = await r.json().catch(() => null);
      if (r.status !== 200 && r.status !== 409) {
        this.erro = json?.erro ?? `HTTP ${r.status}`;
        return { status: 0, corpo: null };
      }
      this.erro = null;
      if (json) this.remota = { ...json, lidaEm: this.agora() };
      return { status: r.status, corpo: json };
    } catch (e) {
      this.erro = e.name === 'TimeoutError' ? 'a Cloudflare não respondeu a tempo' : `sem resposta da Cloudflare (${e.message})`;
      return { status: 0, corpo: null };
    }
  }

  /** O motivo, em português, de não poder pegar. */
  motivoRecusa(r) {
    if (r.status === 0) return `A trava dos dois PCs não respondeu (${this.erro}). Sem ela, este PC não age de verdade: confira a internet.`;
    const t = r.corpo ?? {};
    const quem = `${t.por ? ` (por ${t.por})` : ''}`;
    if (!t.vale) return `A trava está com o PC ${t.dono}, mas venceu: ele parou de responder. Use "Assumir" para este PC agir.`;
    return `O PC ${t.dono} está agindo de verdade desde ${hora(t.desde)}${quem}. Peça para desligar a automação dele ou pôr em Modo simulação.`;
  }

  /**
   * Daria para pegar agora? (consulta, sem pegar: antes de copiar o estado do dia do outro PC)
   * @returns {Promise<{ ok: boolean, motivo?: string }>}
   */
  async podePegar({ venceu = false } = {}) {
    if (!this.ativa) return { ok: true };
    const r = await this.pedir('GET', '');
    if (r.status !== 200) return { ok: false, motivo: this.motivoRecusa({ status: 0 }) };
    const t = r.corpo ?? {};
    if (!t.dono || t.dono === this.nome || (venceu && !t.vale)) return { ok: true };
    return { ok: false, motivo: this.motivoRecusa({ status: 409, corpo: t }) };
  }

  /**
   * @param {string|null} por - quem clicou
   * @param {{ venceu?: boolean }} [opcoes] - true: pode pegar a de outro PC vencida (só com clique)
   * @returns {Promise<{ ok: boolean, motivo?: string }>}
   */
  async pegar(por, { venceu = false } = {}) {
    if (!this.ativa) return { ok: true };
    const r = await this.pedir('POST', 'pegar', { dono: this.nome, por, validadeMs: this.cfg.validadeMs, venceu });
    if (r.status !== 200) return { ok: false, motivo: this.motivoRecusa(r) };
    const tinha = this.minha;
    this.confirmar();
    if (!tinha) this.log.aviso(`Trava dos dois PCs: este PC (${this.nome}) pegou a trava${por ? ` (${por})` : ''} e passa a agir de verdade.`);
    return { ok: true };
  }

  confirmar() {
    this.minha = true;
    this.ultimaOk = this.agora();
    this.perdeuAvisado = false;
    gravarPosse(this.arquivoPosse, this.nome, new Date(this.ultimaOk));
  }

  async soltar() {
    if (!this.ativa) return;
    apagarPosse(this.arquivoPosse);
    const tinha = this.minha;
    this.minha = false;
    const r = await this.pedir('POST', 'soltar', { dono: this.nome });
    if (tinha) this.log.aviso(`Trava dos dois PCs: este PC (${this.nome}) soltou a trava${r.status ? '' : ' (a Cloudflare não respondeu: ela vence sozinha)'}; o outro PC pode agir.`);
  }

  perder(motivo) {
    this.minha = false;
    apagarPosse(this.arquivoPosse);
    if (this.perdeuAvisado) return;
    this.perdeuAvisado = true;
    this.log.erro(`Trava dos dois PCs: ${motivo}. Este PC para de agir de verdade (os robôs parados desligam; os serviços esperam a trava).`);
    this.aoPerder(motivo);
  }

  /**
   * Uma volta do laço (a cada TRAVA_RENOVAR_MS).
   * @param {{ deveAgir: boolean, ocupado: boolean }} situacao - automação ligada e fora da simulação? algo em andamento?
   */
  async tique({ deveAgir, ocupado }) {
    if (!this.ativa || ocupado) return;
    if (!deveAgir) {
      if (this.minha) await this.soltar();
      else await this.pedir('GET', '');
      return;
    }
    if (!this.minha) {
      // Sozinho, só retoma livre ou dele (reinício). A de outro PC espera o clique.
      const r = await this.pedir('POST', 'pegar', { dono: this.nome, por: this.remota?.dono === this.nome ? this.remota.por : null, validadeMs: this.cfg.validadeMs });
      if (r.status === 200) {
        this.confirmar();
        this.log.aviso(`Trava dos dois PCs: este PC (${this.nome}) retomou a trava e volta a agir de verdade.`);
      }
      return;
    }
    const r = await this.pedir('POST', 'renovar', { dono: this.nome, validadeMs: this.cfg.validadeMs });
    if (r.status === 200) return this.confirmar();
    if (r.status === 409) return this.perder(`o PC ${r.corpo?.dono ?? '?'} pegou a trava`);
    if (this.agora() - this.ultimaOk > this.cfg.validadeMs / 2) this.perder(`sem resposta da Cloudflare há ${Math.round((this.agora() - this.ultimaOk) / 1000)} s (${this.erro})`);
    return undefined;
  }

  iniciar(situacao) {
    if (!this.ativa) return { parar: () => {} };
    // Ao subir, ninguém age com a posse de antes: só depois de confirmar com a Cloudflare.
    apagarPosse(this.arquivoPosse);
    const volta = () => this.tique(situacao()).catch((e) => this.log.erro(`Trava dos dois PCs: ${e.message}`));
    void volta();
    const timer = setInterval(volta, this.cfg.renovarMs);
    timer.unref?.();
    return { parar: () => clearInterval(timer) };
  }

  /** Para o /api/visao. */
  resumo() {
    if (!this.ativa) return { ativa: false };
    const r = this.remota;
    const venceEmMs = r?.vale ? Math.max(0, r.venceEmMs - (this.agora() - r.lidaEm)) : 0;
    return {
      ativa: true,
      pc: this.nome,
      minha: this.minha,
      dono: r?.dono ?? null,
      por: r?.por ?? null,
      desde: r?.desde ? new Date(r.desde).toISOString() : null,
      vale: Boolean(r?.vale) && venceEmMs > 0,
      venceEmSeg: Math.round(venceEmMs / 1000),
      renovadaHaSeg: this.ultimaOk ? Math.round((this.agora() - this.ultimaOk) / 1000) : null,
      ultimaPosse: lerPosse(this.arquivoPosse).ultimaPosse,
      erro: this.erro,
    };
  }
}

module.exports = { Trava };
