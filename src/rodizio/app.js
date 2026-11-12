'use strict';
/**
 * Composition root do rodízio Ativo ↔ URA e controle dos robôs.
 */

const fs = require('fs');
const path = require('path');
const { carregarConfig, validarConfig } = require('../config');
const { criarLogger } = require('../utils/logger');
const { ativarLogsEmArquivo } = require('../utils/logs-em-arquivo');
const { ArgusClient } = require('../integrations/argus/argus.client');
const { criarServidor } = require('../http/server');
const { executarPeriodicamente } = require('../utils/periodico');
const { adquirirTravaOuEncerrar } = require('../utils/trava-processo');
const { aguardarAutomacaoLigada } = require('../utils/automacao');
const { vigiarPosse } = require('../utils/posse');
const { registrarDesligamento, fecharServidor, escutar } = require('../utils/ciclo-de-vida');
const { EstadoRodizioRepository } = require('./estado-rodizio.repository');
const { Transferencias } = require('./transferencias');
const { Assinaturas } = require('../webhooks-clientes/assinaturas');
const { AvisoTransferencias } = require('../webhooks-clientes/avisar-transferencia');
const { ControleRobos } = require('./controle-robos');
const { RodizioService } = require('./rodizio.service');
const { ElegiveisUra } = require('./elegiveis-ura');
const { resolverFixos } = require('../integrations/argus/fixos');
const { UraCheia } = require('./ura-cheia');
const { Interruptor } = require('./interruptor');
const { TermometroUra } = require('./termometro-ura');
const { StatusUra } = require('./status-ura');
const { RetencaoAtivo } = require('./retencao-ativo');
const { TravasManuais } = require('./travas-manuais');
const { ModoRobos } = require('./modo-robos');
const { GrupoRobos } = require('./grupo-robos');
const { AcoesOperador } = require('./acoes-operador');
const { EstatisticasDia } = require('./estatisticas-dia');

/** [NOVO] O que muda o resultado da URA e dos robôs, do .env (sem nenhum segredo): vai para o histórico do relatório. */
function fotoDaConfig(r) {
  const porStatus = Object.fromEntries(Object.entries(r.robosTaxa?.porStatus ?? {}).map(([s, { esperaS, min, max }]) => [s, { esperaS, min, max }]));
  return {
    calculo: r.robosCalculo,
    porLivre: r.robosPorLivre,
    porStatus,
    todosComLivresCalma: r.robosTaxa?.porStatus?.calma?.todosComLivres ?? 0,
    tempoMin: r.tempoNaUraMs / 60_000,
    cheiaLivres: { min: r.cheiaLivresMin, max: r.cheiaLivresMax },
  };
}
const { AjusteRobos } = require('./ajuste-robos');
const { VigiaCallbacks } = require('./vigia-callbacks');
const { VigiaRisco } = require('./vigia-risco');
const { PerfisClientes } = require('./perfis-clientes');
const { dataLocal } = require('../utils/datas');
const { DiretorioOperadores } = require('../integrations/argus/diretorio-operadores.service');
const { ContasDeSupervisores } = require('../domain/contas-supervisores');
const { criarRotasDoRodizio } = require('./controllers');
const { RetornoFilaService } = require('../retorno-fila/retorno-fila.service');
const { ArquivoDeEstado } = require('../utils/persistencia-json');
const { AuditoriaRepository } = require('../repositories/auditoria.repository');

/** Configuração do rodízio + o que ele compartilha com o resto (grupos, DRY_RUN). */
const configDoRodizio = (cfg) => ({
  ...cfg.rodizio,
  grupoUraId: cfg.argus.grupoUraId,
  gruposAtivosIds: cfg.argus.gruposAtivosIds,
  dryRun: cfg.argus.dryRun,
  alinharLogin: cfg.argus.alinharLogin,
  esperaLoginMs: cfg.argus.esperaLoginMs,
  alinharAposMs: cfg.argus.alinharAposMs,
  fusoHorario: cfg.agenda.fusoHorario,
  fixosPermanentesUra: cfg.regras.fixosPermanentesUra,
});

/** [NOVO] Clientes do webhook de transferências e quem avisa (o mesmo módulo do roteador). */
function montarWebhooksClientes(cfg, diretorio, log) {
  const assinaturas = new Assinaturas({ arquivo: cfg.webhooksClientes.arquivo, logger: log.filho('webhooks') });
  return { assinaturas, aviso: new AvisoTransferencias({ assinaturas, diretorio, logger: log.filho('webhooks') }) };
}

/** [NOVO] Estado do rodízio só em memória: o de robôs nunca grava o estado das pessoas. */
const estadoEmMemoria = () => ({ dados: {}, carregar() { return this.dados; }, salvar(d) { this.dados = d; return true; }, aguardar: async () => {} });

/**
 * [NOVO] O de pessoas fala com o de robôs pelo localhost (POST /interno/ura), com o WEBHOOK_TOKEN.
 * @returns {{ enviar(corpo: object): Promise<object> }}
 */
function criarLigacaoRobos(cfg) {
  const url = `${cfg.robos.url}/interno/ura`;
  const token = cfg.http.tokenAdmin;
  return {
    async enviar(corpo) {
      const resposta = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(corpo),
        signal: AbortSignal.timeout(cfg.robos.timeoutMs),
      });
      if (!resposta.ok) throw new Error(`HTTP ${resposta.status}`);
      return resposta.json();
    },
  };
}

/** [NOVO] Qual papel este processo faz: o pedido (robos.js) ou, no benura-rodizio, pessoas (separado) ou tudo. */
const papelDoProcesso = (cfg, pedido) => pedido ?? (cfg.robos.servicoProprio ? 'pessoas' : 'tudo');

/**
 * Monta as dependências (sem efeitos colaterais: nada é iniciado aqui).
 * @param {object} [overrides]
 * @param {{ papel?: 'tudo'|'pessoas'|'robos' }} [opcoes] - [NOVO] robos.js pede 'robos'
 */
function montarRodizio(overrides, { papel: pedido = null } = {}) {
  const cfg = carregarConfig(overrides);
  const papel = papelDoProcesso(cfg, pedido);
  const comPessoas = papel !== 'robos';
  const comRobos = papel !== 'pessoas';
  const log = criarLogger({ debug: cfg.debug, escopo: papel === 'robos' ? 'robos' : 'rodizio' });
  // O de robôs nunca reloga ninguém (é ação do rodízio de pessoas).
  const cfgRodizio = { ...configDoRodizio(cfg), ...(papel === 'robos' ? { alinharLogin: false } : {}) };
  const client = new ArgusClient(cfg.argus, log.filho('argus'));
  const controleRobos = () => new ControleRobos({ client, cfg: cfgRodizio, logger: log.filho('robos') });

  const diretorio = new DiretorioOperadores({
    client, cfg: cfg.argus, arquivoSupervisoresGrupos: cfg.arquivoSupervisoresGrupos, logger: log.filho('diretorio'),
  });
  // [NOVO] Webhook de transferências: cada operador movido entre URA e Ativo avisa os clientes cadastrados.
  const webhooksClientes = comPessoas ? montarWebhooksClientes(cfg, diretorio, log) : null;
  const rodizio = new RodizioService({
    papel,
    client,
    transferencias: comPessoas ? new Transferencias({
      client, cfg: cfgRodizio, logger: log.filho('transferencias'), aoTransferir: (t) => { webhooksClientes.aviso.avisar(t).catch((e) => log.aviso(`Webhook de transferências: ${e.message}`)); },
    }) : null,
    robos: comRobos ? controleRobos() : null,
    // [NOVO] No de pessoas: a conversa com o de robôs e, para a rede de segurança, os robôs de verdade.
    ligacaoRobos: papel === 'pessoas' ? criarLigacaoRobos(cfg) : null,
    robosDeEmergencia: papel === 'pessoas' ? controleRobos() : null,
    repositorio: comPessoas ? new EstadoRodizioRepository({ arquivo: cfgRodizio.arquivoEstado, logger: log.filho('estado') }) : estadoEmMemoria(),
    cfg: cfgRodizio,
    logger: log.filho(papel === 'robos' ? 'robos' : 'rodizio'),
    // Grupo do supervisor, para devolver ao Ativo quem não foi movido pelo rodízio.
    diretorio: comPessoas ? diretorio : null,
    // [NOVO] Contas operacionais de supervisores: não ficam na URA.
    contasSupervisores: comPessoas ? new ContasDeSupervisores({ diretorio, cfg: cfg.regras.contasSupervisores, logger: log.filho('rodizio') }) : null,
    elegiveis: comPessoas && cfgRodizio.soElegiveis ? montarElegiveis(cfg, diretorio, log.filho('rodizio')) : null,
    ajuste: comRobos ? montarAjuste(cfgRodizio, cfg.agenda.fusoHorario, log.filho('robos')) : null,
    uraCheia: comPessoas ? new UraCheia({ arquivo: cfgRodizio.arquivoUraCheia, fusoHorario: cfg.agenda.fusoHorario, logger: log.filho('rodizio') }) : null,
    // Fixos e equipes fixas (ex.: a do Robson): ficam na URA de vez, sem a regra do ocioso.
    fixos: comPessoas && cfg.regras.fixosPermanentesUra ? lerFixos(cfg, diretorio) : null,
    panico: comRobos ? new Interruptor({
      nome: 'Pânico dos robôs', arquivo: cfgRodizio.arquivoPanico, padrao: cfgRodizio.panicoPadrao, logger: log.filho('robos'),
    }) : null,
    // Termômetro (faixas em src/config/uraThresholds.js) e o status manual do painel, que vale por cima dele.
    // [NOVO] No de robôs, os dois vêm no retrato (o serviço troca por um repasse ao de pessoas).
    termometro: comPessoas ? new TermometroUra({ logger: log.filho('robos') }) : null,
    statusDaUra: comPessoas ? new StatusUra({ arquivo: cfgRodizio.arquivoStatusUra, logger: log.filho('robos') }) : null,
    // "Alocar Todos no Ativo": segura todos no Ativo até "Retomar rodízio da URA" (o roteador lê o mesmo arquivo).
    retencao: comPessoas ? new RetencaoAtivo({ arquivo: cfg.automacao.arquivoRetencao, logger: log.filho('rodizio') }) : null,
    modoRobos: comRobos ? new ModoRobos({ arquivo: cfgRodizio.arquivoModoRobos, padrao: cfgRodizio.robosModo, logger: log.filho('robos') }) : null,
    grupoRobos: comRobos ? new GrupoRobos({ arquivo: cfgRodizio.arquivoGrupoRobos, logger: log.filho('robos') }) : null,
    travas: comPessoas ? new TravasManuais({ arquivo: cfg.automacao.arquivoTravas, fusoHorario: cfg.agenda.fusoHorario, logger: log.filho('rodizio') }) : null,
    estatisticas: comPessoas ? new EstatisticasDia({
      repositorio: new ArquivoDeEstado({ arquivo: cfgRodizio.arquivoEstatisticas, logger: log.filho('estado') }), fusoHorario: cfg.agenda.fusoHorario,
      historico: new ArquivoDeEstado({ arquivo: cfgRodizio.arquivoHistorico, logger: log.filho('estado') }),
      // [NOVO] O relatório é do expediente: o mesmo horário da agenda da automação (08:00 às 18:00).
      expediente: { inicio: cfg.automacao.agenda.religarAs, fim: cfg.automacao.agenda.desligarAs },
      // [NOVO] a configuração dos robôs e da URA guardada em cada dia: as sugestões do relatório comparam por ela
      fotoDaConfig: () => fotoDaConfig(cfgRodizio),
    }) : null,
  });
  const retornoFila = comPessoas ? montarRetornoFila(cfg, client, log.filho('retorno-fila')) : null;
  const haRobos = comRobos && (cfgRodizio.gruposRobosIds.length > 0 || (cfgRodizio.gruposRobosNomes && cfgRodizio.gruposRobosNomes.length > 0));
  const cfgVigias = { gruposRobosIds: () => rodizio.gruposRobosIds(), idCampanha: cfgRodizio.idCampanhaRobos || undefined, fuso: cfg.agenda.fusoHorario };
  const risco = haRobos && cfgRodizio.perfis.ativo ? montarRisco({ cfgRodizio, cfgVigias, client, rodizio, log }) : null;
  const vigia = cfgRodizio.callbacksVerificarMs > 0 && haRobos ? new VigiaCallbacks({
    client, rodizio, cfg: cfgVigias, logger: log.filho('callbacks'), perfis: risco?.perfis ?? null,
  }) : null;
  const acoes = comPessoas ? new AcoesOperador({ client, rodizio, cfg: { dryRun: cfg.argus.dryRun }, logger: log.filho('acoes') }) : null;
  return { cfg, cfgRodizio, papel, log, rodizio, retornoFila, vigia, risco, acoes, webhooksClientes };
}

/** Perfis de clientes + vigia de cliente de risco em ligação + interruptor "desligar robôs". */
function montarRisco({ cfgRodizio, cfgVigias, client, rodizio, log }) {
  const p = cfgRodizio.perfis;
  const logger = log.filho('perfis');
  const perfis = new PerfisClientes({ cfg: { ...p, fuso: cfgVigias.fuso }, logger });
  const desligaRobos = new Interruptor({
    nome: 'Desligar robôs com cliente de risco', arquivo: p.arquivoDesliga, padrao: p.desligaPadrao, logger,
  });
  const vigia = new VigiaRisco({ client, rodizio, perfis, desligaRobos, cfg: cfgVigias, logger });
  return { perfis, desligaRobos, vigia };
}

/** Ramais dos fixos (OPERADORES_FIXOS_URA e EQUIPES_FIXAS_URA, menos FORA_DOS_FIXOS_URA), pelo diretório da Argus. */
const lerFixos = (cfg, diretorio) => async () => {
  await diretorio.atualizar();
  return resolverFixos(diretorio, cfg.regras).ramais;
};

/** Lista do dia do roteador; sem ela, só os fixos (resolvidos pelo diretório da Argus). */
function montarElegiveis(cfg, diretorio, logger) {
  return new ElegiveisUra({ arquivo: cfg.rodizio.arquivoVendas, fusoHorario: cfg.agenda.fusoHorario, logger, fixos: lerFixos(cfg, diretorio) });
}

/**
 * Robôs por livre que se ajustam ao dia: descem no callback e sobem com a URA passiva
 * (ROBOS_AJUSTE_CALLBACK liga o automático); a supervisão também ajusta na página /ura.
 */
function montarAjuste(c, fusoHorario, logger) {
  const cfg = {
    base: c.robosPorLivre,
    piso: Math.min(c.porLivreMinimo, c.robosPorLivre),
    maximo: Math.max(c.porLivreMaximo, c.robosPorLivre),
    degrau: c.degrauAjuste,
    recuperarAposMs: c.recuperarAposMs,
    intervaloMinMs: c.intervaloAjusteMs,
    passivaMs: c.passivaMs,
    automatico: c.ajusteCallback,
  };
  const repositorio = new ArquivoDeEstado({ arquivo: c.arquivoAjuste, logger });
  return new AjusteRobos({ cfg, logger, repositorio, hoje: () => dataLocal(fusoHorario) });
}

/** Retorno de quem desistiu da fila: recebe os mesmos webhooks do rodízio. */
function montarRetornoFila(cfg, client, logger) {
  const r = cfg.retornoFila;
  if (r.ativo) fs.mkdirSync(path.dirname(r.arquivoLog), { recursive: true });
  return new RetornoFilaService({
    client,
    cfg: { ...r, dryRun: cfg.argus.dryRun, fusoHorario: cfg.agenda.fusoHorario },
    repositorio: new ArquivoDeEstado({ arquivo: r.arquivoEstado, logger }),
    auditoria: new AuditoriaRepository({ arquivo: r.arquivoLog, logger }),
    logger,
  });
}

function exigirConfigValida(cfg, log, escopo = 'rodizio') {
  const { fatais, avisos } = validarConfig(cfg, { escopo });
  avisos.forEach((a) => log.aviso(a));
  if (!fatais.length) return;

  fatais.forEach((f) => log.erro(f));
  process.exit(1);
}

/**
 * Os ciclos do rodízio, cada um sem sobreposição. [NOVO] No de robôs não há o ciclo do Ativo
 * (não move ninguém), e o da URA só decide os robôs; o vigia de callbacks e o de risco ficam lá.
 */
function iniciarCiclos({ rodizio, cfgRodizio, log, vigia, risco, papel }) {
  const ciclo = (nome, intervaloMs, tarefa) => executarPeriodicamente({
    nome, intervaloMs, tarefa, logger: log, alertaLentoMs: Math.max(5000, cfgRodizio.pollUraMs * 2, cfgRodizio.pollAtivoMs * 2),
  });
  return {
    grupos: ciclo('atualizarGrupos', cfgRodizio.refreshGruposMs, () => rodizio.atualizarGrupos()),
    ...(papel !== 'robos' ? { ativo: ciclo('cicloAtivo', cfgRodizio.pollAtivoMs, () => rodizio.cicloAtivo()) } : {}),
    ura: ciclo(papel === 'robos' ? 'cicloRobos' : 'cicloUra', () => rodizio.intervaloUraMs(), () => rodizio.cicloUra()),
    ...(vigia ? { callbacks: ciclo('vigiaCallbacks', cfgRodizio.callbacksVerificarMs, () => vigia.verificar()) } : {}),
    ...(risco && cfgRodizio.perfis.vigiaMs > 0 ? { risco: ciclo('vigiaRisco', cfgRodizio.perfis.vigiaMs, () => risco.vigia.verificar()) } : {}),
  };
}

/** Primeira leitura de grupos antes dos ciclos; falha aqui não impede o início. */
async function lerGruposIniciais(rodizio, log) {
  try {
    await rodizio.atualizarGrupos();
  } catch (e) {
    log.aviso(`Primeira leitura de grupos falhou (${e.message}); o ciclo seguirá tentando.`);
  }
}

/**
 * [NOVO] No de pessoas, as rotas dos robôs (pânico, modo, ajuste, risco) vão ao benura-robos:
 * a página /ura e quem chama o :3000 continuam funcionando.
 */
function criarRepasseAosRobos(cfg) {
  const token = cfg.http.tokenAdmin;
  return async ({ req, corpo }) => {
    const u = new URL(req?.url ?? '/', 'http://x');
    try {
      const r = await fetch(`${cfg.robos.url}${u.pathname}${u.search}`, {
        method: req.method,
        headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(corpo != null ? { 'Content-Type': 'application/json' } : {}) },
        body: corpo != null ? JSON.stringify(corpo) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
      const texto = await r.text();
      return { status: r.status, corpo: texto ? JSON.parse(texto) : null };
    } catch (e) {
      return { status: 502, corpo: { erro: `o serviço dos robôs (benura-robos) não respondeu: ${e.message}` } };
    }
  };
}

function montarServidor({ cfg, log, rodizio, retornoFila, risco, acoes, webhooksClientes, papel }, ciclos) {
  return criarServidor({
    rotas: criarRotasDoRodizio({
      rodizio,
      retornoFila,
      risco,
      acoes,
      webhooksClientes,
      papel,
      repassarAosRobos: papel === 'pessoas' ? criarRepasseAosRobos(cfg) : null,
      ciclos: { ultimoCicloUra: () => ciclos.ura.ultimaExecucao(), ultimoCicloAtivo: () => ciclos.ativo?.ultimaExecucao() ?? null },
      logger: log,
    }),
    cfg: cfg.http,
    logger: log.filho('http'),
  });
}

const descreverModoRobos = (c) => (c.robosModo === 'panico'
  ? 'modo pânico: a supervisão liga; o BenURA só desliga com 1 livre ou menos'
  : `${c.robosPorLivre} por livre${c.ajusteCallback ? `, de ${c.porLivreMinimo} a ${c.porLivreMaximo} conforme a URA` : ''}`);

function logarInicio({ cfg, cfgRodizio, log, papel }) {
  if (papel === 'robos') {
    log.info(`Robôs da URA iniciados | HTTP na porta ${cfg.robos.porta} (GET /health, POST /interno/ura) | robôs=grupos ${cfgRodizio.gruposRobosIds.join(',')} `
      + `(${descreverModoRobos(cfgRodizio)}) | a URA vem do retrato do benura-rodizio${cfgRodizio.dryRun ? ' | DRY_RUN' : ''}`);
    return;
  }
  const retorno = cfg.retornoFila.ativo ? `ligado (origem ${cfg.retornoFila.origem})` : 'desligado';
  const robos = papel === 'pessoas' ? `robôs no benura-robos (${cfg.robos.url})` : `robôs=grupos ${cfgRodizio.gruposRobosIds.join(',')} (${descreverModoRobos(cfgRodizio)})`;
  log.info(`Rodízio iniciado | HTTP na porta ${cfgRodizio.porta} (GET /health, GET /ura, POST /webhook, POST /robos/manual, POST /robos/automatico) | `
    + `TEMPO_MIN=${cfgRodizio.tempoNaUraMs / 60_000} | URA=${cfgRodizio.grupoUraId} | ${robos} | `
    + `Ativo=${cfgRodizio.gruposAtivosIds.join(',')} | sobem à URA: ${cfgRodizio.soElegiveis ? 'só elegíveis' : 'todos'} | retorno da fila: ${retorno}${cfgRodizio.dryRun ? ' | DRY_RUN' : ''}`);
}

/**
 * [NOVO] ROBOS_SERVICO_PROPRIO=false e o benura-robos subiu assim mesmo: os robôs são do benura-rodizio.
 * Fica de pé só com o /health dizendo isso (sair faria o PM2 religar sem parar), sem tocar na Argus.
 */
async function ficarParadoSemPapel(cfg, log) {
  log.aviso('ROBOS_SERVICO_PROPRIO=false: os robôs ficam no benura-rodizio. Este serviço (benura-robos) fica parado; pode desligá-lo no PM2.');
  const servidor = criarServidor({
    rotas: [{ metodo: 'GET', caminho: '/health', handler: async () => ({ status: 200, corpo: { papel: 'desativado', uptime: process.uptime() } }) }],
    cfg: cfg.http,
    logger: log.filho('http'),
  });
  await escutar(servidor, cfg.robos.porta);
  registrarDesligamento({ logger: log, etapas: [() => fecharServidor(servidor)] });
  return { servidor };
}

/** Sobe um papel: o benura-rodizio (pessoas, ou tudo) ou o benura-robos. */
async function iniciarServico(pedido = null) {
  const app = montarRodizio(undefined, { papel: pedido });
  const { cfg, cfgRodizio, log, rodizio, retornoFila, papel } = app;
  const ehRobos = papel === 'robos';
  ativarLogsEmArquivo(cfg, ehRobos ? 'robos' : 'rodizio');
  if (ehRobos && !cfg.robos.servicoProprio) return ficarParadoSemPapel(cfg, log);

  exigirConfigValida(cfg, log, ehRobos ? 'robos' : 'rodizio');
  const nome = ehRobos ? 'robôs' : 'rodízio';
  await aguardarAutomacaoLigada(cfg.automacao, log, nome, { app: ehRobos ? 'benura-robos' : 'benura-rodizio' });
  const vigia = vigiarPosse(cfg.automacao.posse, log, nome);
  const trava = adquirirTravaOuEncerrar(ehRobos ? cfg.robos.arquivoTrava : cfgRodizio.arquivoTrava, log);
  rodizio.inicializar();
  retornoFila?.inicializar();
  app.risco?.perfis.carregar();
  app.risco?.desligaRobos.carregar();
  await lerGruposIniciais(rodizio, log);

  const ciclos = iniciarCiclos(app);
  const servidor = montarServidor(app, ciclos);
  await escutar(servidor, ehRobos ? cfg.robos.porta : cfgRodizio.porta);
  logarInicio(app);

  registrarDesligamento({
    logger: log,
    etapas: [
      () => vigia.parar(),
      () => Promise.all(Object.values(ciclos).map((c) => c.parar())),
      () => fecharServidor(servidor),
      () => rodizio.salvar(),
      () => rodizio.estatisticas?.gravar(),
      () => app.risco?.perfis.salvar(),
      () => retornoFila?.aguardar(),
      () => trava.liberar(),
    ],
  });
  return { ...app, ciclos, servidor };
}

const iniciarRodizio = () => iniciarServico(null);
const iniciarRobos = () => iniciarServico('robos');

module.exports = { montarRodizio, iniciarRodizio, iniciarRobos, fotoDaConfig };
