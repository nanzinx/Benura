'use strict';
/**
 * Rodízio Ativo ↔ URA + controle dos robôs da URA.
 *
 * Três ciclos independentes, cada um agendado sem sobreposição (app.js):
 *
 *   atualizarGrupos()  ~30 s  lê os grupos da Argus: quem está na URA, no Ativo e quais são os robôs
 *   cicloAtivo()       ~5 s   quem atendeu no Ativo e ficou livre → URA
 *   cicloUra()         ~5 s   lê o status de quem está na URA, decide os robôs e devolve
 *                             ao Ativo quem está ocioso há TEMPO_MIN (ou o movido que ficou
 *                             offline); ~1 s com poucos livres (URA em alerta). O último
 *                             livre espera os robôs em ligação terminarem antes de sair.
 *
 * O webhook de início de atendimento antecipa a informação do status (que é
 * lido por polling) e dispara a avaliação dos robôs na hora.
 *
 * As regras de decisão ficam em domain/rodizio.js; aqui só há coordenação e I/O.
 */

const {
  Classe, AcaoRobos, classificarStatus, deveIrParaUra, deveVoltarAoAtivo, motivoDaVolta, quemSegurarNaUra,
  decidirRobos, reconciliarMovidos, VALIDADE_STATUS_MS,
} = require('../domain/rodizio');
const { TipoGrupo } = require('../integrations/argus/argus.client');
const { alinharLogin } = require('../integrations/argus/alinhar-login');
const { mapearComLimite } = require('../utils/concorrencia');

/** No máximo uma tentativa de relogar o mesmo ramal nesse intervalo (fora as logo após mover). */
const INTERVALO_ALINHAMENTO_MS = 60_000;

/** Depois de quanto tempo sem webhook avisar (e de quanto em quanto repetir). */
const AVISO_SEM_WEBHOOK_MS = 60 * 60_000;

class RodizioService {
  /**
   * @param {object} deps
   * @param {import('../integrations/argus/argus.client').ArgusClient} deps.client
   * @param {import('./transferencias').Transferencias} deps.transferencias
   * @param {import('./controle-robos').ControleRobos} deps.robos
   * @param {import('./estado-rodizio.repository').EstadoRodizioRepository} deps.repositorio
   * @param {object} deps.cfg - Seção `rodizio` da configuração
   * @param {object} deps.logger
   * @param {import('../integrations/argus/diretorio-operadores.service').DiretorioOperadores} [deps.diretorio]
   *        grupo do Ativo do supervisor, para devolver quem não foi movido pelo rodízio
   */
  constructor({ client, transferencias, robos, repositorio, cfg, logger, diretorio = null }) {
    Object.assign(this, { client, transferencias, robos, repositorio, cfg, log: logger, diretorio });
    /** ramais sem grupo do Ativo identificável (aviso uma vez por ramal) */
    this.semGrupoAvisados = new Set();

    /** ramal → { origemGrupoId, entrouEm, ausentes } — persistido: quem o rodízio colocou na URA */
    this.movidos = {};
    this.gruposAtivos = []; // grupos do Ativo (whitelist) com seus ramais
    this.ramaisUra = new Set(); // humanos na URA (do grupo + movidos)
    this.ramaisRobos = [];
    /** ramal → { classe, ts, doWebhook } */
    this.statusUra = new Map();
    /** ramais cuja última leitura de status falhou (para avisar uma vez só) */
    this.ramaisComFalha = new Set();
    /** ramal → { grupoLogado, grupo }: no grupo da URA, mas logado na telefonia em outro grupo */
    this.logadosEmOutroGrupo = new Map();
    /** ramais sendo relogados agora (o status pisca "deslogado": não é para agir) */
    this.alinhandoLogin = new Set();
    /** ramal → quando se tentou relogar pela última vez */
    this.ultimoAlinhamento = new Map();
    /** ramais do Ativo que atenderam uma ligação desde que ficaram online */
    this.atenderamNoAtivo = new Set();
    /** ramais com transferência em andamento */
    this.emTransferencia = new Set();
    this.avaliandoRobos = false;
    this.reavaliarRobos = false;
    /** Até quando a supervisão comanda os robôs pelo painel (0 = o BenURA comanda). */
    this.manualAte = 0;
    /** Humanos livres na URA na última decisão dos robôs (null = ainda não decidiu). */
    this.ultimosLivres = null;
    /** Desde quando há mais robôs ligados que o alvo, com gente livre (null = não há). */
    this.excessoDesde = null;
    /** Último livre segurado na URA enquanto os robôs em ligação terminam: { ramal, desde } | null. */
    this.segurado = null;
    this.iniciadoEm = Date.now();
    this.ultimoWebhookEm = 0;
    this.ultimoAvisoSemWebhookEm = 0;
  }

  /**
   * Intervalo do ciclo da URA. Com poucos livres (1 a LIVRES_ALERTA), o próximo
   * atendimento pode zerar os livres com os robôs ainda ligados: sem webhook,
   * só a leitura percebe isso, então ela acelera até a situação passar.
   */
  intervaloUraMs() {
    const emAlerta = this.ultimosLivres > 0 && this.ultimosLivres <= this.cfg.livresAlerta;
    return emAlerta ? Math.min(this.cfg.pollUraAlertaMs, this.cfg.pollUraMs) : this.cfg.pollUraMs;
  }

  /** Qualquer webhook da Argus que chegou (prova de que estão configurados). */
  registrarWebhookRecebido() {
    this.ultimoWebhookEm = Date.now();
  }

  /** Sem o webhook tipo 1, desligar os robôs depende só da leitura: avisa (no máximo 1×/hora). */
  avisarSeSemWebhook(agora = Date.now()) {
    const semWebhookHa = agora - Math.max(this.ultimoWebhookEm, this.iniciadoEm);
    if (semWebhookHa < AVISO_SEM_WEBHOOK_MS || agora - this.ultimoAvisoSemWebhookEm < AVISO_SEM_WEBHOOK_MS) return;
    if (!this.robos.situacao(this.ramaisRobos.length).ligados) return; // sem robô ligado, não há risco
    this.ultimoAvisoSemWebhookEm = agora;
    this.log.aviso(`Nenhum webhook da Argus em ${Math.round(semWebhookHa / 60_000)} min. Sem o webhook de início de atendimento `
      + `(tipo 1 → POST /webhook?token=…), os robôs podem levar até ${this.cfg.pollUraMs / 1000} s para desligar quando o último livre atende.`);
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
      .filter(({ ramal }) => !this.movidos[ramal] && !this.ramaisUra.has(ramal) && !this.emTransferencia.has(ramal)
        && !this.alinhandoLogin.has(ramal));

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
    // Em DRY_RUN ninguém foi movido de verdade: contá-lo como livre na URA inflaria o alvo de robôs.
    if (this.cfg.dryRun) {
      this.atenderamNoAtivo.delete(ramal);
      return;
    }

    this.movidos[ramal] = { origemGrupoId: grupoOrigem, entrouEm: Date.now() };
    this.ramaisUra.add(ramal);
    this.statusUra.set(ramal, { classe: Classe.LIVRE, ts: Date.now(), livreDesde: Date.now() });
    this.atenderamNoAtivo.delete(ramal);
    this.salvar();
    this.log.info(`ATIVO→URA ramal=${ramal} origem=${grupoOrigem}`);
    this.alinharLoginEmSegundoPlano(ramal, this.cfg.grupoUraId, { forcar: true });
  }

  // ───────────────────────────── URA ─────────────────────────────

  async cicloUra() {
    const ramais = [...this.ramaisUra];
    // 1. Status de todos  2. Quem volta (e quem segura a URA)  3. Robôs (é o que evita fila)  4. Devoluções
    await mapearComLimite(ramais, this.cfg.concorrencia, (ramal) => this.atualizarStatusUra(ramal));
    const agora = Date.now();
    const ociosos = ramais.filter((ramal) => this.deveDevolver(ramal, agora));
    const segurado = this.atualizarSegurado(ociosos, ramais, agora);
    await this.avaliarRobos();

    this.avisarSeSemWebhook();
    const devolver = ociosos.filter((ramal) => ramal !== segurado);
    await mapearComLimite(devolver, this.cfg.concorrencia, (ramal) => this.devolverAoAtivo(ramal));
  }

  /**
   * O último livre da URA não sai enquanto há robô ligado: sem ele o alvo vira 0
   * e os robôs em ligação caem (o cliente que pedir atendimento vira callback).
   * Enquanto isso os robôs param de discar; ele sai quando todos desligam, ou
   * depois de SEGURAR_ULTIMO_LIVRE_MS.
   * @returns {string|null} ramal segurado neste ciclo
   */
  atualizarSegurado(ociosos, ramais, agora) {
    const limiteMs = this.cfg.segurarUltimoLivreMs;
    const candidato = limiteMs > 0 ? quemSegurarNaUra({ devolver: ociosos, ramaisUra: ramais, status: this.statusUra }) : null;
    const ligados = this.robos.situacao(this.ramaisRobos.length).ligados || 0;
    if (!candidato || !ligados) return this.soltarSegurado(null);
    if (this.segurado?.ramal !== candidato) this.segurarNaUra(candidato, ligados, agora);
    if (agora - this.segurado.desde < limiteMs) return candidato;
    return this.soltarSegurado(`${ligados} robô(s) ainda ligados depois de ${Math.round(limiteMs / 1000)} s`);
  }

  segurarNaUra(ramal, ligados, agora) {
    this.segurado = { ramal, desde: agora };
    this.log.info(`Ramal ${ramal} ocioso, mas é o último livre da URA: fica até os robôs em ligação terminarem `
      + `(${ligados} ligado(s); máx. ${Math.round(this.cfg.segurarUltimoLivreMs / 1000)} s). Os robôs param de discar.`);
  }

  /** @returns {null} */
  soltarSegurado(motivoAviso) {
    if (this.segurado && motivoAviso) this.log.aviso(`Último livre ${this.segurado.ramal} volta ao Ativo com ${motivoAviso}.`);
    this.segurado = null;
    return null;
  }

  /** Ramal segurado que continua livre (se atendeu, não segura mais nada). */
  seguradoLivre() {
    const ramal = this.segurado?.ramal;
    return ramal && this.statusUra.get(ramal)?.classe === Classe.LIVRE ? ramal : null;
  }

  async atualizarStatusUra(ramal) {
    if (this.alinhandoLogin.has(ramal)) return; // relogando: o "deslogado" de agora é passageiro
    const { classe, status } = await this.lerStatus(ramal);
    if (classe === Classe.ERRO) return; // mantém o último status; a validade dele decide os robôs
    this.conferirGrupoLogado(ramal, classe, status);

    // Um "livre" lido logo depois do webhook de atendimento é atraso do polling: ignora.
    const anterior = this.statusUra.get(ramal);
    const dentroDaCarencia = anterior?.doWebhook && Date.now() - anterior.ts < this.cfg.carenciaWebhookMs;
    if (classe === Classe.LIVRE && dentroDaCarencia) return;

    // Tempo ocioso: conta desde que ficou Livre; qualquer outro status zera.
    const agora = Date.now();
    const livreDesde = classe === Classe.LIVRE ? (anterior?.livreDesde ?? agora) : undefined;
    this.statusUra.set(ramal, { classe, ts: agora, livreDesde });
  }

  /**
   * O statusoperador traz o grupo em que a pessoa está LOGADA na telefonia
   * (doc 4.14). Estar no grupo da URA e logado em outro significa que a
   * derivação dos robôs não chega nela (o cliente espera na fila e vira
   * callback). Avisa uma vez por ramal (o /health lista quem está assim) e,
   * se a pessoa está livre, reloga na URA.
   */
  conferirGrupoLogado(ramal, classe, status) {
    const logado = Boolean(status) && classe !== Classe.OFFLINE && status.idGrupo != null;
    const emOutroGrupo = logado && Number(status.idGrupo) !== Number(this.cfg.grupoUraId);
    if (!emOutroGrupo) return this.esquecerGrupoLogado(ramal, logado);
    // Livre: reloga na URA (também quem foi movido à mão já logado). Em ligação ou pausa, espera.
    if (classe === Classe.LIVRE) this.alinharLoginEmSegundoPlano(ramal, this.cfg.grupoUraId);
    if (this.logadosEmOutroGrupo.has(ramal) || this.alinhandoLogin.has(ramal)) return undefined;

    this.logadosEmOutroGrupo.set(ramal, { ramal, grupoLogado: status.idGrupo, grupo: status.grupo ?? null });
    this.log.aviso(`Ramal ${ramal} está no grupo da URA, mas a telefonia diz que está logado em "${status.grupo ?? '?'}" `
      + `(grupo ${status.idGrupo}): a derivação dos robôs não chega nele.`);
    return undefined;
  }

  /**
   * Leva a telefonia para o grupo em que a pessoa está vinculada (alinhar-login.js).
   * Em segundo plano, para não atrasar o ciclo; uma vez por ramal a cada 60 s,
   * fora a tentativa logo depois de o rodízio mover (`forcar`).
   */
  alinharLoginEmSegundoPlano(ramal, idGrupo, { forcar = false } = {}) {
    if (!this.cfg.alinharLogin || this.alinhandoLogin.has(ramal)) return;
    const agora = Date.now();
    if (!forcar && agora - (this.ultimoAlinhamento.get(ramal) || 0) < INTERVALO_ALINHAMENTO_MS) return;

    this.ultimoAlinhamento.set(ramal, agora);
    this.alinhandoLogin.add(ramal);
    alinharLogin({ client: this.client, ramal, idGrupo, dryRun: this.cfg.dryRun, log: this.log, esperaMs: this.cfg.esperaLoginMs })
      .finally(() => this.alinhandoLogin.delete(ramal));
  }

  esquecerGrupoLogado(ramal, logadoNaUra) {
    if (this.logadosEmOutroGrupo.delete(ramal) && logadoNaUra) this.log.info(`Ramal ${ramal} agora está logado no grupo da URA.`);
  }

  deveDevolver(ramal, agora) {
    const info = this.statusUra.get(ramal);
    if (!info || this.emTransferencia.has(ramal)) return false;
    return deveVoltarAoAtivo({
      classe: info.classe, livreDesde: info.livreDesde, agora, ociosoMs: this.cfg.tempoNaUraMs, movido: this.movidos[ramal],
    });
  }

  /** Quem o rodízio moveu volta ao grupo de origem; os demais, ao grupo do Ativo do supervisor. */
  async grupoDeVolta(ramal) {
    const movido = this.movidos[ramal];
    if (movido) return movido.origemGrupoId;
    if (!this.diretorio) return null;
    try {
      await this.diretorio.atualizar();
      return this.diretorio.grupoAtivoDoOperador(ramal);
    } catch (e) {
      this.log.debug(`Diretório indisponível para o ramal ${ramal}: ${e.message}`);
      return null;
    }
  }

  async devolverAoAtivo(ramal) {
    const info = this.statusUra.get(ramal) || {};
    const destino = await this.grupoDeVolta(ramal);
    if (destino == null) return this.avisarSemGrupo(ramal);

    const ok = await this.comTrava(ramal, () => this.transferencias.transferir(ramal, destino));
    if (!ok) return undefined;

    delete this.movidos[ramal];
    this.ramaisUra.delete(ramal);
    this.statusUra.delete(ramal);
    this.vigiarNoAtivo(ramal, destino);
    this.salvar();
    this.log.info(`URA→ATIVO ramal=${ramal} destino=${destino} (motivo: ${motivoDaVolta({ ...info, agora: Date.now() })})`);
    this.alinharLoginEmSegundoPlano(ramal, destino, { forcar: true });
    return undefined;
  }

  /**
   * Passa a vigiar no Ativo quem acabou de voltar, sem esperar a próxima
   * leitura dos grupos: uma ligação curta logo após a volta já o traz à URA.
   */
  vigiarNoAtivo(ramal, idGrupo) {
    const incluir = (g) => ({ ...g, ramaisOperadores: [...new Set([...(g.ramaisOperadores || []).map(String), ramal])] });
    this.gruposAtivos = this.gruposAtivos.map((g) => (g.idGrupoUsuario === idGrupo ? incluir(g) : g));
  }

  avisarSemGrupo(ramal) {
    if (this.semGrupoAvisados.has(ramal)) return;
    this.semGrupoAvisados.add(ramal);
    this.log.aviso(`Ramal ${ramal} ocioso na URA, mas sem grupo do Ativo identificável (supervisor?). `
      + 'Fica na URA. Defina o grupo do supervisor em SUPERVISORES_GRUPOS_FILE (ex.: { "ROBSON JUNIOR": 20 }).');
  }

  // ───────────────────────────── Robôs ─────────────────────────────

  /**
   * Decide e aplica a ação sobre os robôs. Chamadas concorrentes (ciclo da URA
   * e webhook) não se sobrepõem: quem chega durante uma avaliação pede outra rodada.
   */
  async avaliarRobos() {
    if (this.emModoManual()) return;
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
    if (this.seguradoLivre()) {
      this.excessoDesde = null;
      return this.robos.encerrarSemDerrubar(`último livre (${this.segurado.ramal}) saindo por ociosidade`);
    }
    const agora = Date.now();
    const { acao, alvo, motivo, livres, excesso } = decidirRobos({
      ramaisUra: [...this.ramaisUra],
      status: this.statusUra,
      agora,
      robos: { ...this.robos.situacao(this.ramaisRobos.length), excessoDesde: this.excessoDesde },
      cfg: {
        reativar: this.cfg.reativarRobos,
        minDesligadoMs: this.cfg.minRobosDesligadosMs,
        reduzirAposMs: this.cfg.reduzirAposMs,
        intervaloSubidaMs: this.cfg.intervaloSubidaMs,
        porLivre: this.cfg.robosPorLivre,
        maximo: this.cfg.robosMaximo,
        // Com poll lento, o status "envelhece" entre ciclos: não pode virar "sem visibilidade".
        validadeStatusMs: Math.max(VALIDADE_STATUS_MS, this.cfg.pollUraMs * 2 + 1000),
      },
    });
    this.registrarMudancaDeLivres(livres, alvo);
    this.ultimosLivres = livres;
    // Desde quando há robôs demais com gente livre (a redução parcial espera isso se confirmar).
    this.excessoDesde = excesso && acao !== AcaoRobos.DESLIGAR ? (this.excessoDesde ?? agora) : null;
    if (acao === AcaoRobos.DESLIGAR) await this.robos.reduzir(this.ramaisRobos, alvo, motivo);
    if (acao === AcaoRobos.RELIGAR) await this.robos.aumentar(this.ramaisRobos, alvo, motivo);
  }

  /**
   * Linha do tempo da URA: uma linha a cada mudança no número de livres, para
   * cruzar com a hora de cada callback (npm run diagnostico:callbacks).
   */
  registrarMudancaDeLivres(livres, alvo) {
    if (livres === this.ultimosLivres) return;
    const humanos = [...this.ramaisUra].filter((r) => this.statusUra.has(r) && this.statusUra.get(r).classe !== Classe.OFFLINE).length;
    const { ligados } = this.robos.situacao(this.ramaisRobos.length);
    this.log.info(`URA: livres ${this.ultimosLivres ?? '?'}→${livres} | humanos ${humanos} | robôs ligados ${ligados ?? '?'} (alvo ${alvo})`);
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
      if (this.ramaisComFalha.delete(ramal)) this.log.info(`Status do ramal ${ramal} voltou a ser lido.`);
      return { classe: classificarStatus(status, this.cfg.descricoesStatus), status };
    } catch (e) {
      this.avisarFalhaDeLeitura(ramal, e);
      return { classe: Classe.ERRO };
    }
  }

  /** Avisa uma vez por ramal (o ciclo da URA repete a leitura a cada POLL_URA_MS). */
  avisarFalhaDeLeitura(ramal, e) {
    if (this.ramaisComFalha.has(ramal)) return;
    this.ramaisComFalha.add(ramal);
    this.log.aviso(`Não foi possível ler o status do ramal ${ramal}: ${e.message}`);
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

  // ───────────────────────────── Modo manual ─────────────────────────────

  emModoManual(agora = Date.now()) {
    if (!this.manualAte || agora < this.manualAte) return this.manualAte > 0;
    this.manualAte = 0;
    this.log.info('Fim do modo manual: o BenURA volta a comandar os robôs.');
    return false;
  }

  /** A supervisão assume os robôs pelo painel por `minutos`; o BenURA não liga nem desliga nenhum. */
  assumirRobosManualmente(minutos) {
    this.manualAte = Date.now() + minutos * 60_000;
    this.log.aviso(`Modo manual por ${minutos} min: o BenURA não mexe nos robôs até ${new Date(this.manualAte).toISOString()}.`);
    return this.manualAte;
  }

  devolverRobosAoBenura() {
    this.manualAte = 0;
    this.log.info('Modo manual encerrado: o BenURA volta a comandar os robôs.');
  }

  resumo() {
    return {
      robos: {
        ...this.robos.resumo(),
        total: this.ramaisRobos.length,
        porLivre: this.cfg.robosPorLivre,
        manualAte: this.manualAte ? new Date(this.manualAte).toISOString() : null,
      },
      intervaloUraMs: this.intervaloUraMs(),
      seguradoNaUra: this.segurado ? { ramal: this.segurado.ramal, desde: new Date(this.segurado.desde).toISOString() } : null,
      ultimoWebhook: this.ultimoWebhookEm ? new Date(this.ultimoWebhookEm).toISOString() : null,
      uraLogadosEmOutroGrupo: [...this.logadosEmOutroGrupo.values()],
      ramaisUra: [...this.ramaisUra],
      movidos: this.movidos,
      gruposAtivos: this.gruposAtivos.map((g) => g.idGrupoUsuario),
    };
  }
}

module.exports = { RodizioService };
