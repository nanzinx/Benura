'use strict';
/**
 * [NOVO] Ações da supervisão em um atendente, pela aba Receptivo do painel (como o
 * painel do receptivo da Argus): pausar, sair da pausa, ficar disponível, deslogar e
 * mudar de grupo (Ativo ↔ URA, com trava manual: veja travas-manuais.js).
 *
 * Só para humanos da URA ou do Ativo (robô e operador virtual, não). Em DRY_RUN não
 * chama a Argus: loga o que faria. Cada ação fica no log com quem pediu.
 */

const { ArgusError } = require('../integrations/argus/argus.client');

const CACHE_PAUSAS_MS = 10 * 60_000;

/** Pedido inválido (400) ou recusado pela Argus (409). */
class AcaoRecusada extends Error {
  constructor(mensagem, status = 400) {
    super(mensagem);
    this.name = 'AcaoRecusada';
    this.status = status;
  }
}

class AcoesOperador {
  /**
   * @param {object} deps
   * @param {object} deps.client - ArgusClient
   * @param {import('./rodizio.service').RodizioService} deps.rodizio
   * @param {{ dryRun?: boolean }} deps.cfg
   * @param {object} deps.logger
   */
  constructor({ client, rodizio, cfg, logger, relogio = () => Date.now() }) {
    Object.assign(this, { client, rodizio, cfg, log: logger, relogio });
    /** { em, itens }: as pausas da Argus mudam pouco */
    this.cachePausas = null;
  }

  /** @returns {'ura'|'ativo'} onde ele está; recusa quem não é humano conhecido */
  exigirHumano(ramal) {
    const r = String(ramal ?? '').trim();
    if (!/^\d{1,20}$/.test(r)) throw new AcaoRecusada('informe o ramal do atendente');
    const onde = this.rodizio.ondeEsta(r);
    if (!onde) throw new AcaoRecusada(`ramal ${r} não é um atendente da URA nem do Ativo`);
    return onde;
  }

  /** Lista de pausas da Argus (cache de 10 min). @returns {Promise<Array<{ idPausa: number, pausaDesc: string }>>} */
  async pausasDisponiveis(ramal) {
    this.exigirHumano(ramal);
    const agora = this.relogio();
    if (this.cachePausas && agora - this.cachePausas.em < CACHE_PAUSAS_MS) return this.cachePausas.itens;
    const itens = (await this.chamar('listarpausas', () => this.client.listarPausas(String(ramal))))
      .map((p) => ({ idPausa: Number(p.idPausa), pausaDesc: String(p.pausaDesc ?? '').trim() }))
      .filter((p) => Number.isFinite(p.idPausa) && p.pausaDesc);
    this.cachePausas = { em: agora, itens };
    return itens;
  }

  async pausar(ramal, idPausa, por = null) {
    this.exigirHumano(ramal);
    const id = Number(idPausa);
    if (!Number.isInteger(id) || id < 0) throw new AcaoRecusada('informe a pausa');
    const nome = (await this.pausasDisponiveis(ramal).catch(() => [])).find((p) => p.idPausa === id)?.pausaDesc ?? `#${id}`;
    return this.executar(`Pausa ${nome} no ramal ${ramal}`, por, ramal, () => this.client.pausar(String(ramal), id));
  }

  async sairPausa(ramal, por = null) {
    this.exigirHumano(ramal);
    return this.executar(`Tirar da pausa o ramal ${ramal}`, por, ramal, () => this.client.sairPausa(String(ramal)));
  }

  async ficarDisponivel(ramal, por = null) {
    this.exigirHumano(ramal);
    return this.executar(`Deixar disponível o ramal ${ramal}`, por, ramal, () => this.client.ficarDisponivel(String(ramal)));
  }

  async deslogar(ramal, por = null) {
    this.exigirHumano(ramal);
    return this.executar(`Deslogar o ramal ${ramal}`, por, ramal, () => this.client.deslogarOperador(String(ramal)));
  }

  /** Ativo ↔ URA, e fica travado lá até liberarem. */
  async mover(ramal, para, por = null) {
    if (para !== 'ativo' && para !== 'ura') throw new AcaoRecusada('informe para onde: "ativo" ou "ura"');
    this.exigirHumano(ramal);
    const r = await this.rodizio.moverManual(String(ramal), para, por);
    if (!r.ok) throw new AcaoRecusada(r.erro || 'não foi possível mover agora', 409);
    return { ok: true, simulado: Boolean(r.simulado), jaEstava: Boolean(r.jaEstava) };
  }

  async liberar(ramal, por = null) {
    const r = String(ramal ?? '').trim();
    if (!/^\d{1,20}$/.test(r)) throw new AcaoRecusada('informe o ramal do atendente');
    return { ok: true, estavaTravado: await this.rodizio.liberarTrava(r, por) };
  }

  /** Chama a Argus (ou simula em DRY_RUN), loga e relê o status dele para o painel mudar logo. */
  async executar(descricao, por, ramal, fn) {
    const quem = por ? ` (${por})` : '';
    if (this.cfg.dryRun) {
      this.log.info(`[DRY_RUN] ${descricao}${quem}: não enviado à Argus.`);
      return { ok: true, simulado: true };
    }
    const r = await this.chamar(descricao, fn);
    this.log.aviso(`${descricao} pelo painel${quem}: ${r?.descStatus || 'ok'}.`);
    if (this.rodizio.ramaisUra.has(String(ramal))) {
      await this.rodizio.atualizarStatusUra(String(ramal)).catch(() => {});
    }
    return { ok: true, simulado: false, descStatus: r?.descStatus ?? null };
  }

  /** Recusa da Argus (codStatus < 1) vira 409 com a mensagem dela; o resto sobe (502). */
  async chamar(descricao, fn) {
    try {
      return await fn();
    } catch (e) {
      if (e instanceof ArgusError && e.resposta && e.resposta.codStatus !== undefined) {
        throw new AcaoRecusada(`a Argus recusou (${descricao}): ${e.resposta.descStatus || e.message}`, 409);
      }
      throw e;
    }
  }
}

module.exports = { AcoesOperador, AcaoRecusada };
