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
const { registrarDesligamento, fecharServidor, escutar } = require('../utils/ciclo-de-vida');
const { EstadoRodizioRepository } = require('./estado-rodizio.repository');
const { Transferencias } = require('./transferencias');
const { ControleRobos } = require('./controle-robos');
const { RodizioService } = require('./rodizio.service');
const { ElegiveisUra } = require('./elegiveis-ura');
const { resolverFixos } = require('../integrations/argus/fixos');
const { UraCheia } = require('./ura-cheia');
const { Interruptor } = require('./interruptor');
const { TermometroUra } = require('./termometro-ura');
const { StatusUra } = require('./status-ura');
const { RetencaoAtivo } = require('./retencao-ativo');
const { EstatisticasDia } = require('./estatisticas-dia');
const { AjusteRobos } = require('./ajuste-robos');
const { VigiaCallbacks } = require('./vigia-callbacks');
const { VigiaRisco } = require('./vigia-risco');
const { PerfisClientes } = require('./perfis-clientes');
const { dataLocal } = require('../utils/datas');
const { DiretorioOperadores } = require('../integrations/argus/diretorio-operadores.service');
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

/** Monta as dependências (sem efeitos colaterais: nada é iniciado aqui). */
function montarRodizio(overrides) {
  const cfg = carregarConfig(overrides);
  const log = criarLogger({ debug: cfg.debug, escopo: 'rodizio' });
  const cfgRodizio = configDoRodizio(cfg);
  const client = new ArgusClient(cfg.argus, log.filho('argus'));

  const diretorio = new DiretorioOperadores({
    client, cfg: cfg.argus, arquivoSupervisoresGrupos: cfg.arquivoSupervisoresGrupos, logger: log.filho('diretorio'),
  });
  const rodizio = new RodizioService({
    client,
    transferencias: new Transferencias({ client, cfg: cfgRodizio, logger: log.filho('transferencias') }),
    robos: new ControleRobos({ client, cfg: cfgRodizio, logger: log.filho('robos') }),
    repositorio: new EstadoRodizioRepository({ arquivo: cfgRodizio.arquivoEstado, logger: log.filho('estado') }),
    cfg: cfgRodizio,
    logger: log.filho('rodizio'),
    // Grupo do supervisor, para devolver ao Ativo quem não foi movido pelo rodízio.
    diretorio,
    elegiveis: cfgRodizio.soElegiveis ? montarElegiveis(cfg, diretorio, log.filho('rodizio')) : null,
    ajuste: montarAjuste(cfgRodizio, cfg.agenda.fusoHorario, log.filho('robos')),
    uraCheia: new UraCheia({ arquivo: cfgRodizio.arquivoUraCheia, fusoHorario: cfg.agenda.fusoHorario, logger: log.filho('rodizio') }),
    // Fixos e equipes fixas (ex.: a do Robson): ficam na URA de vez, sem a regra do ocioso.
    fixos: cfg.regras.fixosPermanentesUra ? lerFixos(cfg, diretorio) : null,
    panico: new Interruptor({
      nome: 'Pânico dos robôs', arquivo: cfgRodizio.arquivoPanico, padrao: cfgRodizio.panicoPadrao, logger: log.filho('robos'),
    }),
    // Termômetro (faixas em src/config/uraThresholds.js) e o status manual do painel, que vale por cima dele.
    termometro: new TermometroUra({ logger: log.filho('robos') }),
    statusDaUra: new StatusUra({ arquivo: cfgRodizio.arquivoStatusUra, logger: log.filho('robos') }),
    // "Alocar Todos no Ativo": segura todos no Ativo até "Retomar rodízio da URA" (o roteador lê o mesmo arquivo).
    retencao: new RetencaoAtivo({ arquivo: cfg.automacao.arquivoRetencao, logger: log.filho('rodizio') }),
    estatisticas: new EstatisticasDia({
      repositorio: new ArquivoDeEstado({ arquivo: cfgRodizio.arquivoEstatisticas, logger: log.filho('estado') }), fusoHorario: cfg.agenda.fusoHorario,
    }),
  });
  const retornoFila = montarRetornoFila(cfg, client, log.filho('retorno-fila'));
  const comRobos = cfgRodizio.gruposRobosIds.length > 0;
  const cfgVigias = { gruposRobosIds: cfgRodizio.gruposRobosIds, idCampanha: cfgRodizio.idCampanhaRobos || undefined, fuso: cfg.agenda.fusoHorario };
  const risco = comRobos && cfgRodizio.perfis.ativo ? montarRisco({ cfgRodizio, cfgVigias, client, rodizio, log }) : null;
  const vigia = cfgRodizio.callbacksVerificarMs > 0 && comRobos ? new VigiaCallbacks({
    client, rodizio, cfg: cfgVigias, logger: log.filho('callbacks'), perfis: risco?.perfis ?? null,
  }) : null;
  return { cfg, cfgRodizio, log, rodizio, retornoFila, vigia, risco };
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

function exigirConfigValida(cfg, log) {
  const { fatais, avisos } = validarConfig(cfg, { escopo: 'rodizio' });
  avisos.forEach((a) => log.aviso(a));
  if (!fatais.length) return;

  fatais.forEach((f) => log.erro(f));
  process.exit(1);
}

/** Os três ciclos do rodízio, cada um sem sobreposição. */
function iniciarCiclos({ rodizio, cfgRodizio, log, vigia, risco }) {
  const ciclo = (nome, intervaloMs, tarefa) => executarPeriodicamente({
    nome, intervaloMs, tarefa, logger: log, alertaLentoMs: Math.max(5000, cfgRodizio.pollUraMs * 2, cfgRodizio.pollAtivoMs * 2),
  });
  return {
    grupos: ciclo('atualizarGrupos', cfgRodizio.refreshGruposMs, () => rodizio.atualizarGrupos()),
    ativo: ciclo('cicloAtivo', cfgRodizio.pollAtivoMs, () => rodizio.cicloAtivo()),
    ura: ciclo('cicloUra', () => rodizio.intervaloUraMs(), () => rodizio.cicloUra()),
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

function montarServidor({ cfg, log, rodizio, retornoFila, risco }, ciclos) {
  return criarServidor({
    rotas: criarRotasDoRodizio({
      rodizio,
      retornoFila,
      risco,
      ciclos: { ultimoCicloUra: () => ciclos.ura.ultimaExecucao(), ultimoCicloAtivo: () => ciclos.ativo.ultimaExecucao() },
      logger: log,
    }),
    cfg: cfg.http,
    logger: log.filho('http'),
  });
}

const descreverModoRobos = (c) => (c.robosModo === 'panico'
  ? 'modo pânico: a supervisão liga; o BenURA só desliga com 1 livre ou menos'
  : `${c.robosPorLivre} por livre${c.ajusteCallback ? `, de ${c.porLivreMinimo} a ${c.porLivreMaximo} conforme a URA` : ''}`);

function logarInicio({ cfg, cfgRodizio, log }) {
  const retorno = cfg.retornoFila.ativo ? `ligado (origem ${cfg.retornoFila.origem})` : 'desligado';
  log.info(`Rodízio iniciado | HTTP na porta ${cfgRodizio.porta} (GET /health, GET /ura, POST /webhook, POST /robos/manual, POST /robos/automatico) | `
    + `TEMPO_MIN=${cfgRodizio.tempoNaUraMs / 60_000} | URA=${cfgRodizio.grupoUraId} | robôs=grupos ${cfgRodizio.gruposRobosIds.join(',')} (${descreverModoRobos(cfgRodizio)}) | `
    + `Ativo=${cfgRodizio.gruposAtivosIds.join(',')} | sobem à URA: ${cfgRodizio.soElegiveis ? 'só elegíveis' : 'todos'} | retorno da fila: ${retorno}${cfgRodizio.dryRun ? ' | DRY_RUN' : ''}`);
}

async function iniciarRodizio() {
  const app = montarRodizio();
  const { cfg, cfgRodizio, log, rodizio, retornoFila } = app;
  ativarLogsEmArquivo(cfg, 'rodizio');

  exigirConfigValida(cfg, log);
  await aguardarAutomacaoLigada(cfg.automacao, log, 'rodízio');
  const trava = adquirirTravaOuEncerrar(cfgRodizio.arquivoTrava, log);
  rodizio.inicializar();
  retornoFila.inicializar();
  app.risco?.perfis.carregar();
  app.risco?.desligaRobos.carregar();
  await lerGruposIniciais(rodizio, log);

  const ciclos = iniciarCiclos(app);
  const servidor = montarServidor(app, ciclos);
  await escutar(servidor, cfgRodizio.porta);
  logarInicio(app);

  registrarDesligamento({
    logger: log,
    etapas: [
      () => Promise.all(Object.values(ciclos).map((c) => c.parar())),
      () => fecharServidor(servidor),
      () => rodizio.salvar(),
      () => rodizio.estatisticas?.gravar(),
      () => app.risco?.perfis.salvar(),
      () => retornoFila.aguardar(),
      () => trava.liberar(),
    ],
  });
  return { ...app, ciclos, servidor };
}

module.exports = { montarRodizio, iniciarRodizio };
