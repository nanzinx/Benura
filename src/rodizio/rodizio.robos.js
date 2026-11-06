'use strict';
/**
 * [NOVO] Os robôs da URA no RodizioService (veio de rodizio.service.js, sem mudar nada): decidir e aplicar
 * os robôs, pânico, modo, ajuste e taxa, último livre saindo, raio-x dos callbacks, modo manual e o
 * encerrar da automação. Aplicado em RodizioService.prototype: `this` é o próprio serviço.
 * As regras de decisão ficam em domain/rodizio.js e domain/robos-por-taxa.js.
 */

const { Classe, AcaoRobos, ultimoLivreQueSai, decidirRobos, alvoDeRobos, livresUteis, VALIDADE_STATUS_MS } = require('../domain/rodizio');
const { raioXDoCallback, horaNoFuso, Conclusao } = require('../domain/raio-x-callback');
const { robosPorLivrePelaTaxa, roboMinutos, CALCULO_PADRAO } = require('../domain/robos-por-taxa');
const { dataLocal } = require('../utils/datas');

/** Quanto tempo de fotos da URA o raio-x dos callbacks guarda (o relatório chega com até alguns minutos de atraso). */
const FOTOS_MS = 15 * 60_000;

const metodosDosRobos = {
  /** Confere na Argus quais robôs estão logados (ex.: alguém religou à mão). Não disputa com uma avaliação em curso. */
  async sincronizarRobos() {
    if (this.avaliandoRobos || !this.ramaisRobos.length) return;
    this.avaliandoRobos = true;
    try {
      await this.robos.sincronizar(this.ramaisRobos);
    } finally {
      this.avaliandoRobos = false;
    }
  },

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
  },

  /** Último livre prestes a sair que continua livre (se atendeu, os robôs voltam). */
  ultimoLivreSaindo() {
    const ramal = this.ultimoSaindo?.ramal;
    return ramal && this.statusUra.get(ramal)?.classe === Classe.LIVRE ? ramal : null;
  },

  /**
   * Decide e aplica a ação sobre os robôs. Chamadas concorrentes (ciclo da URA
   * e webhook) não se sobrepõem: quem chega durante uma avaliação pede outra rodada.
   */
  async avaliarRobos() {
    if (this.papel === 'pessoas') { // [NOVO] quem decide é o de robôs; a linha do tempo do painel é daqui
      await this.enviarAosRobos();
      return this.registrarLinhaDoTempo();
    }
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
  },

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
    const { acao, alvo, motivo, livres, excesso, deUmaVez } = decidirRobos({
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
        comUmLivre: this.comUmLivreAgora(agora),
        statusDaUra: this.statusAtualDaUra(),
        // Com poll lento, o status "envelhece" entre ciclos: não pode virar "sem visibilidade".
        validadeStatusMs: Math.max(VALIDADE_STATUS_MS, this.cfg.pollUraMs * 2 + 1000),
      },
    });
    this.registrarMudancaDeLivres(livres, alvo);
    this.ultimosLivres = livres;
    // Desde quando há robôs demais com gente livre (a redução parcial espera isso se confirmar).
    this.excessoDesde = excesso && acao !== AcaoRobos.DESLIGAR ? (this.excessoDesde ?? agora) : null;
    if (acao === AcaoRobos.DESLIGAR) await this.robos.reduzir(this.ramaisRobos, alvo, motivo);
    if (acao === AcaoRobos.RELIGAR) await this.robos.aumentar(this.ramaisRobos, alvo, motivo, { deUmaVez: Boolean(deUmaVez) });
  },

  /** ROBOS_MODO=panico: a supervisão liga os robôs; o BenURA só os desliga no pânico. */
  emModoPanico() {
    return this.modoDosRobos() === 'panico';
  },

  /** [NOVO] Modo dos robôs agora: o escolhido no painel ou, sem escolha, o ROBOS_MODO do .env. */
  modoDosRobos() {
    return this.modoRobos?.modo ?? this.cfg.robosModo;
  },

  /** [NOVO] "Desligados" no painel: o BenURA mantém os robôs desligados (o resto da automação segue). */
  robosDesligadosPeloPainel() {
    return this.modoDosRobos() === 'desligados';
  },

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
  },

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
  },

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
  },

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
  },

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
  },

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
  },

  encerrarPanico(livres) {
    if (!this.panicoDesde) return;
    this.panicoDesde = null;
    this.panicoMotivo = null;
    this.panicoTipo = null;
    const porque = this.panico?.ligado() ? `${livres} livre(s) na URA` : 'interruptor desligado';
    this.log.info(`PÂNICO encerrado (${porque}): a supervisão pode religar os robôs pelo painel.`);
  },

  /** [NOVO] Os robôs seguem a configuração? (automático, sem robôs por livre à mão) No de pessoas, pelo que o de robôs disse. */
  robosNaConfig(agora = Date.now()) {
    if (this.papel === 'pessoas') return this.estadoDosRobos?.modo === 'automatico' && this.estadoDosRobos?.fonte !== 'manual';
    return this.modoDosRobos() === 'automatico' && this.calculoDosRobos(agora)?.fonte !== 'manual';
  },

  /**
   * Linha do tempo da URA: uma linha a cada mudança no número de livres, para
   * cruzar com a hora de cada callback (npm run diagnostico:callbacks).
   */
  registrarMudancaDeLivres(livres, alvo) {
    // [NOVO] Com os robôs num serviço próprio, a linha é do de pessoas (no rodizio.txt, que o painel lê).
    if (this.papel === 'robos') return;
    this.escreverLinhaDoTempo(livres, this.robos.situacao(this.ramaisRobos.length).ligados, alvo);
  },

  /**
   * [NOVO] No de pessoas: os livres contados aqui e os robôs ligados pelo que o serviço dos robôs
   * respondeu. Com ele sem responder, "?" (o gráfico mostra o vão, não 0).
   */
  registrarLinhaDoTempo(agora = Date.now()) {
    const { livres } = alvoDeRobos({
      ramaisUra: [...this.ramaisUra],
      status: this.statusUra,
      agora,
      total: this.ramaisRobos.length,
      cfg: { porLivre: 1, validadeStatusMs: Math.max(VALIDADE_STATUS_MS, (this.cfg.pollUraMs ?? 0) * 2 + 1000) },
    });
    const ligados = this.robosSemResposta ? null : this.robos.situacao(this.ramaisRobos.length).ligados;
    this.escreverLinhaDoTempo(livres, ligados, null);
  },

  /** Uma linha quando mudam os livres ou os robôs ligados (antes, só os livres: o gráfico não via os robôs). */
  escreverLinhaDoTempo(livres, ligados, alvo) {
    const anterior = this.ultimaLinhaDoTempo;
    if (anterior && anterior.livres === livres && anterior.ligados === (ligados ?? null)) return;
    this.ultimaLinhaDoTempo = { livres, ligados: ligados ?? null };
    const humanos = [...this.ramaisUra].filter((r) => this.statusUra.has(r) && this.statusUra.get(r).classe !== Classe.OFFLINE).length;
    // "Antes": o da última linha. Sem ela, no de pessoas "?" (o ultimosLivres de lá é o que o serviço dos
    // robôs respondeu, não uma linha anterior); no "tudo", o ultimosLivres, como sempre.
    const antes = anterior ? anterior.livres : this.papel === 'pessoas' ? null : this.ultimosLivres;
    this.log.info(`URA: livres ${antes ?? '?'}→${livres} | humanos ${humanos} | robôs ligados ${ligados ?? '?'}${alvo == null ? '' : ` (alvo ${alvo})`}`
      + `${this.descreverLivres()}`);
  },

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
  },

  /**
   * O cliente pediu um humano e desistiu na fila (webhook de encerramento de URA).
   * Registra com a situação da URA naquele instante e, com o ajuste ligado,
   * baixa um degrau de robôs por livre e reavalia os robôs na hora.
   * @param {{ motivo: string, chave: string|null }} callback
   * @param {string} [situacao] - padrão: a URA agora (webhook, na hora do callback)
   */
  registrarCallback(callback, situacao = this.situacaoAgora(), ts = Date.now()) {
    this.termometro?.registrarCallback(ts);
    this.ajustarPorCallback(callback, situacao, ts);
  },

  /** O callback pesa nos robôs por livre (o ajuste). [NOVO] No de pessoas, vai ao de robôs. */
  ajustarPorCallback(callback, situacao, ts) {
    if (this.papel === 'pessoas') {
      this.filaParaOutroLado.por({ tipo: 'callback', ts, callback: { motivo: callback.motivo, chave: callback.chave ?? null }, situacao });
      return;
    }
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
  },

  situacaoAgora() {
    const { ligados } = this.robos.situacao(this.ramaisRobos.length);
    return `${this.ultimosLivres ?? '?'} livre(s) na URA e ${ligados ?? '?'} robô(s) ligado(s)${this.descreverLivres()}`;
  },

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
  },

  /** [NOVO] Quantos robôs estavam ligados agora (integra os robô-minutos da taxa). */
  amostrarRobos(agora, ligados) {
    this.amostrasRobos.push({ ts: agora, ligados });
    this.descartarAntigas(agora);
  },

  descartarAntigas(agora) {
    const desde = agora - this.janelaDaTaxa();
    while (this.derivacoesRecentes.length && this.derivacoesRecentes[0] < desde) this.derivacoesRecentes.shift();
    while (this.amostrasRobos.length && this.amostrasRobos[0].ts < desde) this.amostrasRobos.shift();
  },

  janelaDaTaxa() {
    return (this.cfg.robosTaxa ?? CALCULO_PADRAO).janelaMs;
  },

  /** Houve robô ligado em alguma foto de `janelaMs` para cá? (o vigia de callbacks só lê nesse caso) */
  teveRoboLigado(agora, janelaMs) {
    return this.fotos.some((f) => f.ts >= agora - janelaMs && f.robos.ligados > 0)
      || Boolean(this.robos.situacao(this.ramaisRobos.length).ligados);
  },

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
    // [NOVO] o mapa de risco segue a mesma conclusão (sem histórico do BenURA, não dá para dizer)
    if (raioX.conclusao && raioX.conclusao !== Conclusao.SEM_HISTORICO) this.estatisticas?.corrigirCallbackNoMapa?.(chave, raioX.conclusao === Conclusao.INVISIVEL);
    const quando = inicio == null ? '' : ` às ${horaNoFuso(inicio, fuso)}`;
    this.registrarCallback({ motivo, chave }, `relatório da Argus${quando}`, inicio ?? Date.now());
  },

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
  },

  /** Vigia de clientes de risco (interruptor ligado): para de discar sem derrubar quem está em ligação. */
  async desligarPorClienteDeRisco(motivo) {
    if (this.emModoManual()) return undefined;
    return this.robos.encerrarSemDerrubar(motivo);
  },

  /** POST/DELETE /panico. @returns {{ ligado: boolean, desde: string|null, mudou: boolean }} */
  definirPanico(ligado) {
    const mudou = this.panico.definir(ligado);
    this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após mudar o pânico: ${e.message}`));
    return { ...this.panico.resumo(), mudou };
  },

  /** POST /robos/por-livre: a supervisão ajusta na hora. @returns {object} resumo do ajuste */
  definirRobosPorLivre(valor) {
    this.ajuste.definir(valor);
    this.avaliarRobos().catch((e) => this.log.erro(`Falha ao avaliar robôs após o ajuste manual: ${e.message}`));
    return this.ajuste.resumo();
  },

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
  },

  /** [NOVO] Teto com 1 livre: o do status na conta pela taxa; ROBOS_MAX_COM_1_LIVRE no fixo. */
  maxComUmLivreAgora(agora = Date.now()) {
    return this.calculoDosRobos(agora)?.max ?? this.cfg.robosMaxComUmLivre;
  },

  /** [NOVO] Com quantos livres o status liga todos os robôs (calma: 2). 0 = nunca (fixo ou à mão). */
  todosComLivresAgora(agora = Date.now()) {
    const calculo = this.calculoDosRobos(agora);
    return calculo && calculo.fonte !== 'manual' ? calculo.todosComLivres : 0;
  },

  /** [NOVO] Robôs com 1 livre só pelo status (calma: 40). 0 = a regra de sempre (fixo, à mão ou outro status). */
  comUmLivreAgora(agora = Date.now()) {
    const calculo = this.calculoDosRobos(agora);
    return calculo && calculo.fonte !== 'manual' ? (calculo.comUmLivre ?? 0) : 0;
  },

  /** O "por livre" foi escolhido à mão no painel hoje? (vale até virar o dia) */
  ajustadoAMaoHoje(agora) {
    const em = this.ajuste?.ajustadoAMaoEm;
    if (!(em > 0)) return false;
    const fuso = this.cfg.fusoHorario ?? 'America/Sao_Paulo';
    return dataLocal(fuso, new Date(em)) === dataLocal(fuso, new Date(agora));
  },

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
  },

  /** Robôs por livre agora (ajustado pelos callbacks, pela URA passiva ou à mão). */
  porLivreAgora(agora = Date.now()) {
    return this.ajuste ? this.ajuste.atual(agora) : this.cfg.robosPorLivre;
  },

  emModoManual(agora = Date.now()) {
    if (!this.manualAte || agora < this.manualAte) return this.manualAte > 0;
    this.manualAte = 0;
    this.log.info('Fim do modo manual: o BenURA volta a comandar os robôs.');
    return false;
  },

  /** A supervisão assume os robôs pelo painel por `minutos`; o BenURA não liga nem desliga nenhum. */
  /**
   * Botão "Desligar automação" do painel: o rodízio para de mover gente e de
   * decidir robôs, e desliga os robôs. Sem `derrubar`, só os parados (os em
   * ligação terminam a chamada; o painel chama de novo até sobrar nenhum); com
   * `derrubar`, todos. Em seguida o painel para os serviços (pm2 stop).
   * @returns {Promise<{ ligados: number|null }>}
   */
  async encerrarRobosParaDesligar({ derrubar = false } = {}) {
    // [NOVO] No de pessoas: só para de mover; os robôs o painel encerra pelo benura-robos.
    if (this.papel === 'pessoas') {
      if (!this.desligandoAutomacao) this.log.aviso('Automação sendo desligada pelo painel: o rodízio parou de mover operadores.');
      this.desligandoAutomacao = true;
      this.enviarAosRobos().catch(() => {});
      return { ligados: this.robos.ligados ? this.robos.ligados.size : null };
    }
    this.desligandoPorPedido = true;
    if (!this.desligandoAutomacao) this.log.aviso('Automação sendo desligada pelo painel: o rodízio parou de mover operadores e está desligando os robôs.');
    this.desligandoAutomacao = true;
    if (this.ramaisRobos.length) await this.robos.sincronizar(this.ramaisRobos);
    const motivo = 'automação desligada pelo painel';
    const ligados = [...(this.robos.ligados || [])];
    if (ligados.length && derrubar) await this.robos.desligar(ligados, motivo);
    else if (ligados.length) await this.robos.encerrarSemDerrubar(motivo);
    return { ligados: this.robos.ligados ? this.robos.ligados.size : null };
  },

  assumirRobosManualmente(minutos) {
    this.manualAte = Date.now() + minutos * 60_000;
    this.log.aviso(`Modo manual por ${minutos} min: o BenURA não mexe nos robôs até ${new Date(this.manualAte).toISOString()}.`);
    return this.manualAte;
  },

  devolverRobosAoBenura() {
    this.manualAte = 0;
    this.log.info('Modo manual encerrado: o BenURA volta a comandar os robôs.');
  },
};

module.exports = { metodosDosRobos };
