'use strict';
/**
 * Rodízio Ativo ↔ URA + controle dos robôs da URA.
 *
 * Três ciclos independentes, cada um agendado sem sobreposição (app.js):
 *
 *   atualizarGrupos()  ~30 s  lê os grupos da Argus: quem está na URA, no Ativo e quais são os robôs
 *   cicloAtivo()       ~3 s   quem atendeu no Ativo e ficou livre → URA
 *   cicloUra()         ~0,5 s lê o status de quem está na URA, decide os robôs e devolve
 *                             ao Ativo quem cumpriu o tempo (ou ficou offline)
 *
 * O webhook de início de atendimento antecipa a informação do status (que é
 * lido por polling) e dispara a avaliação dos robôs na hora.
 *
 * As regras de decisão ficam em domain/rodizio.js; aqui só há coordenação e I/O.
 */

const {
  Classe, AcaoRobos, classificarStatus, deveIrParaUra, deveVoltarAoAtivo, motivoDaVolta,
  decidirRobos, reconciliarMovidos,
} = require('../domain/rodizio');
const { TipoGrupo } = require('../integrations/argus/argus.client');
const { mapearComLimite } = require('../utils/concorrencia');

class RodizioService {
  /**
   * @param {object} deps
   * @param {import('../integrations/argus/argus.client').ArgusClient} deps.client
   * @param {import('./transferencias').Transferencias} deps.transferencias
   * @param {import('./controle-robos').ControleRobos} deps.robos
   * @param {import('./estado-rodizio.repository').EstadoRodizioRepository} deps.repositorio
   * @param {object} deps.cfg - Seção `rodizio` da configuração
   * @param {object} deps.logger
   */
  constructor({ client, transferencias, robos, repositorio, cfg, logger }) {
    Object.assign(this, { client, transferencias, robos, repositorio, cfg, log: logger });

    /** ramal → { origemGrupoId, entrouEm, ausentes } — persistido: quem o rodízio colocou na URA */
    this.movidos = {};
    this.gruposAtivos = []; // grupos do Ativo (whitelist) com seus ramais
    this.ramaisUra = new Set(); // humanos na URA (do grupo + movidos)
    this.ramaisRobos = [];
    /** ramal → { classe, ts, doWebhook } */
    this.statusUra = new Map();
    /** ramais do Ativo que atenderam uma ligação desde que ficaram online */
    this.atenderamNoAtivo = new Set();
    /** ramais com transferência em andamento */
    this.emTransferencia = new Set();
    this.avaliandoRobos = false;
    this.reavaliarRobos = false;
  }

  inicializar() {
    this.movidos = this.repositorio.carregar();
    return this;
  }

  salvar() {
    return this.repositorio.salvar(this.movidos);
  }

  // ───────────────────────────── Grupos ─────────────────────────────

  async atualizarGrupos() {
    const grupos = await this.client.listarGrupos();
    const ura = grupos.find((g) => g.idGrupoUsuario === this.cfg.grupoUraId);
    if (!ura) {
      this.log.aviso('Grupo da URA não veio em /listargrupos; mantendo a visão anterior.');
      return;
    }

    const naUra = new Set((ura.ramaisOperadores || []).map(String));
    this.esquecerMovidosForaDaUra(naUra);
    this.ramaisUra = new Set([...naUra, ...Object.keys(this.movidos)]);

    const robos = grupos.filter((g) => this.cfg.gruposRobosIds.includes(g.idGrupoUsuario));
    if (robos.length) this.ramaisRobos = robos.flatMap((g) => g.ramaisOperadores || []).map(String);

    this.gruposAtivos = grupos.filter((g) => g.idTipoGrupo === TipoGrupo.OPERACIONAL
      && g.idGrupoUsuario !== this.cfg.grupoUraId
      && this.cfg.gruposAtivosIds.includes(g.idGrupoUsuario));

    this.log.debug(`Grupos: URA=${this.ramaisUra.size} robôs=${this.ramaisRobos.length} ativos=${this.gruposAtivos.length}`);
    await this.sincronizarRobos();
  }

  /** Confere na Argus quais robôs estão logados (ex.: alguém religou à mão). Não disputa com uma avaliação em curso. */
  async sincronizarRobos() {
    if (this.avaliandoRobos || !this.ramaisRobos.length) return;
    this.avaliandoRobos = true;
    try {
      await this.robos.sincronizar(this.ramaisRobos);
    } finally {
      this.avaliandoRobos = false;
    }
  }

  /** Quem saiu da URA por fora do rodízio (ex.: movido à mão) é esquecido, após carência. */
  esquecerMovidosForaDaUra(naUra) {
    const { movidos, esquecidos } = reconciliarMovidos(this.movidos, naUra, Date.now());
    this.movidos = movidos;
    if (!esquecidos.length) return;

    this.log.info(`Saíram da URA por fora do rodízio: ${esquecidos.join(', ')}.`);
    this.salvar();
  }

  // ───────────────────────────── Ativo → URA ─────────────────────────────

  async cicloAtivo() {
    const alvos = this.gruposAtivos.flatMap((g) => (g.ramaisOperadores || [])
      .map((ramal) => ({ ramal: String(ramal), grupo: g.idGrupoUsuario })))
      .filter(({ ramal }) => !this.movidos[ramal] && !this.ramaisUra.has(ramal) && !this.emTransferencia.has(ramal));

    await mapearComLimite(alvos, this.cfg.concorrencia, (alvo) => this.verificarOperadorDoAtivo(alvo));
  }

  async verificarOperadorDoAtivo({ ramal, grupo }) {
    const { classe, status } = await this.lerStatus(ramal);
    if (classe === Classe.ERRO) return;
    if (classe === Classe.OFFLINE) {
      this.atenderamNoAtivo.delete(ramal);
      return;
    }
    // A lista de grupos pode estar desatualizada: só age se o status confirma o grupo.
    if (String(status.idGrupo) !== String(grupo)) return;

    if (classe === Classe.ATENDIMENTO) {
      this.atenderamNoAtivo.add(ramal);
      return;
    }
    if (deveIrParaUra(classe, this.atenderamNoAtivo.has(ramal))) await this.moverParaUra(ramal, grupo);
  }

  async moverParaUra(ramal, grupoOrigem) {
    const ok = await this.comTrava(ramal, () => this.transferencias.transferir(ramal, this.cfg.grupoUraId));
    if (!ok) return;

    this.movidos[ramal] = { origemGrupoId: grupoOrigem, entrouEm: Date.now() };
    this.ramaisUra.add(ramal);
    this.statusUra.set(ramal, { classe: Classe.LIVRE, ts: Date.now() });
    this.atenderamNoAtivo.delete(ramal);
    this.salvar();
    this.log.info(`ATIVO→URA ramal=${ramal} origem=${grupoOrigem}`);
  }

  // ───────────────────────────── URA ─────────────────────────────

  async cicloUra() {
    const ramais = [...this.ramaisUra];
    // 1. Status de todos  2. Robôs primeiro (é o que evita fila)  3. Devoluções
    await mapearComLimite(ramais, this.cfg.concorrencia, (ramal) => this.atualizarStatusUra(ramal));
    await this.avaliarRobos();

    const agora = Date.now();
    const devolver = ramais.filter((ramal) => this.deveDevolver(ramal, agora));
    await mapearComLimite(devolver, this.cfg.concorrencia, (ramal) => this.devolverAoAtivo(ramal));
  }

  async atualizarStatusUra(ramal) {
    const { classe } = await this.lerStatus(ramal);
    if (classe === Classe.ERRO) return; // mantém o último status; a validade dele decide os robôs

    // Um "livre" lido logo depois do webhook de atendimento é atraso do polling: ignora.
    const anterior = this.statusUra.get(ramal);
    const dentroDaCarencia = anterior?.doWebhook && Date.now() - anterior.ts < this.cfg.carenciaWebhookMs;
    if (classe === Classe.LIVRE && dentroDaCarencia) return;

    this.statusUra.set(ramal, { classe, ts: Date.now() });
  }

  deveDevolver(ramal, agora) {
    const movido = this.movidos[ramal];
    const info = this.statusUra.get(ramal);
    if (!movido || !info || this.emTransferencia.has(ramal)) return false;
    return deveVoltarAoAtivo({ movido, classe: info.classe, agora, tempoNaUraMs: this.cfg.tempoNaUraMs });
  }

  async devolverAoAtivo(ramal) {
    const movido = this.movidos[ramal];
    const classe = this.statusUra.get(ramal)?.classe;
    if (!movido) return;

    const ok = await this.comTrava(ramal, () => this.transferencias.transferir(ramal, movido.origemGrupoId));
    if (!ok) return;

    delete this.movidos[ramal];
    this.ramaisUra.delete(ramal);
    this.statusUra.delete(ramal);
    this.salvar();
    this.log.info(`URA→ATIVO ramal=${ramal} destino=${movido.origemGrupoId} (motivo: ${motivoDaVolta(classe)})`);
  }

  // ───────────────────────────── Robôs ─────────────────────────────

  /**
   * Decide e aplica a ação sobre os robôs. Chamadas concorrentes (ciclo da URA
   * e webhook) não se sobrepõem: quem chega durante uma avaliação pede outra rodada.
   */
  async avaliarRobos() {
    if (this.avaliandoRobos) {
      this.reavaliarRobos = true;
      return;
    }
    this.avaliandoRobos = true;
    try {
      do {
        this.reavaliarRobos = false;
        await this.aplicarDecisaoDosRobos();
      } while (this.reavaliarRobos);
    } finally {
      this.avaliandoRobos = false;
    }
  }

  async aplicarDecisaoDosRobos() {
    const { acao, alvo, motivo } = decidirRobos({
      ramaisUra: [...this.ramaisUra],
      status: this.statusUra,
      agora: Date.now(),
      robos: this.robos.situacao(this.ramaisRobos.length),
      cfg: {
        reativar: this.cfg.reativarRobos,
        minDesligadoMs: this.cfg.minRobosDesligadosMs,
        porLivre: this.cfg.robosPorLivre,
        maximo: this.cfg.robosMaximo,
      },
    });
    if (acao === AcaoRobos.DESLIGAR) await this.robos.reduzir(this.ramaisRobos, alvo, motivo);
    if (acao === AcaoRobos.RELIGAR) await this.robos.aumentar(this.ramaisRobos, alvo, motivo);
  }

  // ───────────────────────────── Webhook ─────────────────────────────

  /**
   * Um operador começou a atender (webhook da Argus).
   * Na URA: marca como em atendimento e reavalia os robôs na hora.
   * No Ativo: registra o atendimento para o rodízio.
   */
  registrarAtendimento(ramal) {
    if (!this.ramaisUra.has(ramal)) {
      this.atenderamNoAtivo.add(ramal);
      return;
    }
    this.statusUra.set(ramal, { classe: Classe.ATENDIMENTO, ts: Date.now(), doWebhook: true });
    this.log.debug(`webhook: ${ramal} em atendimento na URA`);
    this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após webhook: ${e.message}`));
  }

  // ───────────────────────────── Auxiliares ─────────────────────────────

  /** @returns {Promise<{ classe: string, status?: object }>} */
  async lerStatus(ramal) {
    try {
      const status = await this.client.statusOperador(ramal);
      return { classe: classificarStatus(status, this.cfg.descricoesStatus), status };
    } catch {
      return { classe: Classe.ERRO };
    }
  }

  /** Evita duas transferências simultâneas do mesmo ramal. */
  async comTrava(ramal, fn) {
    if (this.emTransferencia.has(ramal)) return false;
    this.emTransferencia.add(ramal);
    try {
      return await fn();
    } finally {
      this.emTransferencia.delete(ramal);
    }
  }

  resumo() {
    return {
      robos: { ...this.robos.resumo(), total: this.ramaisRobos.length, porLivre: this.cfg.robosPorLivre },
      ramaisUra: [...this.ramaisUra],
      movidos: this.movidos,
      gruposAtivos: this.gruposAtivos.map((g) => g.idGrupoUsuario),
    };
  }
}

module.exports = { RodizioService };
