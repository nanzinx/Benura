'use strict';
/**
 * Rodízio Ativo ↔ URA + controle dos robôs da URA.
 *
 * Três ciclos independentes, cada um agendado sem sobreposição (app.js):
 *
 *   atualizarGrupos()  ~30 s  lê os grupos da Argus: quem está na URA, no Ativo e quais são os robôs
 *   cicloAtivo()       ~5 s   quem é elegível (meta de ontem, venda hoje ou fixo), atendeu
 *                             no Ativo e ficou livre → URA. [NOVO] Na URA cheia (pedido da
 *                             supervisão), qualquer um que atender no Ativo sobe, sem
 *                             olhar elegíveis; ninguém sobe só por estar no Ativo.
 *                             A regra do ocioso continua valendo.
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
  Classe, AcaoRobos, classificarStatus, deveIrParaUra, deveVoltarAoAtivo, motivoDaVolta, ultimoLivreQueSai,
  decidirRobos, alvoDeRobos, livresUteis, reconciliarMovidos, VALIDADE_STATUS_MS, porAntiguidade, bonusDeAntiguidade,
  planoDaCalma, excessoDaCalma,
} = require('../domain/rodizio');
const { TipoGrupo } = require('../integrations/argus/argus.client');
const { alinharLogin } = require('../integrations/argus/alinhar-login');
const { raioXDoCallback, horaNoFuso } = require('../domain/raio-x-callback');
const { mapearComLimite } = require('../utils/concorrencia');
const { limitesMin: LIMITES_PAUSA } = require('../config/pausas');
const { robosPorLivrePelaTaxa, roboMinutos, CALCULO_PADRAO } = require('../domain/robos-por-taxa');
const { dataLocal } = require('../utils/datas');

/** Quanto tempo de fotos da URA o raio-x dos callbacks guarda (o relatório chega com até alguns minutos de atraso). */
const FOTOS_MS = 15 * 60_000;
/** No máximo uma tentativa de relogar o mesmo ramal nesse intervalo (fora as logo após mover). */
const INTERVALO_ALINHAMENTO_MS = 60_000;

/** Depois de quanto tempo sem webhook avisar (e de quanto em quanto repetir). */
const AVISO_SEM_WEBHOOK_MS = 60 * 60_000;

/** [NOVO] Operador virtual (robô) pelo nome da Argus: "OPER VIRT…" (ex.: "Oper Virtual 7"). */
const ehOperadorVirtual = (nome) => /^oper\s*virt/i.test(String(nome || '').trim());

/**
 * [NOVO] Desde quando o operador está no status, para o painel: o tempoStatus da Argus (o mesmo
 * "Tempo" da tela dela, inclusive para livre); sem ele, o que o rodízio mediu.
 */
function desdeDoStatus(s) {
  const medido = s?.classe === Classe.LIVRE ? s.livreDesde : s?.classe === Classe.OFFLINE ? s.offlineDesde : null;
  const desde = s?.detalhe?.statusDesde ?? medido;
  return desde != null ? new Date(desde).toISOString() : null;
}

/** [NOVO] 150000 → "2:30". */
const formatarMinSeg = (ms) => `${Math.floor(ms / 60_000)}:${String(Math.round((ms % 60_000) / 1000)).padStart(2, '0')}`;

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
   * @param {import('./elegiveis-ura').ElegiveisUra} [deps.elegiveis]
   *        quem pode subir do Ativo para a URA (sem: todos)
   * @param {import('./ura-cheia').UraCheia} [deps.uraCheia]
   *        modo "todos na URA" pedido pela supervisão
   * @param {import('./ajuste-robos').AjusteRobos} [deps.ajuste]
   *        robôs por livre que baixam no callback e sobem com a URA passiva (sem: sempre ROBOS_POR_LIVRE)
   * @param {import('./interruptor').Interruptor} [deps.panico] - pânico dos robôs (ROBOS_MODO=panico)
   * @param {import('./termometro-ura').TermometroUra} [deps.termometro] - URA calma, normal ou agressiva (automático)
   * @param {import('./status-ura').StatusUra} [deps.statusDaUra]
   *        [NOVO] status que vale para o pânico: o do termômetro ou o manual do painel.
   *        Calma: com 1 fixo livre, os robôs seguem até ele atender
   * @param {import('./estatisticas-dia').EstatisticasDia} [deps.estatisticas] - relatório do dia (painel)
   * @param {import('./retencao-ativo').RetencaoAtivo} [deps.retencao]
   *        [NOVO] "Alocar Todos no Ativo": ninguém sobe para a URA até "Retomar rodízio da URA"
   * @param {import('./modo-robos').ModoRobos} [deps.modoRobos]
   *        [NOVO] modo dos robôs escolhido no painel (automático, só pânico ou desligados)
   * @param {import('./travas-manuais').TravasManuais} [deps.travas]
   *        [NOVO] quem a supervisão mexeu à mão pelo painel: o rodízio não mexe nele até liberarem
   */
  constructor({
    client, transferencias, robos, repositorio, cfg, logger, diretorio = null, elegiveis = null, uraCheia = null, ajuste = null,
    panico = null, fixos = null, termometro = null, statusDaUra = null, estatisticas = null, retencao = null, travas = null,
    modoRobos = null, contasSupervisores = null,
  }) {
    Object.assign(this, {
      client, transferencias, robos, repositorio, cfg, log: logger, diretorio, elegiveis, uraCheia, ajuste, panico, fixos,
      termometro, statusDaUra, estatisticas, retencao, travas, modoRobos, contasSupervisores,
    });
    if (this.robos) this.robos.modoAtual = () => this.modoDosRobos();
    /** Fixos na URA de vez (FIXOS_PERMANENTES_URA): a regra do ocioso não vale para eles. */
    this.permanentes = new Set();
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
    /** ramal → desde quando está na lista da URA, mas logado em outro grupo */
    this.foraDoGrupoDesde = new Map();
    /** ramais movidos para a URA cuja telefonia ainda não foi vista no grupo da URA */
    this.aguardandoTroca = new Set();
    /** ramal → quando a telefonia passou para a URA (a carência conta daqui) */
    this.trocouEm = new Map();
    /** Último atendimento de alguém da URA (derivação): mede a URA passiva. */
    this.ultimoAtendimentoUraEm = Date.now();
    /** ramais do Ativo que atenderam uma ligação desde que ficaram online */
    this.atenderamNoAtivo = new Set();
    /** [NOVO] voltaram ao Ativo (ocioso ou excesso da calma): só sobem de novo depois de atender lá */
    this.esperandoAtender = new Set();
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
    /** Último livre da URA prestes a sair por ociosidade (robôs param de discar): { ramal, desde } | null. */
    this.ultimoSaindo = null;
    /** Modo pânico: desde quando o BenURA está desligando os robôs (null = não está) e por quê (log e /health). */
    this.panicoDesde = null;
    this.panicoMotivo = null;
    /** Tipo do pânico agora: 'zero' | 'saindo' | 'fixo' (null = não está). */
    this.panicoTipo = null;
    /** 1 fixo livre: { ramal, ultimaEm } da última redução à metade (null = não está reduzindo). */
    this.reducaoFixo = null;
    /** Fixo livre há PANICO_FIXO_OCIOSO_MIN: os robôs seguem até ele atender (avisa uma vez). */
    this.fixoOciosoAvisado = null;
    /** O painel está desligando a automação: não move ninguém nem decide robôs (encerrarRobosParaDesligar). */
    this.desligandoAutomacao = false;
    /** Fotos da URA dos últimos FOTOS_MS (raio-x de cada callback: raio-x-callback.js). */
    this.fotos = [];
    /** [NOVO] Derivações e robôs ligados dos últimos 30 min: a taxa real que dimensiona os robôs (robos-por-taxa.js). */
    this.derivacoesRecentes = [];
    this.amostrasRobos = [];
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
    this.uraCheia?.carregar();
    this.ajuste?.carregar();
    this.panico?.carregar();
    this.statusDaUra?.carregar();
    this.retencao?.carregar();
    this.travas?.carregar();
    this.modoRobos?.carregar();
    this.estatisticas?.carregar();
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
    await this.atualizarPermanentes();
    await this.sincronizarRobos();
  }

  /** Relê os fixos (a equipe pode mudar na Argus); se a Argus não responder, mantém a última lista. */
  async atualizarPermanentes() {
    if (!this.fixos) return;
    let novos;
    try {
      novos = new Set([...(await this.fixos())].map(String));
    } catch (e) {
      this.log.debug(`Fixos indisponíveis agora: ${e.message}`);
      return;
    }
    const mudou = novos.size !== this.permanentes.size || [...novos].some((r) => !this.permanentes.has(r));
    this.permanentes = novos;
    if (mudou) this.log.info(`Fixos na URA de vez (sem a regra do ocioso): ${novos.size}${novos.size ? ` (${[...novos].join(', ')})` : ''}.`);
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
    if (this.desligandoAutomacao) return;
    // "Alocar Todos no Ativo": ninguém sobe até "Retomar rodízio da URA".
    if (this.retencao?.ativa) return;
    const cheia = this.emUraCheia();
    if (!cheia) await this.elegiveis?.atualizar();
    await this.atualizarDiretorio(); // [NOVO] contas de supervisores (cache; Argus fora: segue sem)
    // [NOVO] Na URA cheia, qualquer um que atender no Ativo sobe (sem olhar elegíveis). Ninguém
    // sobe só por estar no Ativo: quem voltou por ocioso ou foi tirado à mão fica lá até atender.
    const alvos = porAntiguidade(this.operadoresDoAtivo().filter(({ ramal }) => cheia || this.podeIrParaUra(ramal)), (a) => a.ramal);
    // [NOVO] URA calma: ninguém sobe sozinho; depois de ler todos, sobem os mais antigos que faltam.
    const calma = this.emCalmaComLimite();
    const lidos = await mapearComLimite(alvos, this.cfg.concorrencia, (alvo) => this.verificarOperadorDoAtivo(alvo, { subir: !calma }));
    if (calma) await this.completarLivresDaCalma(lidos.filter(Boolean));
  }

  // ───────────────────────────── [NOVO] URA calma: de 4 a 6 livres ─────────────────────────────

  /** Status calma, a regra ligada (URA_CALMA_LIMITAR_LIVRES) e sem URA cheia. */
  emCalmaComLimite(agora = Date.now()) {
    return Boolean(this.cfg.calmaLimitarLivres) && this.statusAtualDaUra() === 'calma' && !this.emUraCheia(agora);
  }

  /** Livres na URA (fixos inclusive) mais quem já subiu e está a caminho. */
  livresContadosNaCalma(saindo = []) {
    const fora = new Set(saindo.map(String));
    return [...this.ramaisUra].filter((r) => !fora.has(r) && (this.statusUra.get(r)?.classe === Classe.LIVRE || this.aguardandoTroca.has(r))).length;
  }

  /**
   * Abaixo de URA_CALMA_LIVRES_MIN, sobem os mais antigos (ramal menor) livres no Ativo,
   * menos quem voltou e ainda não atendeu lá.
   * @param {{ ramal: string, grupo: number, classe: string }[]} lidos - livres no Ativo deste ciclo
   */
  async completarLivresDaCalma(lidos) {
    const contados = this.livresContadosNaCalma();
    const { subir } = planoDaCalma({ contados, min: this.cfg.calmaLivresMin, max: this.cfg.calmaLivresMax });
    if (!subir) return;
    const fila = porAntiguidade(lidos.filter((l) => l.classe === Classe.LIVRE && !this.esperandoAtender.has(l.ramal)), (l) => l.ramal);
    const escolhidos = fila.slice(0, subir);
    if (!escolhidos.length) return;
    this.log.info(`URA calma com ${contados} livre(s) (mín. ${this.cfg.calmaLivresMin}): sobem os mais antigos ${escolhidos.map((l) => l.ramal).join(', ')}.`);
    for (const { ramal, grupo } of escolhidos) await this.moverParaUra(ramal, grupo);
  }

  /**
   * Acima de URA_CALMA_LIVRES_MAX, voltam ao Ativo os livres há mais tempo (fixos, travados à mão,
   * em transferência e na carência ficam). @param {string[]} saindo - os que já saem pelo ocioso agora
   */
  async devolverExcessoDaCalma(saindo) {
    const contados = this.livresContadosNaCalma(saindo);
    const { devolver } = planoDaCalma({ contados, min: this.cfg.calmaLivresMin, max: this.cfg.calmaLivresMax });
    if (!devolver) return;
    const fora = new Set(saindo.map(String));
    const candidatos = [...this.ramaisUra]
      .filter((r) => !fora.has(r) && !this.permanentes.has(r) && this.travadoEm(r) !== 'ura' && !this.emTransferencia.has(r))
      .map((r) => ({ ramal: r, info: this.statusUra.get(r) }))
      .filter(({ info }) => info?.classe === Classe.LIVRE && !info.emCarencia && info.livreDesde != null)
      .map(({ ramal, info }) => ({ ramal, livreDesde: info.livreDesde }));
    const motivo = `URA calma com ${contados} livres (máx. ${this.cfg.calmaLivresMax})`;
    for (const ramal of excessoDaCalma(candidatos, devolver)) {
      const r = await this.moverParaAtivo(ramal, motivo);
      if (r.ok) this.esperandoAtender.add(ramal);
    }
  }

  resumoDaCalma() {
    return {
      ativa: this.emCalmaComLimite(),
      min: this.cfg.calmaLivresMin ?? null,
      max: this.cfg.calmaLivresMax ?? null,
      contados: this.livresContadosNaCalma(),
      esperandoAtender: [...this.esperandoAtender],
    };
  }

  async atualizarDiretorio() {
    try {
      await this.diretorio?.atualizar();
    } catch (e) {
      this.log.debug(`Diretório indisponível: ${e.message}`);
    }
  }

  /** Quem está no Ativo e não está sendo mexido agora. */
  operadoresDoAtivo() {
    return this.gruposAtivos.flatMap((g) => (g.ramaisOperadores || [])
      .map((ramal) => ({ ramal: String(ramal), grupo: g.idGrupoUsuario })))
      .filter(({ ramal }) => !this.movidos[ramal] && !this.ramaisUra.has(ramal) && !this.emTransferencia.has(ramal)
        && !this.alinhandoLogin.has(ramal) && this.travadoEm(ramal) !== 'ativo' && !this.ehContaDeSupervisor(ramal));
  }

  /** Só quem é elegível (meta de ontem, venda hoje ou fixo) sobe; os demais nem são lidos. */
  podeIrParaUra(ramal) {
    return !this.elegiveis || this.elegiveis.permite(ramal);
  }

  /**
   * Lê quem está no Ativo; sobe quem atendeu lá e ficou livre. [NOVO] Com `subir: false` (URA
   * calma), só lê: devolve o livre para o completarLivresDaCalma escolher.
   * @returns {Promise<{ ramal: string, grupo: number, classe: string }|undefined>}
   */
  async verificarOperadorDoAtivo({ ramal, grupo }, { subir = true } = {}) {
    const { classe, status } = await this.lerStatus(ramal);
    if (classe === Classe.ERRO) return undefined;
    if (classe === Classe.OFFLINE) {
      this.atenderamNoAtivo.delete(ramal);
      return undefined;
    }
    // A lista de grupos pode estar desatualizada: só age se o status confirma o grupo.
    if (String(status.idGrupo) !== String(grupo)) return undefined;

    if (classe === Classe.ATENDIMENTO) {
      this.atenderamNoAtivo.add(ramal);
      this.esperandoAtender?.delete(ramal);
      return undefined;
    }
    if (!subir) return classe === Classe.LIVRE ? { ramal, grupo, classe } : undefined;
    if (deveIrParaUra(classe, this.atenderamNoAtivo.has(ramal))) await this.moverParaUra(ramal, grupo);
    return undefined;
  }

  /** @returns {Promise<boolean>} true se transferiu (ou simulou, em DRY_RUN) */
  async moverParaUra(ramal, grupoOrigem) {
    const ok = await this.comTrava(ramal, () => this.transferencias.transferir(ramal, this.cfg.grupoUraId));
    if (!ok) return false;
    // Em DRY_RUN ninguém foi movido de verdade: contá-lo como livre na URA inflaria o alvo de robôs.
    if (this.cfg.dryRun) {
      this.atenderamNoAtivo.delete(ramal);
      return true;
    }

    this.movidos[ramal] = { origemGrupoId: grupoOrigem, entrouEm: Date.now() };
    this.ramaisUra.add(ramal);
    this.aguardandoTroca.add(ramal);
    // Ainda não conta como livre: a discadora só troca a telefonia de grupo depois
    // (quando a pessoa fica livre, com atraso). A próxima leitura diz se já trocou.
    this.statusUra.set(ramal, { classe: Classe.OUTRO, ts: Date.now() });
    this.atenderamNoAtivo.delete(ramal);
    this.salvar();
    this.log.info(`ATIVO→URA ramal=${ramal} origem=${grupoOrigem}`);
    return true;
  }

  // ───────────────────────────── URA ─────────────────────────────

  async cicloUra() {
    if (this.desligandoAutomacao) return;
    const ramais = [...this.ramaisUra];
    // 1. Status de todos  2. Quem volta (e se é o último livre)  3. Robôs (é o que evita fila)  4. Devoluções
    await mapearComLimite(ramais, this.cfg.concorrencia, (ramal) => this.atualizarStatusUra(ramal));
    const agora = Date.now();
    // A regra do ocioso vale sempre, sem exceção: quem passou do TEMPO_MIN sai.
    // [NOVO] Saem do ramal maior para o menor (o de mais tempo de casa sai por último).
    const ociosos = porAntiguidade(ramais.filter((ramal) => this.deveDevolver(ramal, agora))).reverse();
    if (this.modoDosRobos() === 'automatico') this.prepararSaidaDoUltimoLivre(ramais, agora);
    await this.avaliarRobos();
    this.registrarFoto(Date.now());
    this.amostrarDia(Date.now());
    if (this.modoDosRobos() === 'automatico') this.verificarPassividade(agora);

    this.avisarSeSemWebhook();
    await mapearComLimite(ociosos, this.cfg.concorrencia, (ramal) => this.devolverAoAtivo(ramal));
    // [NOVO] URA calma: mais de URA_CALMA_LIVRES_MAX livres, o excesso volta ao Ativo.
    if (this.emCalmaComLimite()) await this.devolverExcessoDaCalma(ociosos);
  }

  /**
   * O último livre sai no horário (regra do ocioso). Sem ele, o alvo vira 0 e um
   * robô em ligação que derivar não acha ninguém (callback). Por isso, quando o
   * último livre está a PREPARAR_SAIDA_ULTIMO_LIVRE_MS de sair, os robôs param de
   * discar e os que estão em ligação terminam enquanto ele ainda está na URA.
   * Se ele atender ou aparecer outro livre, os robôs voltam.
   */
  prepararSaidaDoUltimoLivre(ramais, agora) {
    // No máximo metade do limite de ociosidade: senão, com um livre só, os robôs nunca discariam.
    const antecedenciaMs = Math.min(this.cfg.prepararSaidaMs ?? 0, (this.limiteOciosoBaseMs() ?? Infinity) / 2);
    const saindo = antecedenciaMs > 0 ? ramais.filter((ramal) => this.deveDevolver(ramal, agora + antecedenciaMs)) : [];
    const ramal = ultimoLivreQueSai({
      saindo, ramaisUra: ramais, status: this.statusUra, saidaEm: (r) => this.statusUra.get(r).livreDesde + this.limiteOciosoMs(r),
    });
    if (ramal === this.ultimoSaindo?.ramal) return;
    this.ultimoSaindo = ramal ? { ramal, desde: agora } : null;
    if (!ramal || !this.robos.situacao(this.ramaisRobos.length).ligados) return;
    this.log.info(`Ramal ${ramal} é o último livre da URA e sai por ociosidade em até ${Math.round(antecedenciaMs / 1000)} s: `
      + 'os robôs param de discar e os que estão em ligação terminam antes.');
  }

  /** Último livre prestes a sair que continua livre (se atendeu, os robôs voltam). */
  ultimoLivreSaindo() {
    const ramal = this.ultimoSaindo?.ramal;
    return ramal && this.statusUra.get(ramal)?.classe === Classe.LIVRE ? ramal : null;
  }

  async atualizarStatusUra(ramal) {
    if (this.alinhandoLogin.has(ramal)) return; // relogando: o "deslogado" de agora é passageiro
    const lido = await this.lerStatus(ramal);
    if (lido.classe === Classe.ERRO) return; // mantém o último status; a validade dele decide os robôs
    // Na lista da URA, mas a telefonia ainda em outro grupo: não recebe derivação,
    // então não conta como livre (nem liga robô para ela) até a troca acontecer.
    const preso = this.conferirGrupoLogado(ramal, lido.classe, lido.status);
    const classe = preso ? Classe.OUTRO : lido.classe;

    // Um "livre" lido logo depois do webhook de atendimento é atraso do polling: ignora.
    const anterior = this.statusUra.get(ramal);
    const dentroDaCarencia = anterior?.doWebhook && Date.now() - anterior.ts < this.cfg.carenciaWebhookMs;
    if (classe === Classe.LIVRE && dentroDaCarencia) return;

    // [NOVO] Tempo ocioso pelo tempoStatus da Argus (o "Tempo" da tela dela): uma leitura que pisca
    // não zera, e atender zera porque o status da Argus muda. Sem ele, desde a primeira leitura livre.
    const agora = Date.now();
    const detalhe = lido.status ? this.detalheDoStatus(lido.status, agora) : null;
    const daArgus = detalhe?.statusDesde ?? null;
    const livreDesde = classe === Classe.LIVRE ? (daArgus ?? anterior?.livreDesde ?? agora) : undefined;
    // [NOVO] Preso no grupo antigo, mas livre na telefonia: não conta para os robôs, e o tempo ocioso corre igual.
    const presoLivreDesde = preso && lido.classe === Classe.LIVRE ? (daArgus ?? anterior?.presoLivreDesde ?? agora) : undefined;
    const offlineDesde = classe === Classe.OFFLINE ? (anterior?.offlineDesde ?? agora) : undefined;
    const emCarencia = agora - (this.trocouEm.get(ramal) ?? -Infinity) < (this.cfg.carenciaTrocaMs ?? 0);
    if (classe === Classe.ATENDIMENTO && anterior?.classe !== Classe.ATENDIMENTO) {
      this.registrarDerivacao(agora, anterior?.livreDesde != null ? agora - anterior.livreDesde : null, ramal);
    }
    this.statusUra.set(ramal, { classe, ts: agora, livreDesde, presoLivreDesde, offlineDesde, emCarencia, detalhe });
  }

  /**
   * O que guardar do statusoperador (só dados do operador). [NOVO] pausa e
   * statusDesde: o tipo da pausa (descricaoPausa) e desde quando está no status
   * (agora − tempoStatus, em ms), para o painel do receptivo.
   */
  detalheDoStatus(status, agora) {
    const tempoStatus = Number(status.tempoStatus);
    return {
      grupo: status.idGrupo ?? null,
      origem: status.origemDerivacao ?? null,
      nome: status.nome ?? null,
      descricao: status.descricaoStatus ?? null,
      pausa: status.descricaoPausa ? String(status.descricaoPausa).trim() : null,
      statusDesde: Number.isFinite(tempoStatus) && tempoStatus >= 0 ? agora - tempoStatus : null,
    };
  }

  /**
   * O statusoperador traz o grupo em que a pessoa está LOGADA na telefonia
   * (doc 4.14). Mover de grupo (pelo painel ou pela API) muda a lista na hora,
   * mas a discadora só troca a telefonia quando a pessoa fica livre, e com
   * atraso. Enquanto isso a derivação dos robôs não chega nela.
   *
   * Quem continua em outro grupo depois de ALINHAR_LOGIN_APOS_MS ficou preso
   * (no preditivo, emendando ligação): avisa (uma vez; o /health lista) e, se
   * estiver livre, reloga na URA.
   * @returns {boolean} true se está na lista da URA, mas logado em outro grupo
   */
  conferirGrupoLogado(ramal, classe, status, agora = Date.now()) {
    const logado = Boolean(status) && classe !== Classe.OFFLINE && status.idGrupo != null;
    const emOutroGrupo = logado && Number(status.idGrupo) !== Number(this.cfg.grupoUraId);
    if (!emOutroGrupo) {
      if (logado) this.registrarTrocaParaUra(ramal, agora);
      this.esquecerGrupoLogado(ramal, logado);
      return false;
    }
    if (!this.foraDoGrupoDesde.has(ramal)) this.foraDoGrupoDesde.set(ramal, agora);
    if (agora - this.foraDoGrupoDesde.get(ramal) < (this.cfg.alinharAposMs ?? 30_000)) return true; // a discadora ainda pode trocar

    if (!this.logadosEmOutroGrupo.has(ramal)) this.avisarPresoEmOutroGrupo(ramal, status);
    if (classe === Classe.LIVRE) this.alinharLoginEmSegundoPlano(ramal, this.cfg.grupoUraId);
    return true;
  }

  avisarPresoEmOutroGrupo(ramal, status) {
    this.logadosEmOutroGrupo.set(ramal, { ramal, grupoLogado: status.idGrupo, grupo: status.grupo ?? null });
    this.log.aviso(`Ramal ${ramal} está no grupo da URA, mas a telefonia continua logada em "${status.grupo ?? '?'}" `
      + `(grupo ${status.idGrupo}): a derivação dos robôs não chega nele. Livre, é relogado; em ligação, espera.`);
  }

  /**
   * Leva a telefonia para o grupo em que a pessoa está vinculada (alinhar-login.js).
   * Em segundo plano, para não atrasar o ciclo; uma vez por ramal a cada 60 s.
   */
  alinharLoginEmSegundoPlano(ramal, idGrupo) {
    if (!this.cfg.alinharLogin || this.alinhandoLogin.has(ramal)) return;
    const agora = Date.now();
    if (agora - (this.ultimoAlinhamento.get(ramal) || 0) < INTERVALO_ALINHAMENTO_MS) return;

    this.ultimoAlinhamento.set(ramal, agora);
    this.alinhandoLogin.add(ramal);
    alinharLogin({ client: this.client, ramal, idGrupo, dryRun: this.cfg.dryRun, log: this.log, esperaMs: this.cfg.esperaLoginMs })
      .finally(() => this.alinhandoLogin.delete(ramal));
  }

  /**
   * A telefonia acabou de passar para a URA (era de outro grupo, ou a pessoa
   * acabou de ser movida): a carência (CARENCIA_TROCA_GRUPO_MS) começa agora.
   */
  registrarTrocaParaUra(ramal, agora) {
    if (!this.foraDoGrupoDesde.has(ramal) && !this.aguardandoTroca.has(ramal)) return;
    this.aguardandoTroca.delete(ramal);
    this.trocouEm.set(ramal, agora);
    const carencia = this.cfg.carenciaTrocaMs ?? 0;
    if (carencia > 0) this.log.info(`Ramal ${ramal}: telefonia na URA; conta como livre para os robôs em ${Math.round(carencia / 1000)} s.`);
  }

  esquecerGrupoLogado(ramal, logadoNaUra) {
    this.foraDoGrupoDesde.delete(ramal);
    if (this.logadosEmOutroGrupo.delete(ramal) && logadoNaUra) this.log.info(`Ramal ${ramal} agora está logado no grupo da URA.`);
  }

  /** [NOVO] Limite de ociosidade sem a prioridade: 2 min com a URA cheia (URA_CHEIA_TEMPO_MIN), senão o TEMPO_MIN. */
  limiteOciosoBaseMs() {
    return this.emUraCheia() && this.cfg.tempoNaUraCheiaMs ? this.cfg.tempoNaUraCheiaMs : this.cfg.tempoNaUraMs;
  }

  /**
   * [NOVO] Limite de ociosidade deste ramal: o base mais a escada do tempo de casa (entre os
   * humanos não fixos da URA, o ramal maior ganha 0 e cada posição acima, PRIORIDADE_RAMAL_PASSO_S).
   */
  limiteOciosoMs(ramal) {
    const concorrentes = this.humanosNaUra().filter((r) => !this.permanentes.has(String(r)));
    return this.limiteOciosoBaseMs() + bonusDeAntiguidade(ramal, concorrentes, {
      passoMs: this.cfg.prioridadeRamalPassoMs ?? 0, maxMs: this.cfg.prioridadeRamalMaxMs ?? 0,
    });
  }

  /** [NOVO] Conta operacional de supervisor (não fica na URA; contas-supervisores.js). */
  ehContaDeSupervisor(ramal) {
    return Boolean(this.contasSupervisores?.eh(ramal));
  }

  deveDevolver(ramal, agora) {
    const info = this.statusUra.get(ramal);
    if (!info || this.emTransferencia.has(ramal)) return false;
    // [NOVO] Conta de supervisor: sai assim que não estiver em ligação (nem fixa fica), a não ser posta à mão.
    if (this.ehContaDeSupervisor(ramal) && this.travadoEm(ramal) !== 'ura') {
      return info.classe === Classe.LIVRE || info.classe === Classe.OUTRO;
    }
    // Fixos ficam na URA de vez: o ocioso não vale (deslogado segue a regra normal).
    if (this.permanentes.has(String(ramal)) && info.classe !== Classe.OFFLINE) return false;
    // Travado à mão na URA pelo painel: fica até liberarem.
    if (this.travadoEm(ramal) === 'ura') return false;
    // [NOVO] Preso no grupo antigo e livre além do limite: não recebe derivação e só ocupa a vaga. Volta ao Ativo.
    if (info.presoLivreDesde != null && agora - info.presoLivreDesde >= this.limiteOciosoMs(ramal)) return true;
    return deveVoltarAoAtivo({
      classe: info.classe, livreDesde: info.livreDesde, agora, ociosoMs: this.limiteOciosoMs(ramal), movido: this.movidos[ramal],
      offlineDesde: info.offlineDesde, offlineMs: this.cfg.offlineVoltaAposMs,
    });
  }

  /**
   * Quem o rodízio moveu volta ao grupo de origem; os demais, ao grupo do Ativo
   * do supervisor; sem ele, ao grupo de onde o roteador o tirou (se for do Ativo).
   */
  async grupoDeVolta(ramal) {
    const movido = this.movidos[ramal];
    if (movido) return movido.origemGrupoId;
    const doSupervisor = await this.grupoDoSupervisor(ramal);
    if (doSupervisor != null) return doSupervisor;
    const origem = this.elegiveis?.grupoDeOrigem?.(ramal) ?? null;
    return origem != null && (this.cfg.gruposAtivosIds || []).includes(origem) ? origem : null;
  }

  async grupoDoSupervisor(ramal) {
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
    const r = await this.moverParaAtivo(ramal, this.ehContaDeSupervisor(ramal) ? 'conta de supervisor não fica na URA' : null);
    if (r.ok) this.esperandoAtender.add(ramal); // [NOVO] só sobe de novo depois de atender no Ativo
    // [NOVO] Passou do tempo e não saiu: diz por quê (uma vez, até conseguir).
    this.naoSaiu ??= new Set();
    if (r.ok) this.naoSaiu.delete(ramal);
    else if (!this.semGrupoAvisados.has(ramal) && !this.naoSaiu.has(ramal)) { // sem grupo já tem o aviso dele
      this.naoSaiu.add(ramal);
      this.log.aviso(`Ramal ${ramal} passou do tempo livre na URA, mas não voltou ao Ativo: ${r.erro}.`);
    }
  }

  /**
   * URA → Ativo, ao grupo de volta dele. @param {string} [motivo] - para o log (padrão: o da regra do ocioso)
   * @returns {Promise<{ ok: boolean, erro?: string }>}
   */
  async moverParaAtivo(ramal, motivo = null) {
    const info = this.statusUra.get(ramal) || {};
    const destino = await this.grupoDeVolta(ramal);
    if (destino == null) {
      this.avisarSemGrupo(ramal);
      return { ok: false, erro: 'sem grupo do Ativo identificável' };
    }

    const ok = await this.comTrava(ramal, () => this.transferencias.transferir(ramal, destino));
    if (!ok) return { ok: false, erro: 'a transferência não foi aceita agora' };

    delete this.movidos[ramal];
    this.ramaisUra.delete(ramal);
    this.statusUra.delete(ramal);
    this.aguardandoTroca.delete(ramal);
    this.trocouEm.delete(ramal);
    this.vigiarNoAtivo(ramal, destino);
    this.salvar();
    const limite = info.classe === Classe.LIVRE && !motivo ? `, limite ${formatarMinSeg(this.limiteOciosoMs(ramal))}${this.emUraCheia() ? ' na URA cheia' : ''}` : '';
    this.log.info(`URA→ATIVO ramal=${ramal} destino=${destino} (motivo: ${motivo ?? motivoDaVolta({ ...info, agora: Date.now() })}${limite})`);
    return { ok: true };
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
      + 'Fica na URA. Rode npm run conferir:supervisores e defina o grupo em SUPERVISORES_GRUPOS_FILE (ex.: { "ROBSON JUNIOR": 20 }).');
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
    if (this.desligandoAutomacao) return undefined;
    // [NOVO] "Desligados" no painel: os parados saem na hora, os em ligação ao terminar; ninguém liga.
    if (this.robosDesligadosPeloPainel()) {
      this.excessoDesde = null;
      if (!this.robos.ligados?.size) return undefined;
      return this.robos.encerrarSemDerrubar('robôs desligados pelo painel');
    }
    if (this.emModoPanico()) return this.aplicarPanico();
    if (this.ultimoLivreSaindo()) {
      this.excessoDesde = null;
      return this.robos.encerrarSemDerrubar(`último livre (${this.ultimoSaindo.ramal}) saindo por ociosidade`);
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
        porLivre: this.porLivreComStatus(agora),
        maximo: this.cfg.robosMaximo,
        maxComUmLivre: this.maxComUmLivreAgora(agora),
        todosComLivres: this.todosComLivresAgora(agora),
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

  // ───────────────────────────── Modo pânico ─────────────────────────────

  /** ROBOS_MODO=panico: a supervisão liga os robôs; o BenURA só os desliga no pânico. */
  emModoPanico() {
    return this.modoDosRobos() === 'panico';
  }

  /** [NOVO] Modo dos robôs agora: o escolhido no painel ou, sem escolha, o ROBOS_MODO do .env. */
  modoDosRobos() {
    return this.modoRobos?.modo ?? this.cfg.robosModo;
  }

  /** [NOVO] "Desligados" no painel: o BenURA mantém os robôs desligados (o resto da automação segue). */
  robosDesligadosPeloPainel() {
    return this.modoDosRobos() === 'desligados';
  }

  /**
   * [NOVO] PUT /robos/modo: a supervisão troca o modo dos robôs pelo painel. Vale na hora.
   * @returns {{ mudou: boolean, modo: string }}
   */
  definirModoRobos(modo, por = null) {
    if (!this.modoRobos) throw new Error('modo dos robôs indisponível');
    const antes = this.modoDosRobos();
    const { mudou } = this.modoRobos.definir(modo, por);
    if (mudou) {
      const nomes = { automatico: 'automático (o BenURA liga e desliga)', panico: 'só pânico (a supervisão liga)', desligados: 'desligados' };
      this.log.aviso(`Robôs: ${nomes[antes] ?? antes} → ${nomes[modo]} pelo painel${por ? ` (${por})` : ''}.`);
      if (antes === 'panico' && modo !== 'panico') this.encerrarPanico(this.ultimosLivres ?? 0);
      this.avaliarRobos().catch((e) => this.log.erro(`Falha ao aplicar o modo dos robôs: ${e.message}`));
    }
    return { mudou, modo: this.modoDosRobos() };
  }

  /**
   * Modo pânico: o BenURA nunca liga robôs. Com o interruptor ligado, conta os
   * livres da URA (mesma contagem dos robôs proporcionais: carência, outro grupo
   * e status sem resposta não contam) e desliga os robôs quando:
   *  - 0 livre: todos, inclusive os em ligação (não há quem receba a derivação);
   *  - 1 livre comum que sai por ociosidade em até PANICO_ANTES_DE_SAIR_MS: os
   *    parados; os em ligação terminam a chamada enquanto ele ainda está na URA;
   *  - 1 livre fixo (nunca sai): metade dos ligados (poupando quem está em
   *    ligação; fica pelo menos 1) e de novo a cada PANICO_FIXO_REDUZIR_A_CADA_S. Não reduz com a
   *    URA passiva (manual, ou o termômetro em calma) nem quando ele já está
   *    livre há PANICO_FIXO_OCIOSO_MIN: aí os robôs seguem até ele atender (e
   *    sobra 0 livre).
   * O vigia de clientes de risco desliga à parte, com o interruptor dele.
   */
  async aplicarPanico() {
    const agora = Date.now();
    const { livres } = alvoDeRobos({
      ramaisUra: [...this.ramaisUra],
      status: this.statusUra,
      agora,
      total: this.ramaisRobos.length,
      cfg: { porLivre: 1, validadeStatusMs: Math.max(VALIDADE_STATUS_MS, this.cfg.pollUraMs * 2 + 1000) },
    });
    this.registrarMudancaDeLivres(livres, null);
    this.ultimosLivres = livres;

    const panico = this.panico?.ligado() ? this.motivoDoPanico(livres, agora) : null;
    if (panico?.tipo !== 'fixo') this.reducaoFixo = null;
    if (!panico) return this.encerrarPanico(livres);
    if (panico.texto !== this.panicoMotivo) await this.entrarEmPanico(panico, livres, agora);

    if (panico.tipo === 'fixo') return this.reduzirAMetade(panico, agora);
    const ligados = [...(this.robos.ligados || [])];
    if (!ligados.length) return undefined;
    if (livres === 0) return this.robos.desligar(ligados, panico.texto);
    return this.robos.encerrarSemDerrubar(panico.texto);
  }

  /**
   * Por que desligar os robôs agora.
   * @returns {{ tipo: 'zero'|'saindo'|'fixo', texto: string, ramal?: string }|null} null = os robôs seguem
   */
  motivoDoPanico(livres, agora) {
    if (livres === 0) return { tipo: 'zero', texto: 'PÂNICO: 0 livre na URA' };
    if (livres > 1) return null;
    const [ramal] = livresUteis([...this.ramaisUra], this.statusUra);
    if (!ramal) return null;
    if (this.permanentes.has(String(ramal))) return this.motivoDoFixo(ramal, agora);
    // [NOVO] URA calma: com 1 livre comum, os robôs seguem até ele bater o tempo e ir para o Ativo
    // (aí sobra 0 livre e a linha de cima desliga todos).
    if (this.uraPassivaAgora()) return null;
    const antesMs = this.cfg.panicoAntesDeSairMs ?? 0;
    if (!this.deveDevolver(ramal, agora + antesMs)) return null;
    return { tipo: 'saindo', texto: `PÂNICO: 1 livre na URA (${ramal}) e ele sai por ociosidade em até ${Math.round(antesMs / 1000)} s` };
  }

  /** 1 livre e ele é fixo: reduz à metade, a não ser que a URA esteja passiva ou ele já espere há muito. */
  motivoDoFixo(ramal, agora) {
    if (this.uraPassivaAgora()) return null; // URA calma (termômetro ou escolha da supervisão)
    const ociosoMs = this.cfg.panicoFixoOciosoMs ?? Infinity;
    const livreDesde = this.statusUra.get(ramal)?.livreDesde ?? agora;
    if (agora - livreDesde >= ociosoMs) {
      if (this.fixoOciosoAvisado !== `${ramal}:${livreDesde}`) {
        this.fixoOciosoAvisado = `${ramal}:${livreDesde}`;
        this.log.info(`Ramal ${ramal} (fixo) livre há ${Math.round(ociosoMs / 60_000)} min: os robôs seguem até ele atender.`);
      }
      return null;
    }
    const passoS = Math.round((this.cfg.panicoFixoReduzirMs ?? 60_000) / 1000);
    return {
      tipo: 'fixo',
      ramal: String(ramal),
      texto: `PÂNICO: 1 livre na URA (${ramal}, fixo): metade dos robôs a cada ${passoS} s até ele atender`,
    };
  }

  /** URA calma agora? (o status manual do painel, se houver; senão, o termômetro) */
  uraPassivaAgora() {
    if (this.statusDaUra) return this.statusDaUra.atual(this.termometro) === 'calma';
    return Boolean(this.termometro?.calma());
  }

  /**
   * 1 fixo livre: desliga a metade dos robôs ligados (os parados primeiro; quem
   * está em ligação termina a chamada) e repete a cada PANICO_FIXO_REDUZIR_A_CADA_S.
   */
  async reduzirAMetade({ ramal, texto }, agora) {
    const passoMs = this.cfg.panicoFixoReduzirMs ?? 60_000;
    if (this.reducaoFixo?.ramal === ramal && agora - this.reducaoFixo.ultimaEm < passoMs) return undefined;
    this.reducaoFixo = { ramal, ultimaEm: agora };
    // Relê a cada passo: pega os robôs que a supervisão ligou desde a última leitura.
    if (this.ramaisRobos.length) await this.robos.sincronizar(this.ramaisRobos);
    const ligados = this.robos.ligados ? this.robos.ligados.size : 0;
    // Um robô só não deriva duas ligações juntas: fica (a derivação vai para o fixo e aí sobra 0 livre).
    const alvo = Math.max(1, Math.floor(ligados / 2));
    if (alvo >= ligados) return undefined;
    this.robos.alvo = alvo;
    return this.robos.reduzirPoupando(alvo, `${texto} (${ligados} → ${alvo})`);
  }

  async entrarEmPanico({ tipo, texto }, livres, agora) {
    const comecou = !this.panicoDesde;
    this.panicoDesde ??= agora;
    this.panicoMotivo = texto;
    this.panicoTipo = tipo;
    this.estatisticas?.registrarPanico(tipo, agora);
    const acao = tipo === 'fixo' ? 'reduzindo os robôs à metade' : `desligando os robôs${livres ? ' (os em ligação terminam antes)' : ''}`;
    this.log.aviso(`${texto} — ${acao}.`);
    // Pega os robôs que a supervisão ligou desde a última leitura (a cada REFRESH_GRUPOS_MS).
    if (comecou && tipo !== 'fixo' && this.ramaisRobos.length) await this.robos.sincronizar(this.ramaisRobos);
  }

  encerrarPanico(livres) {
    if (!this.panicoDesde) return;
    this.panicoDesde = null;
    this.panicoMotivo = null;
    this.panicoTipo = null;
    const porque = this.panico?.ligado() ? `${livres} livre(s) na URA` : 'interruptor desligado';
    this.log.info(`PÂNICO encerrado (${porque}): a supervisão pode religar os robôs pelo painel.`);
  }

  /**
   * Alguém da URA começou a atender (derivação): mede a URA passiva, o termômetro e o relatório do dia.
   * @param {number|null} [esperaMs] - quanto ele esperou livre até a ligação chegar
   */
  registrarDerivacao(agora, esperaMs = null, ramal = null) {
    this.ultimoAtendimentoUraEm = agora;
    this.derivacoesRecentes.push(agora);
    this.descartarAntigas(agora);
    this.termometro?.registrarDerivacao(agora, esperaMs);
    this.estatisticas?.registrarDerivacao(agora, ramal, esperaMs);
  }

  /** Fim do ciclo da URA: amostra para o termômetro e o relatório do dia. */
  amostrarDia(agora) {
    const amostra = { livres: this.ultimosLivres ?? 0, robosLigados: this.robos.situacao(this.ramaisRobos.length).ligados };
    // Quem está livre agora (e conta para os robôs): há quanto tempo espera uma ligação.
    const esperasEmCursoMs = livresUteis([...this.ramaisUra], this.statusUra)
      .map((r) => this.statusUra.get(r)?.livreDesde)
      .filter((desde) => desde != null)
      .map((desde) => agora - desde);
    const termometro = this.termometro?.amostrar(agora, { esperasEmCursoMs }) ?? null;
    const pausas = this.humanosNaUra().map((r) => this.statusUra.get(r)).filter((s) => s?.classe === Classe.OUTRO && s.detalhe?.pausa)
      .map((s) => s.detalhe.pausa);
    // [NOVO] relatório por atendente: cada humano da URA e o status dele agora
    const operadores = this.humanosNaUra().map((ramal) => {
      const s = this.statusUra.get(ramal);
      return {
        ramal, nome: s?.detalhe?.nome ?? null, classe: s?.classe ?? null,
        pausa: s?.classe === Classe.OUTRO ? s?.detalhe?.pausa ?? null : null,
        statusDesde: s?.detalhe?.statusDesde ?? null, livreDesde: s?.livreDesde ?? null,
      };
    });
    this.estatisticas?.amostrar(agora, {
      ...amostra, panico: this.panicoTipo, termometro: this.statusAtualDaUra() ?? termometro, pausas, operadores,
    });
  }

  /** [NOVO] Status da URA que vale agora (manual ou do termômetro). */
  statusAtualDaUra() {
    return this.statusDaUra ? this.statusDaUra.atual(this.termometro) : this.termometro?.estado ?? null;
  }

  /** [NOVO] Humanos da lista da URA (sem robô e sem operador virtual). */
  humanosNaUra() {
    const robos = new Set(this.ramaisRobos.map(String));
    return [...this.ramaisUra].filter((r) => !robos.has(String(r)) && !ehOperadorVirtual(this.statusUra.get(r)?.detalhe?.nome));
  }

  /**
   * [NOVO] Ligação da URA terminou (webhook 4 ou 5): lead derivado ou transbordo, para o painel.
   * @param {{ chave: string|null, derivou: boolean, motivo: string, filaSeg: number|null }} encerramento
   */
  registrarEncerramentoUra(encerramento, agora = Date.now()) {
    this.ultimoEncerramentoEm = agora;
    this.estatisticas?.registrarEncerramento(agora, encerramento, 'webhook');
  }

  /**
   * [NOVO] O mesmo, pelo relatório de ligações da Argus (vigia de callbacks): funciona sem os
   * webhooks. A chave (idLigacao) é a mesma do webhook: a ligação conta uma vez só.
   */
  registrarEncerramentoDoRelatorio(encerramento, agora = Date.now()) {
    return this.estatisticas?.registrarEncerramento(agora, encerramento, 'relatório') ?? false;
  }

  /** [NOVO] GET /metricas/hoje: leads derivados, transbordos e a espera, do dia (00:00 até agora). */
  metricasHoje() {
    const r = this.estatisticas?.resumo() ?? null;
    return {
      dia: r?.dia ?? null,
      leadsDerivadosHoje: r ? r.leadsDerivados : null,
      transbordosHoje: r ? r.transbordos : null,
      transbordosPorMotivo: r?.transbordosPorMotivo ?? {},
      filaClienteMediaSeg: r?.filaMediaSeg ?? null,
      esperaLivresSeg: this.termometro ? this.termometro.resumo().esperaSeg : null,
      // Ligações esperando na fila agora: a API da Argus não tem esse dado em tempo real
      // (só o painel deles). Fica null até existir uma fonte (ex.: um webhook de entrada na fila).
      emFilaAgora: null,
      ultimoWebhookEncerramento: this.ultimoEncerramentoEm ? new Date(this.ultimoEncerramentoEm).toISOString() : null,
      // [NOVO] a última ligação contada (webhook ou relatório), e de onde veio
      ultimoEncerramento: r?.ultimoEncerramento ?? null,
    };
  }

  /**
   * Linha do tempo da URA: uma linha a cada mudança no número de livres, para
   * cruzar com a hora de cada callback (npm run diagnostico:callbacks).
   */
  registrarMudancaDeLivres(livres, alvo) {
    if (livres === this.ultimosLivres) return;
    const humanos = [...this.ramaisUra].filter((r) => this.statusUra.has(r) && this.statusUra.get(r).classe !== Classe.OFFLINE).length;
    const { ligados } = this.robos.situacao(this.ramaisRobos.length);
    this.log.info(`URA: livres ${this.ultimosLivres ?? '?'}→${livres} | humanos ${humanos} | robôs ligados ${ligados ?? '?'}${alvo == null ? '' : ` (alvo ${alvo})`}`
      + `${this.descreverLivres()}`);
  }

  /**
   * Quem está Livre na URA e como a Argus o vê (grupo logado, origem da
   * derivação, carência): para entender um callback com gente "livre no painel".
   */
  descreverLivres() {
    const livres = [...this.ramaisUra].filter((r) => this.statusUra.get(r)?.classe === Classe.LIVRE);
    if (!livres.length) return '';
    const descrever = (r) => {
      const { detalhe, emCarencia } = this.statusUra.get(r);
      const partes = [detalhe?.grupo != null ? `grupo ${detalhe.grupo}` : null, detalhe?.origem, emCarencia ? 'carência' : null]
        .filter(Boolean);
      return partes.length ? `${r} (${partes.join(', ')})` : r;
    };
    return ` | livres: ${livres.map(descrever).join('; ')}`;
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
    const anterior = this.statusUra.get(ramal);
    const agora = Date.now();
    this.statusUra.set(ramal, { classe: Classe.ATENDIMENTO, ts: agora, doWebhook: true, detalhe: anterior?.detalhe ? { ...anterior.detalhe, pausa: null, statusDesde: agora } : null });
    if (anterior?.classe === Classe.ATENDIMENTO) this.ultimoAtendimentoUraEm = agora;
    else this.registrarDerivacao(agora, anterior?.livreDesde != null ? agora - anterior.livreDesde : null, ramal);
    this.log.debug(`webhook: ${ramal} em atendimento na URA`);
    this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após webhook: ${e.message}`));
  }

  /**
   * O cliente pediu um humano e desistiu na fila (webhook de encerramento de URA).
   * Registra com a situação da URA naquele instante e, com o ajuste ligado,
   * baixa um degrau de robôs por livre e reavalia os robôs na hora.
   * @param {{ motivo: string, chave: string|null }} callback
   * @param {string} [situacao] - padrão: a URA agora (webhook, na hora do callback)
   */
  registrarCallback(callback, situacao = this.situacaoAgora(), ts = Date.now()) {
    this.termometro?.registrarCallback(ts);
    if (!this.ajuste || this.emModoPanico()) {
      this.log.aviso(`Callback (${callback.motivo}) com ${situacao}.`);
      return;
    }
    // [NOVO] Com a taxa valendo, o callback já pesa pelo status (agressiva por 5 min): o ajuste não desce.
    if (this.calculoDosRobos(ts)?.fonte === 'taxa') {
      this.log.aviso(`Callback (${callback.motivo}) com ${situacao}. Robôs pela taxa real: o status da URA ajusta.`);
      return;
    }
    const baixou = this.ajuste.registrarCallback(callback, { manual: Date.now() < this.manualAte, situacao });
    if (baixou) this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após callback: ${e.message}`));
  }

  situacaoAgora() {
    const { ligados } = this.robos.situacao(this.ramaisRobos.length);
    return `${this.ultimosLivres ?? '?'} livre(s) na URA e ${ligados ?? '?'} robô(s) ligado(s)${this.descreverLivres()}`;
  }

  // ───────────────────────────── Raio-x dos callbacks ─────────────────────────────

  /** Foto da URA deste ciclo (só dados do operador). Guarda os últimos FOTOS_MS. */
  registrarFoto(agora) {
    const ura = [...this.ramaisUra].filter((r) => this.statusUra.has(r)).map((ramal) => {
      const { classe, emCarencia, detalhe } = this.statusUra.get(ramal);
      return {
        ramal,
        nome: detalhe?.nome ?? null,
        classe,
        grupo: detalhe?.grupo ?? null,
        emCarencia: Boolean(emCarencia),
        trocouEm: this.trocouEm.get(ramal) ?? null,
        movidoEm: this.movidos[ramal]?.entrouEm ?? null,
      };
    });
    const { ligados, alvo } = this.robos.resumo();
    this.fotos.push({ ts: agora, robos: { ligados: ligados ?? null, alvo: alvo ?? null }, ura });
    while (this.fotos.length && agora - this.fotos[0].ts > FOTOS_MS) this.fotos.shift();
    this.amostrarRobos(agora, ligados ?? 0);
  }

  /** [NOVO] Quantos robôs estavam ligados agora (integra os robô-minutos da taxa). */
  amostrarRobos(agora, ligados) {
    this.amostrasRobos.push({ ts: agora, ligados });
    this.descartarAntigas(agora);
  }

  descartarAntigas(agora) {
    const desde = agora - this.janelaDaTaxa();
    while (this.derivacoesRecentes.length && this.derivacoesRecentes[0] < desde) this.derivacoesRecentes.shift();
    while (this.amostrasRobos.length && this.amostrasRobos[0].ts < desde) this.amostrasRobos.shift();
  }

  janelaDaTaxa() {
    return (this.cfg.robosTaxa ?? CALCULO_PADRAO).janelaMs;
  }

  /** Houve robô ligado em alguma foto de `janelaMs` para cá? (o vigia de callbacks só lê nesse caso) */
  teveRoboLigado(agora, janelaMs) {
    return this.fotos.some((f) => f.ts >= agora - janelaMs && f.robos.ligados > 0)
      || Boolean(this.robos.situacao(this.ramaisRobos.length).ligados);
  }

  /**
   * Callback achado no relatório da Argus (vigia-callbacks.js): grava o raio-x da
   * URA na hora da ligação (linha "CALLBACK", vai para callbacks.txt) e desce o ajuste.
   * @param {{ motivo: string, chave: string|null, inicio: number|null, fim: number|null, robo: string|null }} c
   */
  registrarCallbackDoRelatorio({ motivo, chave, inicio, fim, robo }) {
    const fuso = this.cfg.fusoHorario ?? 'America/Sao_Paulo';
    const raioX = inicio == null
      ? { linha: `CALLBACK (hora não veio no relatório) ${robo ?? ''} | sem raio-x` }
      : raioXDoCallback({ fotos: this.fotos, inicio, fim: fim ?? inicio, grupoUraId: this.cfg.grupoUraId, fuso, robo });
    this.log.aviso(raioX.linha);
    const quando = inicio == null ? '' : ` às ${horaNoFuso(inicio, fuso)}`;
    this.registrarCallback({ motivo, chave }, `relatório da Argus${quando}`, inicio ?? Date.now());
  }

  /**
   * URA passiva: há livre, os robôs já estão todos no alvo e ninguém da URA
   * atende há ROBOS_PASSIVA_APOS_MIN. Sobe os robôs por livre (até o máximo).
   * Não vale no modo manual dos robôs nem quando o último livre está saindo.
   */
  verificarPassividade(agora = Date.now()) {
    // Com 1 livre o teto ROBOS_MAX_COM_1_LIVRE manda: subir o "por livre" ali só viraria uma
    // rajada quando chegasse o segundo livre.
    // Em DRY_RUN os robôs não discam de verdade: sem derivação, a URA sempre pareceria passiva.
    if (!this.ajuste || this.cfg.dryRun || !(this.ultimosLivres > 1) || agora < this.manualAte || this.ultimoLivreSaindo()) return;
    if (this.calculoDosRobos(agora)?.fonte === 'taxa') return; // [NOVO] a taxa já mede a URA passiva
    const { ligados, alvo } = this.robos.resumo();
    if (!ligados || ligados < alvo) return;
    const semDerivacaoMs = agora - this.ultimoAtendimentoUraEm;
    if (semDerivacaoMs < (this.cfg.passivaMs ?? Infinity)) return;
    const situacao = `${Math.floor(semDerivacaoMs / 60_000)} min sem derivação com ${this.ultimosLivres} livre(s) e ${ligados} robô(s)`;
    if (this.ajuste.subirPorPassividade(agora, situacao)) {
      this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após subir o ajuste: ${e.message}`));
    }
  }

  /** Vigia de clientes de risco (interruptor ligado): para de discar sem derrubar quem está em ligação. */
  async desligarPorClienteDeRisco(motivo) {
    if (this.emModoManual()) return undefined;
    return this.robos.encerrarSemDerrubar(motivo);
  }

  /** POST/DELETE /panico. @returns {{ ligado: boolean, desde: string|null, mudou: boolean }} */
  definirPanico(ligado) {
    const mudou = this.panico.definir(ligado);
    this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após mudar o pânico: ${e.message}`));
    return { ...this.panico.resumo(), mudou };
  }

  /**
   * [NOVO] PUT /ura/status { status, modo }: a supervisão fixa o status da URA (manual)
   * ou devolve ao termômetro (automático). Vale para todos e muda a regra do pânico.
   * @throws {Error} status/modo inválidos
   */
  definirStatusUra(pedido, por = null) {
    const { mudou } = this.statusDaUra.definir(pedido, por);
    this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após mudar o status da URA: ${e.message}`));
    return { ...this.statusDaUra.resumo(this.termometro), mudou };
  }

  /** [NOVO] Quem do Ativo pode voltar para a URA ao retomar (vendeu hoje, meta de ontem ou fixo). null = sem lista. */
  elegiveisNoAtivo() {
    if (!this.elegiveis) return null;
    return this.operadoresDoAtivo().filter(({ ramal }) => this.elegiveis.permite(ramal));
  }

  /**
   * [NOVO] POST /operadores/retomar-rodizio: desliga a retenção e leva para a URA, na
   * hora, quem do Ativo é elegível. Daí em diante o rodízio segue normal. Sem lista
   * de elegíveis (RODIZIO_SO_ELEGIVEIS=0), ninguém é movido: o rodízio gira todos.
   * @returns {Promise<{ movidos: string[], erros: Array<{ ramal, erro }>, semLista: boolean, mudou: boolean }>}
   */
  async retomarRodizio(por = null) {
    const mudou = Boolean(await this.retencao?.desligar(por));
    await this.elegiveis?.atualizar();
    const lista = this.elegiveisNoAtivo();
    if (!lista) return { movidos: [], erros: [], semLista: true, mudou };
    const alvos = porAntiguidade(lista, (a) => a.ramal); // [NOVO] ramal menor volta primeiro
    const movidos = [];
    const erros = [];
    await mapearComLimite(alvos, this.cfg.concorrencia ?? 5, async ({ ramal, grupo }) => {
      if (await this.moverParaUra(ramal, grupo)) movidos.push(ramal);
      else erros.push({ ramal, erro: 'a transferência não foi aceita agora' });
    });
    this.log.aviso(`Retomar rodízio da URA${por ? ` (${por})` : ''}: ${movidos.length} voltaram para a URA${erros.length ? `, ${erros.length} erro(s)` : ''}.`);
    if (movidos.length) this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após retomar o rodízio: ${e.message}`));
    return { movidos, erros, semLista: false, mudou };
  }

  /** POST/DELETE /ura/passiva (página /ura antiga): o mesmo que o status manual CALMA / automático. */
  definirUraPassiva(ligado) {
    const r = this.definirStatusUra(ligado ? { status: 'calma', modo: 'manual' } : { modo: 'automatico' }, 'página /ura');
    return { ...this.uraPassivaResumo(), mudou: r.mudou };
  }

  /** A "URA passiva" de antes: o status manual em calma. */
  uraPassivaResumo() {
    const e = this.statusDaUra?.escolha;
    const ligado = Boolean(e && e.modo === 'manual' && e.status === 'calma');
    return { ligado, desde: ligado ? e.desde : null };
  }

  /**
   * [NOVO] Quem o "Alocar Todos no Ativo" moveria: humanos da URA que não são fixos.
   * O filtro é sempre aqui (nunca no painel).
   */
  candidatosAoAtivo() {
    const humanos = this.humanosNaUra();
    return {
      elegiveis: humanos.filter((r) => !this.permanentes.has(String(r))),
      fixos: humanos.filter((r) => this.permanentes.has(String(r))),
    };
  }

  /**
   * [NOVO] POST /operadores/transferir-ura-ativo: todos os humanos da URA que não são
   * fixos voltam ao Ativo (cada um ao seu grupo de volta, como na regra do ocioso) e
   * ficam lá: liga a retenção (ninguém sobe até "Retomar rodízio da URA").
   * Com a URA cheia ligada, desliga antes.
   * Respeita o DRY_RUN (transferencias.js).
   * @returns {Promise<{ movidos: string[], ignorados: Array<{ ramal, motivo }>, erros: Array<{ ramal, erro }>, uraCheiaDesligada: boolean }>}
   */
  async transferirUraParaAtivo(por = null) {
    // Antes de mover: o ciclo do Ativo não traz ninguém de volta no meio (nem o roteador, que lê o mesmo arquivo).
    await this.retencao?.ligar(por);
    const uraCheiaDesligada = Boolean(this.uraCheia && this.emUraCheia() && this.desligarUraCheia().mudou);
    const robos = new Set(this.ramaisRobos.map(String));
    const movidos = [];
    const ignorados = [];
    const erros = [];
    for (const ramal of [...this.ramaisUra]) {
      const nome = this.statusUra.get(ramal)?.detalhe?.nome ?? null;
      if (robos.has(String(ramal)) || ehOperadorVirtual(nome)) continue; // robô: nem conta
      if (this.permanentes.has(String(ramal))) {
        ignorados.push({ ramal, nome, motivo: 'fixo' });
        continue;
      }
      if (this.travadoEm(ramal) === 'ura') {
        ignorados.push({ ramal, nome, motivo: 'travado' });
        continue;
      }
      const r = await this.moverParaAtivo(ramal, 'alocar todos no Ativo');
      if (r.ok) movidos.push(ramal);
      else erros.push({ ramal, nome, erro: r.erro });
    }
    this.log.aviso(`Alocar todos no Ativo${por ? ` (${por})` : ''}: ${movidos.length} movido(s), ${ignorados.length} mantido(s) na URA (fixo ou travado), `
      + `${erros.length} erro(s)${uraCheiaDesligada ? '; URA cheia desligada' : ''}.`);
    if (movidos.length) this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após alocar todos no Ativo: ${e.message}`));
    return { movidos, ignorados, erros, uraCheiaDesligada };
  }

  /** POST /robos/por-livre: a supervisão ajusta na hora. @returns {object} resumo do ajuste */
  definirRobosPorLivre(valor) {
    this.ajuste.definir(valor);
    this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após o ajuste manual: ${e.message}`));
    return this.ajuste.resumo();
  }

  /**
   * [NOVO] Robôs por livre que valem no modo automático:
   *  - escolhido à mão hoje (painel): esse;
   *  - ROBOS_CALCULO=taxa com dados dos últimos 30 min: a taxa real de derivação, pela meta do status;
   *  - senão (medindo ou ROBOS_CALCULO=fixo): o de agora (ajuste) vezes o peso do status da URA
   *    (calma = ROBOS_FATOR_CALMA, agressiva = ROBOS_FATOR_AGRESSIVA). Pelo menos 1.
   */
  porLivreComStatus(agora = Date.now()) {
    const calculo = this.calculoDosRobos(agora);
    if (calculo?.fonte === 'taxa') return calculo.porLivre;
    const base = this.porLivreAgora(agora);
    if (calculo?.fonte === 'manual') return base;
    const status = this.statusAtualDaUra();
    const fator = status === 'calma' ? (this.cfg.robosFatorCalma ?? 1) : status === 'agressiva' ? (this.cfg.robosFatorAgressiva ?? 1) : 1;
    const comPeso = Math.max(1, Math.round(base * fator));
    // [NOVO] Medindo a taxa: a conta de antes, presa entre o piso e o teto do status.
    return calculo ? Math.min(calculo.max, Math.max(calculo.min, comPeso)) : comPeso;
  }

  /** [NOVO] Teto com 1 livre: o do status na conta pela taxa; ROBOS_MAX_COM_1_LIVRE no fixo. */
  maxComUmLivreAgora(agora = Date.now()) {
    return this.calculoDosRobos(agora)?.max ?? this.cfg.robosMaxComUmLivre;
  }

  /** [NOVO] Com quantos livres o status liga todos os robôs (calma: 2). 0 = nunca (fixo ou à mão). */
  todosComLivresAgora(agora = Date.now()) {
    const calculo = this.calculoDosRobos(agora);
    return calculo && calculo.fonte !== 'manual' ? calculo.todosComLivres : 0;
  }

  /** O "por livre" foi escolhido à mão no painel hoje? (vale até virar o dia) */
  ajustadoAMaoHoje(agora) {
    const em = this.ajuste?.ajustadoAMaoEm;
    if (!(em > 0)) return false;
    const fuso = this.cfg.fusoHorario ?? 'America/Sao_Paulo';
    return dataLocal(fuso, new Date(em)) === dataLocal(fuso, new Date(agora));
  }

  /**
   * [NOVO] A conta dos robôs pela taxa real (null com ROBOS_CALCULO=fixo).
   * fonte: 'taxa' (vale), 'medindo' (poucos dados: conta de antes) ou 'manual' (escolhido à mão hoje).
   */
  calculoDosRobos(agora = Date.now()) {
    if (this.cfg.robosCalculo !== 'taxa') return null;
    const cfg = this.cfg.robosTaxa ?? CALCULO_PADRAO;
    const desde = agora - cfg.janelaMs;
    const derivacoes = this.derivacoesRecentes.filter((t) => t >= desde && t <= agora).length;
    const minutos = roboMinutos(this.amostrasRobos.filter((a) => a.ts >= desde && a.ts <= agora));
    const status = this.statusAtualDaUra() ?? 'medindo';
    const conta = robosPorLivrePelaTaxa({ derivacoes, roboMinutos: minutos, status, cfg });
    const fonte = this.ajustadoAMaoHoje(agora) ? 'manual' : conta.fonte;
    return { ...conta, fonte, status, derivacoes30: derivacoes, roboMinutos30: minutos };
  }

  /** Robôs por livre agora (ajustado pelos callbacks, pela URA passiva ou à mão). */
  porLivreAgora(agora = Date.now()) {
    return this.ajuste ? this.ajuste.atual(agora) : this.cfg.robosPorLivre;
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

  // ───────────────────────── [NOVO] Mexer à mão pelo painel ─────────────────────────

  /** Onde a supervisão travou o ramal à mão (null = o rodízio decide). @returns {'ativo'|'ura'|null} */
  travadoEm(ramal) {
    return this.travas?.onde(ramal) ?? null;
  }

  /** Humano que o painel pode mexer: na lista da URA ou num grupo do Ativo. @returns {'ura'|'ativo'|null} */
  ondeEsta(ramal) {
    const r = String(ramal);
    if (this.ramaisRobos.map(String).includes(r)) return null;
    if (this.ramaisUra.has(r)) return ehOperadorVirtual(this.statusUra.get(r)?.detalhe?.nome) ? null : 'ura';
    return this.gruposAtivos.some((g) => (g.ramaisOperadores || []).map(String).includes(r)) ? 'ativo' : null;
  }

  /** Grupo do Ativo em que o ramal está agora (null = não está no Ativo). */
  grupoNoAtivo(ramal) {
    const g = this.gruposAtivos.find((x) => (x.ramaisOperadores || []).map(String).includes(String(ramal)));
    return g ? g.idGrupoUsuario : null;
  }

  /**
   * POST /operadores/mover: a supervisão manda para o Ativo ou traz para a URA, e o
   * ramal fica travado lá (o rodízio e o roteador respeitam) até liberarem ou virar o dia.
   * @returns {Promise<{ ok: boolean, erro?: string, simulado?: boolean }>}
   */
  async moverManual(ramal, para, por = null) {
    const r = String(ramal);
    const onde = this.ondeEsta(r);
    if (!onde) return { ok: false, erro: `ramal ${r} não é um humano da URA nem do Ativo` };
    if (onde === para) {
      await this.travas?.travar(r, para, por);
      this.log.aviso(`Ramal ${r} travado no ${para === 'ura' ? 'grupo da URA' : 'Ativo'} pelo painel${por ? ` (${por})` : ''}.`);
      return { ok: true, jaEstava: true };
    }
    // Trava antes de mover: o ciclo seguinte não desfaz no meio (nem o roteador, que lê o mesmo arquivo).
    await this.travas?.travar(r, para, por);
    let ok;
    let erro;
    if (para === 'ativo') ({ ok, erro } = await this.moverParaAtivo(r, `mexido à mão pelo painel${por ? ` (${por})` : ''}`));
    else {
      ok = await this.moverParaUra(r, this.grupoNoAtivo(r));
      if (!ok) erro = 'a transferência não foi aceita agora';
    }
    if (!ok) {
      await this.travas?.liberar(r);
      return { ok: false, erro };
    }
    this.log.aviso(`Ramal ${r} → ${para === 'ura' ? 'URA' : 'Ativo'} à mão pelo painel${por ? ` (${por})` : ''}: o rodízio não mexe nele até liberarem.`);
    this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após mexer à mão: ${e.message}`));
    return { ok: true, simulado: Boolean(this.cfg.dryRun) };
  }

  /** POST /operadores/liberar: o rodízio volta a decidir por ele. @returns {Promise<boolean>} true se estava travado */
  async liberarTrava(ramal, por = null) {
    const liberou = await this.travas?.liberar(String(ramal));
    if (liberou) this.log.aviso(`Ramal ${ramal} liberado para o rodízio pelo painel${por ? ` (${por})` : ''}.`);
    return Boolean(liberou);
  }

  /** Para o painel: quem está no Ativo agora (para "Trazer para a URA"). */
  noAtivoAgora() {
    const nomeDe = (ramal) => {
      try {
        return this.diretorio?.operadorPorRamal?.(ramal)?.nome || null;
      } catch {
        return null; // diretório ainda não carregado
      }
    };
    const robos = new Set(this.ramaisRobos.map(String));
    return this.gruposAtivos.flatMap((g) => (g.ramaisOperadores || []).map(String)
      .filter((ramal) => !robos.has(ramal) && !this.ramaisUra.has(ramal))
      .map((ramal) => ({ ramal, nome: nomeDe(ramal), grupo: g.idGrupoUsuario, grupoDesc: g.grupoUsuarioDesc ?? null,
        travado: this.travadoEm(ramal) })));
  }

  // ───────────────────────────── Modo manual ─────────────────────────────

  emModoManual(agora = Date.now()) {
    if (!this.manualAte || agora < this.manualAte) return this.manualAte > 0;
    this.manualAte = 0;
    this.log.info('Fim do modo manual: o BenURA volta a comandar os robôs.');
    return false;
  }

  // ───────────────────────────── URA cheia ─────────────────────────────

  /** Ligada hoje? */
  emUraCheia(agora = Date.now()) {
    return Boolean(this.uraCheia?.ativa(new Date(agora)));
  }

  /** POST /ura/cheia. @returns {{ ligada: boolean, desde: string|null, mudou: boolean }} */
  ligarUraCheia() {
    if (this.retencao?.ativa) throw new Error('Rodízio pausado (todos no Ativo): retome o rodízio da URA antes de ligar a URA cheia.');
    const mudou = this.uraCheia.ligar();
    return { ...this.uraCheia.resumo(), mudou };
  }

  /** DELETE /ura/cheia. */
  desligarUraCheia() {
    const mudou = this.uraCheia.desligar();
    this.emUraCheia();
    return { ...this.uraCheia.resumo(), mudou };
  }

  /** A supervisão assume os robôs pelo painel por `minutos`; o BenURA não liga nem desliga nenhum. */
  /**
   * Botão "Desligar automação" do painel: o rodízio para de mover gente e de
   * decidir robôs, e desliga os robôs. Sem `derrubar`, só os parados (os em
   * ligação terminam a chamada; o painel chama de novo até sobrar nenhum); com
   * `derrubar`, todos. Em seguida o painel para os serviços (pm2 stop).
   * @returns {Promise<{ ligados: number|null }>}
   */
  async encerrarRobosParaDesligar({ derrubar = false } = {}) {
    if (!this.desligandoAutomacao) this.log.aviso('Automação sendo desligada pelo painel: o rodízio parou de mover operadores e está desligando os robôs.');
    this.desligandoAutomacao = true;
    if (this.ramaisRobos.length) await this.robos.sincronizar(this.ramaisRobos);
    const motivo = 'automação desligada pelo painel';
    const ligados = [...(this.robos.ligados || [])];
    if (ligados.length && derrubar) await this.robos.desligar(ligados, motivo);
    else if (ligados.length) await this.robos.encerrarSemDerrubar(motivo);
    return { ligados: this.robos.ligados ? this.robos.ligados.size : null };
  }

  assumirRobosManualmente(minutos) {
    this.manualAte = Date.now() + minutos * 60_000;
    this.log.aviso(`Modo manual por ${minutos} min: o BenURA não mexe nos robôs até ${new Date(this.manualAte).toISOString()}.`);
    return this.manualAte;
  }

  devolverRobosAoBenura() {
    this.manualAte = 0;
    this.log.info('Modo manual encerrado: o BenURA volta a comandar os robôs.');
  }

  /** Quem está na URA e como está (painel da supervisão). Só dados do operador. */
  uraAgora() {
    const robos = new Set(this.ramaisRobos.map(String));
    return [...this.ramaisUra].map((ramal) => {
      const s = this.statusUra.get(ramal);
      return {
        ramal,
        nome: s?.detalhe?.nome ?? null,
        classe: s?.classe ?? null,
        livreDesde: s?.livreDesde ? new Date(s.livreDesde).toISOString() : null,
        emCarencia: Boolean(s?.emCarencia),
        fixo: this.permanentes.has(String(ramal)),
        // [NOVO] painel do receptivo: virtual (robô na lista), tipo da pausa e desde quando no status
        virtual: robos.has(String(ramal)) || ehOperadorVirtual(s?.detalhe?.nome),
        pausa: s?.classe === Classe.OUTRO ? s?.detalhe?.pausa ?? null : null,
        statusDesde: desdeDoStatus(s),
        travado: this.travadoEm(ramal),
      };
    });
  }

  resumo() {
    return {
      robos: {
        ...this.robos.resumo(),
        total: this.ramaisRobos.length,
        porLivre: this.porLivreAgora(),
        // [NOVO] o que vale no automático, com o peso do status da URA
        porLivreComStatus: this.porLivreComStatus(),
        maxComUmLivre: this.maxComUmLivreAgora() || null,
        // [NOVO] a conta pela taxa real (null com ROBOS_CALCULO=fixo)
        calculo: this.calculoDosRobos(),
        modo: this.modoDosRobos(),
        // [NOVO] quem escolheu o modo no painel (sem escolha: o ROBOS_MODO do .env)
        modoDesde: this.modoRobos?.resumo().desde ?? null,
        modoPor: this.modoRobos?.resumo().por ?? null,
        manualAte: this.manualAte ? new Date(this.manualAte).toISOString() : null,
      },
      // [NOVO] contas operacionais de supervisores (não ficam na URA)
      contasSupervisores: this.contasSupervisores?.lista() ?? [],
      // [NOVO] URA calma: de URA_CALMA_LIVRES_MIN a URA_CALMA_LIVRES_MAX livres
      calmaLivres: this.resumoDaCalma(),
      intervaloUraMs: this.intervaloUraMs(),
      ultimoLivreSaindo: this.ultimoSaindo ? { ramal: this.ultimoSaindo.ramal, desde: new Date(this.ultimoSaindo.desde).toISOString() } : null,
      ultimoWebhook: this.ultimoWebhookEm ? new Date(this.ultimoWebhookEm).toISOString() : null,
      uraLogadosEmOutroGrupo: [...this.logadosEmOutroGrupo.values()],
      elegiveisUra: this.elegiveis ? this.elegiveis.resumo() : { disponivel: false, total: null, desligado: true },
      fixosPermanentes: [...this.permanentes],
      uraAgora: this.uraAgora(),
      // [NOVO] quem está no Ativo agora (o painel oferece "Trazer para a URA")
      noAtivo: this.noAtivoAgora(),
      uraCheia: this.uraCheia ? this.uraCheia.resumo() : { ligada: false, desde: null },
      panico: {
        modo: this.emModoPanico(),
        ...(this.panico ? this.panico.resumo() : { ligado: false, desde: null }),
        ativoAgora: this.panicoDesde ? new Date(this.panicoDesde).toISOString() : null,
        motivo: this.panicoMotivo,
        tipo: this.panicoTipo,
        antesDeSairMs: this.cfg.panicoAntesDeSairMs ?? 0,
        fixoOciosoMs: this.cfg.panicoFixoOciosoMs ?? null,
        fixoReduzirMs: this.cfg.panicoFixoReduzirMs ?? null,
        uraPassiva: this.uraPassivaResumo(), // a página /ura antiga
        passivaAgora: this.uraPassivaAgora(),
      },
      termometro: this.termometro ? this.termometro.resumo() : null,
      // [NOVO] status da URA (manual ou automático), o mesmo para todos no painel
      statusUra: this.statusDaUra ? this.statusDaUra.resumo(this.termometro) : null,
      // [NOVO] quantos o "Alocar Todos no Ativo" moveria e quantos fixos ficam (o filtro é daqui)
      transferenciaUraAtivo: (() => {
        const { elegiveis, fixos } = this.candidatosAoAtivo();
        return { elegiveis: elegiveis.length, fixos: fixos.length, uraCheiaLigada: this.emUraCheia() };
      })(),
      // [NOVO] "Alocar Todos no Ativo" segura todos lá até retomar; quantos voltariam ao retomar
      retencaoAtivo: { ...(this.retencao ? this.retencao.resumo() : { ativa: false, desde: null, por: null }), elegiveisParaVoltar: this.elegiveisNoAtivo()?.length ?? null },
      // [NOVO] limites das pausas (src/config/pausas.js), para o painel marcar a pausa excedida
      pausasLimitesMin: LIMITES_PAUSA,
      relatorio: this.estatisticas ? this.estatisticas.resumo() : null,
      ajusteRobos: this.ajuste ? this.ajuste.resumo() : null,
      dryRun: Boolean(this.cfg.dryRun),
      desligandoAutomacao: this.desligandoAutomacao,
      ramaisUra: [...this.ramaisUra],
      movidos: this.movidos,
      gruposAtivos: this.gruposAtivos.map((g) => g.idGrupoUsuario),
    };
  }
}

module.exports = { RodizioService };
