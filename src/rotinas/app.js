'use strict';
/**
 * Composition root das rotinas diárias (benura-rotinas).
 *
 *   node rotinas.js                    laço contínuo (PM2: benura-rotinas)
 *   node rotinas.js --agora            confere agora se está na hora e sai
 *   node rotinas.js --agora --forcar   executa o fim de expediente já, ignorando o horário
 *
 * Hoje: fim de expediente limpo. As próximas rotinas (bases, planilha) entram aqui.
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { carregarConfig, validarConfig } = require('../config');
const { criarLogger } = require('../utils/logger');
const { executarPeriodicamente } = require('../utils/periodico');
const { adquirirTravaOuEncerrar } = require('../utils/trava-processo');
const { registrarDesligamento, fecharServidor, escutar } = require('../utils/ciclo-de-vida');
const { ArquivoDeEstado } = require('../utils/persistencia-json');
const { criarServidor } = require('../http/server');
const { ArgusClient } = require('../integrations/argus/argus.client');
const { ArgusMockClient } = require('../integrations/argus/argus.mock-client');
const { AuditoriaRepository } = require('../repositories/auditoria.repository');
const { criarNotificador } = require('../notificacoes');
const { FimExpedienteService } = require('./fim-expediente.service');

/** Configuração do fim de expediente + o que ele compartilha com o resto. */
const configDoFimExpediente = (cfg) => ({
  ...cfg.rotinas.fimExpediente,
  horarioFim: cfg.agenda.horarioFim,
  fusoHorario: cfg.agenda.fusoHorario,
  grupoRobosId: cfg.rodizio.grupoRobosId,
  descricoesStatus: cfg.rodizio.descricoesStatus,
  concorrencia: cfg.rodizio.concorrencia,
  dryRun: cfg.argus.dryRun,
});

function montarRotinas(overrides) {
  const cfg = carregarConfig(overrides);
  const log = criarLogger({ debug: cfg.debug, escopo: 'rotinas' });
  const cfgFim = configDoFimExpediente(cfg);
  fs.mkdirSync(path.dirname(cfgFim.arquivoLog), { recursive: true });

  const client = cfg.usarMock ? new ArgusMockClient(log.filho('argus-mock')) : new ArgusClient(cfg.argus, log.filho('argus'));
  const fimExpediente = new FimExpedienteService({
    client,
    cfg: cfgFim,
    repositorio: new ArquivoDeEstado({ arquivo: cfg.rotinas.arquivoEstado, logger: log }),
    auditoria: new AuditoriaRepository({ arquivo: cfgFim.arquivoLog, logger: log }),
    notificador: criarNotificador({ cfg, logger: log }),
    logger: log.filho('fim-expediente'),
  });
  return { cfg, log, fimExpediente };
}

function exigirConfigValida(cfg, log) {
  const { fatais } = validarConfig(cfg, { escopo: 'rotinas' });
  if (!fatais.length) return;
  fatais.forEach((f) => log.erro(f));
  process.exit(1);
}

function lerOpcoes(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { agora: { type: 'boolean', default: false }, forcar: { type: 'boolean', default: false } },
  });
  return values;
}

function montarServidor({ cfg, log }, laco) {
  const health = async () => ({ status: 200, corpo: { uptime: process.uptime(), ultimaExecucao: laco.ultimaExecucao() } });
  return criarServidor({
    rotas: [{ metodo: 'GET', caminho: '/health', handler: health }],
    cfg: cfg.http,
    logger: log.filho('http'),
  });
}

async function executarContinuamente(app) {
  const { cfg, log, fimExpediente } = app;
  const trava = adquirirTravaOuEncerrar(cfg.rotinas.arquivoTrava, log);
  const laco = executarPeriodicamente({
    nome: 'rotinas', intervaloMs: cfg.rotinas.intervaloMs, tarefa: () => fimExpediente.tique(), logger: log,
  });
  const servidor = montarServidor(app, laco);
  await escutar(servidor, cfg.rotinas.porta);

  registrarDesligamento({
    logger: log,
    etapas: [() => laco.parar(), () => fecharServidor(servidor), () => trava.liberar()],
  });
  const f = cfg.rotinas.fimExpediente;
  log.info(`Rotinas iniciadas | /health na porta ${cfg.rotinas.porta} | fim de expediente: `
    + `${f.ativo ? `${fimExpediente.horarioAlvo} (${f.acao})` : 'desligado'}${cfg.argus.dryRun ? ' | DRY_RUN' : ''}`);
}

async function executarAgora({ log, fimExpediente }, { forcar }) {
  const relatorio = forcar ? await fimExpediente.executar() : await fimExpediente.tique();
  if (!relatorio) log.info(`Fora do horário (${fimExpediente.horarioAlvo}) ou já executado hoje. Use --forcar para rodar já.`);
}

async function iniciarRotinas(argv = process.argv.slice(2)) {
  const opcoes = lerOpcoes(argv);
  const app = montarRotinas();
  exigirConfigValida(app.cfg, app.log);
  if (!opcoes.agora) return executarContinuamente(app);
  return executarAgora(app, opcoes);
}

module.exports = { montarRotinas, iniciarRotinas };
