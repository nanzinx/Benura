'use strict';
/**
 * Rodízio Ativo ↔ URA + controle dos robôs da URA.
 *
 * Três ciclos independentes, cada um agendado sem sobreposição (app.js):
 *
 *   atualizarGrupos()  ~30 s  lê os grupos da Argus: quem está na URA, no Ativo e quais são os robôs
 *   cicloAtivo()       ~5 s   quem é elegível (meta de ontem, venda hoje ou fixo), atendeu
 *                             no Ativo e ficou livre → URA. Na URA cheia (pedido da
 *                             supervisão), todos do Ativo sobem; quem voltou por ocioso
 *                             sobe ao atender no Ativo; a regra do ocioso continua valendo.
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
  decidirRobos, alvoDeRobos, livresUteis, reconciliarMovidos, VALIDADE_STATUS_MS,
} = require('../domain/rodizio');
const { TipoGrupo } = require('../integrations/argus/argus.client');
const { alinharLogin } = require('../integrations/argus/alinhar-login');
const { raioXDoCallback, horaNoFuso } = require('../domain/raio-x-callback');
const { mapearComLimite } = require('../utils/concorrencia');
const { limitesMin: LIMITES_PAUSA } = require('../config/pausas');

/** Quanto tempo de fotos da URA o raio-x dos callbacks guarda (o relatório chega com até alguns minutos de atraso). */
const FOTOS_MS = 15 * 60_000;
/** No máximo uma tentativa de relogar o mesmo ramal nesse intervalo (fora as logo após mover). */
const INTERVALO_ALINHAMENTO_MS = 60_000;

/** Depois de quanto tempo sem webhook avisar (e de quanto em quanto repetir). */
const AVISO_SEM_WEBHOOK_MS = 60 * 60_000;

/** [NOVO] Operador virtual (robô) pelo nome da Argus: "OPER VIRT…" (ex.: "Oper Virtual 7"). */
const ehOperadorVirtual = (nome) => /^oper\s*virt/i.test(String(nome || '').trim());

/** [NOVO] Desde quando o operador está no status: livre e offline pelo que o rodízio mediu; o resto pelo tempoStatus da Argus. */
function desdeDoStatus(s) {
  const desde = s?.classe === Classe.LIVRE ? s.livreDesde : s?.classe === Classe.OFFLINE ? s.offlineDesde : s?.detalhe?.statusDesde;
  return desde != null ? new Date(desde).toISOString() : null;
}

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
   */
  constructor({
    client, transferencias, robos, repositorio, cfg, logger, diretorio = null, elegiveis = null, uraCheia = null, ajuste = null,
    panico = null, fixos = null, termometro = null, statusDaUra = null, estatisticas = null,
  }) {
    Object.assign(this, {
      client, transferencias, robos, repositorio, cfg, log: logger, diretorio, elegiveis, uraCheia, ajuste, panico, fixos,
      termometro, statusDaUra, estatisticas,
    });
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
    /** ramais com transferência em andamento */
    this.emTransferencia = new Set();
    /**
     * URA cheia: quem não é levado de novo nesta ativação — voltou ao Ativo por
     * ocioso (sobe ao atender lá) ou, em DRY_RUN, já teve a ida simulada.
     */
    this.naoLevarNaUraCheia = new Set();
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
    const cheia = this.emUraCheia();
    if (cheia) await this.levarTodosParaUra();
    else await this.elegiveis?.atualizar();
    // Na URA cheia, qualquer um que atender no Ativo volta (sem olhar elegíveis).
    const alvos = this.operadoresDoAtivo().filter(({ ramal }) => cheia || this.podeIrParaUra(ramal));
    await mapearComLimite(alvos, this.cfg.concorrencia, (alvo) => this.verificarOperadorDoAtivo(alvo));
  }

  /** Quem está no Ativo e não está sendo mexido agora. */
  operadoresDoAtivo() {
    return this.gruposAtivos.flatMap((g) => (g.ramaisOperadores || [])
      .map((ramal) => ({ ramal: String(ramal), grupo: g.idGrupoUsuario })))
      .filter(({ ramal }) => !this.movidos[ramal] && !this.ramaisUra.has(ramal) && !this.emTransferencia.has(ramal)
        && !this.alinhandoLogin.has(ramal));
  }

  /**
   * URA cheia: todos do Ativo vão para a URA, atendendo ou não (a telefonia
   * troca quando ficam livres), inclusive quem a carga das 08:00 ou alguém à
   * mão mandar para o Ativo depois. Só quem voltou por ocioso fica no Ativo
   * até atender lá (senão iria e voltaria a cada TEMPO_MIN).
   */
  async levarTodosParaUra() {
    const alvos = this.operadoresDoAtivo().filter(({ ramal }) => !this.naoLevarNaUraCheia.has(ramal));
    if (!alvos.length) return;
    this.log.info(`URA cheia: levando ${alvos.length} operador(es) do Ativo para a URA.`);
    await mapearComLimite(alvos, this.cfg.concorrencia, async ({ ramal, grupo }) => {
      // Em DRY_RUN ninguém sai do Ativo de verdade: simula uma vez só.
      if (await this.moverParaUra(ramal, grupo) && this.cfg.dryRun) this.naoLevarNaUraCheia.add(ramal);
    });
  }

  /** Só quem é elegível (meta de ontem, venda hoje ou fixo) sobe; os demais nem são lidos. */
  podeIrParaUra(ramal) {
    return !this.elegiveis || this.elegiveis.permite(ramal);
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
    const ociosos = ramais.filter((ramal) => this.deveDevolver(ramal, agora));
    if (!this.emModoPanico()) this.prepararSaidaDoUltimoLivre(ramais, agora);
    await this.avaliarRobos();
    this.registrarFoto(Date.now());
    this.amostrarDia(Date.now());
    if (!this.emModoPanico()) this.verificarPassividade(agora);

    this.avisarSeSemWebhook();
    await mapearComLimite(ociosos, this.cfg.concorrencia, (ramal) => this.devolverAoAtivo(ramal));
  }

  /**
   * O último livre sai no horário (regra do ocioso). Sem ele, o alvo vira 0 e um
   * robô em ligação que derivar não acha ninguém (callback). Por isso, quando o
   * último livre está a PREPARAR_SAIDA_ULTIMO_LIVRE_MS de sair, os robôs param de
   * discar e os que estão em ligação terminam enquanto ele ainda está na URA.
   * Se ele atender ou aparecer outro livre, os robôs voltam.
   */
  prepararSaidaDoUltimoLivre(ramais, agora) {
    // No máximo metade do TEMPO_MIN: senão, com um livre só, os robôs nunca discariam.
    const antecedenciaMs = Math.min(this.cfg.prepararSaidaMs ?? 0, (this.cfg.tempoNaUraMs ?? Infinity) / 2);
    const saindo = antecedenciaMs > 0 ? ramais.filter((ramal) => this.deveDevolver(ramal, agora + antecedenciaMs)) : [];
    const ramal = ultimoLivreQueSai({ saindo, ramaisUra: ramais, status: this.statusUra });
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
    const classe = this.conferirGrupoLogado(ramal, lido.classe, lido.status) ? Classe.OUTRO : lido.classe;

    // Um "livre" lido logo depois do webhook de atendimento é atraso do polling: ignora.
    const anterior = this.statusUra.get(ramal);
    const dentroDaCarencia = anterior?.doWebhook && Date.now() - anterior.ts < this.cfg.carenciaWebhookMs;
    if (classe === Classe.LIVRE && dentroDaCarencia) return;

    // Tempo ocioso: conta desde que ficou Livre; qualquer outro status zera.
    const agora = Date.now();
    const livreDesde = classe === Classe.LIVRE ? (anterior?.livreDesde ?? agora) : undefined;
    const offlineDesde = classe === Classe.OFFLINE ? (anterior?.offlineDesde ?? agora) : undefined;
    const emCarencia = agora - (this.trocouEm.get(ramal) ?? -Infinity) < (this.cfg.carenciaTrocaMs ?? 0);
    const detalhe = lido.status ? this.detalheDoStatus(lido.status, agora) : null;
    if (classe === Classe.ATENDIMENTO && anterior?.classe !== Classe.ATENDIMENTO) {
      this.registrarDerivacao(agora, anterior?.livreDesde != null ? agora - anterior.livreDesde : null);
    }
    this.statusUra.set(ramal, { classe, ts: agora, livreDesde, offlineDesde, emCarencia, detalhe });
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

  deveDevolver(ramal, agora) {
    const info = this.statusUra.get(ramal);
    if (!info || this.emTransferencia.has(ramal)) return false;
    // Fixos ficam na URA de vez: o ocioso não vale (deslogado segue a regra normal).
    if (this.permanentes.has(String(ramal)) && info.classe !== Classe.OFFLINE) return false;
    return deveVoltarAoAtivo({
      classe: info.classe, livreDesde: info.livreDesde, agora, ociosoMs: this.cfg.tempoNaUraMs, movido: this.movidos[ramal],
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
    await this.moverParaAtivo(ramal);
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
    if (this.emUraCheia()) this.naoLevarNaUraCheia.add(ramal); // sobe de novo ao atender no Ativo
    this.vigiarNoAtivo(ramal, destino);
    this.salvar();
    this.log.info(`URA→ATIVO ramal=${ramal} destino=${destino} (motivo: ${motivo ?? motivoDaVolta({ ...info, agora: Date.now() })})`);
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
        porLivre: this.porLivreAgora(agora),
        maximo: this.cfg.robosMaximo,
        maxComUmLivre: this.cfg.robosMaxComUmLivre,
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
    return this.cfg.robosModo === 'panico';
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
  registrarDerivacao(agora, esperaMs = null) {
    this.ultimoAtendimentoUraEm = agora;
    this.termometro?.registrarDerivacao(agora, esperaMs);
    this.estatisticas?.registrarDerivacao(agora);
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
    this.estatisticas?.amostrar(agora, { ...amostra, panico: this.panicoTipo, termometro: this.statusAtualDaUra() ?? termometro, pausas });
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
    this.estatisticas?.registrarEncerramento(agora, encerramento);
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
    else this.registrarDerivacao(agora, anterior?.livreDesde != null ? agora - anterior.livreDesde : null);
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
   * fixos voltam ao Ativo (cada um ao seu grupo de volta, como na regra do ocioso).
   * Com a URA cheia ligada, desliga antes (senão o rodízio traria todos de volta).
   * Respeita o DRY_RUN (transferencias.js).
   * @returns {Promise<{ movidos: string[], ignorados: Array<{ ramal, motivo }>, erros: Array<{ ramal, erro }>, uraCheiaDesligada: boolean }>}
   */
  async transferirUraParaAtivo(por = null) {
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
      const r = await this.moverParaAtivo(ramal, 'alocar todos no Ativo');
      if (r.ok) movidos.push(ramal);
      else erros.push({ ramal, nome, erro: r.erro });
    }
    this.log.aviso(`Alocar todos no Ativo${por ? ` (${por})` : ''}: ${movidos.length} movido(s), ${ignorados.length} fixo(s) mantido(s), `
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

  // ───────────────────────────── Modo manual ─────────────────────────────

  emModoManual(agora = Date.now()) {
    if (!this.manualAte || agora < this.manualAte) return this.manualAte > 0;
    this.manualAte = 0;
    this.log.info('Fim do modo manual: o BenURA volta a comandar os robôs.');
    return false;
  }

  // ───────────────────────────── URA cheia ─────────────────────────────

  /** Ligada hoje? (desligada, esquece quem voltou por ocioso: a próxima ativação leva todos de novo) */
  emUraCheia(agora = Date.now()) {
    const ligada = Boolean(this.uraCheia?.ativa(new Date(agora)));
    if (!ligada) this.naoLevarNaUraCheia.clear();
    return ligada;
  }

  /** POST /ura/cheia. @returns {{ ligada: boolean, desde: string|null, mudou: boolean }} */
  ligarUraCheia() {
    const mudou = this.uraCheia.ligar();
    if (mudou) this.naoLevarNaUraCheia.clear();
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
      };
    });
  }

  resumo() {
    return {
      robos: {
        ...this.robos.resumo(),
        total: this.ramaisRobos.length,
        porLivre: this.porLivreAgora(),
        maxComUmLivre: this.cfg.robosMaxComUmLivre || null,
        modo: this.emModoPanico() ? 'panico' : 'automatico',
        manualAte: this.manualAte ? new Date(this.manualAte).toISOString() : null,
      },
      intervaloUraMs: this.intervaloUraMs(),
      ultimoLivreSaindo: this.ultimoSaindo ? { ramal: this.ultimoSaindo.ramal, desde: new Date(this.ultimoSaindo.desde).toISOString() } : null,
      ultimoWebhook: this.ultimoWebhookEm ? new Date(this.ultimoWebhookEm).toISOString() : null,
      uraLogadosEmOutroGrupo: [...this.logadosEmOutroGrupo.values()],
      elegiveisUra: this.elegiveis ? this.elegiveis.resumo() : { disponivel: false, total: null, desligado: true },
      fixosPermanentes: [...this.permanentes],
      uraAgora: this.uraAgora(),
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
