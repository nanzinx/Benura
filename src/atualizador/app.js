'use strict';
/**
 * Composition root do atualizador da produção.
 *
 *   node atualizador.js                    laço contínuo (PM2: ecosystem.atualizador.config.js)
 *   node atualizador.js --uma-vez          uma verificação e sai
 *   node atualizador.js --uma-vez --ignorar-janela   deploy de emergência fora da janela
 */

const fs = require('fs');
const path = require('path');
const { parseArgs } = require('util');
const { carregarConfig, validarConfig } = require('../config');
const { criarLogger } = require('../utils/logger');
const { horaLocal, diaDaSemanaLocal } = require('../utils/datas');
const { executarPeriodicamente } = require('../utils/periodico');
const { adquirirTravaOuEncerrar } = require('../utils/trava-processo');
const { registrarDesligamento, fecharServidor, escutar } = require('../utils/ciclo-de-vida');
const { criarServidor } = require('../http/server');
const { AuditoriaRepository } = require('../repositories/auditoria.repository');
const { criarExecutor } = require('./executor');
const { aguardarSaude } = require('./saude');
const { AtualizadorService, Resultado } = require('./atualizador.service');

function montarAtualizador(overrides) {
  const cfg = carregarConfig(overrides);
  const log = criarLogger({ debug: cfg.debug, escopo: 'atualizador' });
  const a = cfg.atualizador;
  fs.mkdirSync(path.dirname(a.arquivoLog), { recursive: true });

  const servico = new AtualizadorService({
    executar: criarExecutor({ cwd: a.diretorio, logger: log }),
    aguardarSaude,
    relogio: {
      momento: () => ({ diaSemana: diaDaSemanaLocal(cfg.agenda.fusoHorario), hora: horaLocal(cfg.agenda.fusoHorario) }),
    },
    cfg: {
      branch: a.branch,
      apps: a.apps,
      healthUrls: a.healthUrls,
      healthTimeoutMs: a.healthTimeoutMs,
      expediente: { inicio: cfg.agenda.horarioCarga, fim: cfg.agenda.horarioFim },
    },
    auditoria: new AuditoriaRepository({ arquivo: a.arquivoLog, logger: log }),
    logger: log,
  });
  return { cfg, log, servico };
}

function exigirConfigValida(cfg, log) {
  const { fatais } = validarConfig(cfg, { escopo: 'atualizador' });
  if (!fatais.length) return;
  fatais.forEach((f) => log.erro(f));
  process.exit(1);
}

function lerOpcoes(argv) {
  const { values } = parseArgs({
    args: argv,
    options: { 'uma-vez': { type: 'boolean', default: false }, 'ignorar-janela': { type: 'boolean', default: false } },
  });
  return { umaVez: values['uma-vez'], ignorarJanela: values['ignorar-janela'] };
}

/** Uma verificação e sai (código 0 = implantado/sem mudança/fora da janela; 2 = abortado/revertido). */
async function executarUmaVez({ servico, log }, { ignorarJanela }) {
  const r = await servico.verificar({ ignorarJanela });
  log.info(`Resultado: ${r.resultado}`);
  const problemas = [Resultado.ABORTADO, Resultado.REVERTIDO];
  return problemas.includes(r.resultado) ? 2 : 0;
}

function montarServidor({ cfg, servico, log }) {
  const health = async () => ({
    status: 200,
    corpo: { uptime: process.uptime(), janelaAberta: servico.janelaAberta(), ultimo: servico.ultimo },
  });
  return criarServidor({
    rotas: [{ metodo: 'GET', caminho: '/health', handler: health }],
    cfg: cfg.http,
    logger: log.filho('http'),
  });
}

/** Laço contínuo. Depois de implantar, encerra para o PM2 subir o atualizador já com o código novo. */
async function executarContinuamente(app) {
  const { cfg, log, servico } = app;
  const trava = adquirirTravaOuEncerrar(cfg.atualizador.arquivoTrava, log);
  const servidor = montarServidor(app);
  await escutar(servidor, cfg.atualizador.porta);

  let encerrar = () => {};
  const tarefa = async () => {
    const r = await servico.verificar();
    if (r.resultado === Resultado.IMPLANTADO) encerrar('nova versão implantada');
  };
  const laco = executarPeriodicamente({ nome: 'atualizador', intervaloMs: cfg.atualizador.intervaloMs, tarefa, logger: log });

  encerrar = registrarDesligamento({
    logger: log,
    etapas: [() => laco.parar(), () => fecharServidor(servidor), () => trava.liberar()],
  });
  log.info(`Atualizador iniciado: verifica origin/${cfg.atualizador.branch} a cada ${cfg.atualizador.intervaloMs / 1000}s; `
    + `deploy só fora de ${cfg.agenda.horarioCarga}–${cfg.agenda.horarioFim} em dias úteis (fim de semana livre). `
    + `/health na porta ${cfg.atualizador.porta}.`);
}

async function iniciarAtualizador(argv = process.argv.slice(2)) {
  const opcoes = lerOpcoes(argv);
  const app = montarAtualizador();
  exigirConfigValida(app.cfg, app.log);
  if (!opcoes.umaVez) return executarContinuamente(app);

  process.exitCode = await executarUmaVez(app, opcoes);
  return undefined;
}

module.exports = { montarAtualizador, iniciarAtualizador };
