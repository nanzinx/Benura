'use strict';
/**
 * Composition root do rodízio Ativo ↔ URA e controle dos robôs.
 */

const { carregarConfig, validarConfig } = require('../config');
const { criarLogger } = require('../utils/logger');
const { ArgusClient } = require('../integrations/argus/argus.client');
const { criarServidor } = require('../http/server');
const { executarPeriodicamente } = require('../utils/periodico');
const { adquirirTrava, TravaOcupadaError } = require('../utils/trava-processo');
const { registrarDesligamento, fecharServidor, escutar } = require('../utils/ciclo-de-vida');
const { EstadoRodizioRepository } = require('./estado-rodizio.repository');
const { Transferencias } = require('./transferencias');
const { ControleRobos } = require('./controle-robos');
const { RodizioService } = require('./rodizio.service');
const { criarRotasDoRodizio } = require('./controllers');

/** Configuração do rodízio + o que ele compartilha com o resto (grupos, DRY_RUN). */
const configDoRodizio = (cfg) => ({
  ...cfg.rodizio,
  grupoUraId: cfg.argus.grupoUraId,
  gruposAtivosIds: cfg.argus.gruposAtivosIds,
  dryRun: cfg.argus.dryRun,
});

/** Monta as dependências (sem efeitos colaterais: nada é iniciado aqui). */
function montarRodizio(overrides) {
  const cfg = carregarConfig(overrides);
  const log = criarLogger({ debug: cfg.debug, escopo: 'rodizio' });
  const cfgRodizio = configDoRodizio(cfg);
  const client = new ArgusClient(cfg.argus, log.filho('argus'));

  const rodizio = new RodizioService({
    client,
    transferencias: new Transferencias({ client, cfg: cfgRodizio, logger: log.filho('transferencias') }),
    robos: new ControleRobos({ client, cfg: cfgRodizio, logger: log.filho('robos') }),
    repositorio: new EstadoRodizioRepository({ arquivo: cfgRodizio.arquivoEstado, logger: log.filho('estado') }),
    cfg: cfgRodizio,
    logger: log.filho('rodizio'),
  });
  return { cfg, cfgRodizio, log, rodizio };
}

function exigirConfigValida(cfg, log) {
  const { fatais, avisos } = validarConfig(cfg, { escopo: 'rodizio' });
  avisos.forEach((a) => log.aviso(a));
  if (!fatais.length) return;

  fatais.forEach((f) => log.erro(f));
  process.exit(1);
}

/** Garante instância única; outra instância viva encerra este processo. */
function exigirTrava(caminho, log) {
  let trava;
  try {
    trava = adquirirTrava(caminho);
  } catch (e) {
    return encerrarSeOcupada(e, log);
  }
  if (trava.reaproveitouOrfa) log.aviso(`Trava órfã (PID ${trava.pidAnterior} não existe mais) reaproveitada: ${caminho}`);
  return trava;
}

function encerrarSeOcupada(e, log) {
  if (!(e instanceof TravaOcupadaError)) throw e;
  log.erro(e.message);
  return process.exit(1);
}

/** Os três ciclos do rodízio, cada um sem sobreposição. */
function iniciarCiclos({ rodizio, cfgRodizio, log }) {
  const ciclo = (nome, intervaloMs, tarefa) => executarPeriodicamente({
    nome, intervaloMs, tarefa, logger: log, alertaLentoMs: Math.max(5000, intervaloMs * 2),
  });
  return {
    grupos: ciclo('atualizarGrupos', cfgRodizio.refreshGruposMs, () => rodizio.atualizarGrupos()),
    ativo: ciclo('cicloAtivo', cfgRodizio.pollAtivoMs, () => rodizio.cicloAtivo()),
    ura: ciclo('cicloUra', cfgRodizio.pollUraMs, () => rodizio.cicloUra()),
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

function montarServidor({ cfg, log, rodizio }, ciclos) {
  return criarServidor({
    rotas: criarRotasDoRodizio({
      rodizio,
      ciclos: { ultimoCicloUra: () => ciclos.ura.ultimaExecucao(), ultimoCicloAtivo: () => ciclos.ativo.ultimaExecucao() },
      logger: log,
    }),
    cfg: cfg.http,
    logger: log.filho('http'),
  });
}

function logarInicio(cfgRodizio, log) {
  log.info(`Rodízio iniciado | HTTP na porta ${cfgRodizio.porta} (GET /health, POST /webhook) | `
    + `TEMPO_MIN=${cfgRodizio.tempoNaUraMs / 60_000} | URA=${cfgRodizio.grupoUraId} | robôs=${cfgRodizio.grupoRobosId} | `
    + `Ativo=${cfgRodizio.gruposAtivosIds.join(',')}${cfgRodizio.dryRun ? ' | DRY_RUN' : ''}`);
}

async function iniciarRodizio() {
  const app = montarRodizio();
  const { cfg, cfgRodizio, log, rodizio } = app;

  exigirConfigValida(cfg, log);
  const trava = exigirTrava(cfgRodizio.arquivoTrava, log);
  rodizio.inicializar();
  await lerGruposIniciais(rodizio, log);

  const ciclos = iniciarCiclos(app);
  const servidor = montarServidor(app, ciclos);
  await escutar(servidor, cfgRodizio.porta);
  logarInicio(cfgRodizio, log);

  registrarDesligamento({
    logger: log,
    etapas: [
      () => Promise.all(Object.values(ciclos).map((c) => c.parar())),
      () => fecharServidor(servidor),
      () => rodizio.salvar(),
      () => trava.liberar(),
    ],
  });
  return { ...app, ciclos, servidor };
}

module.exports = { montarRodizio, iniciarRodizio };
