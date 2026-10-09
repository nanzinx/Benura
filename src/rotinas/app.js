'use strict';
/**
 * Composition root das rotinas diárias (benura-rotinas).
 *
 *   node rotinas.js                    laço contínuo (PM2: benura-rotinas)
 *   node rotinas.js --agora            confere agora se está na hora e sai
 *   node rotinas.js --agora --forcar   executa o fim de expediente já, ignorando o horário
 *
 *   node rotinas.js --base ativo       gera (e no modo argus sobe) a base agora, fora da agenda
 *   node rotinas.js --base ativo --esteira esteira.xlsx --so-arquivos
 *                                      ensaio: usa uma esteira já exportada e só grava os CSVs
 *
 * Rotinas: fim de expediente limpo e bases de mailing (Ativo, URA, Digital).
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
const { BasesService, EsteiraDeArquivo } = require('../bases/bases.service');
const { carregarBases, validarBases, problemasDaBase } = require('../bases/configuracao');
const { RoboEsteira } = require('../integrations/vanguard/esteira-robo');

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

/** Configuração das bases: .env + bases.json. */
const configDasBases = (cfg) => ({
  ...cfg.bases,
  bases: carregarBases(cfg.bases.arquivoConfig),
  fusoHorario: cfg.agenda.fusoHorario,
  dryRun: cfg.argus.dryRun,
});

/** De onde vem a esteira: o robô do Vanguard ou um arquivo já exportado (ensaio). */
function fonteDaEsteira(cfgBases, log, arquivo) {
  if (arquivo) return new EsteiraDeArquivo(arquivo);
  return new RoboEsteira({ cfg: { ...cfgBases.vanguard, pastaDownload: cfgBases.pastaDownloads }, logger: log.filho('vanguard') });
}

function montarRotinas(overrides, { esteira } = {}) {
  const cfg = carregarConfig(overrides);
  const log = criarLogger({ debug: cfg.debug, escopo: 'rotinas' });
  const cfgFim = configDoFimExpediente(cfg);
  fs.mkdirSync(path.dirname(cfgFim.arquivoLog), { recursive: true });

  const client = cfg.usarMock ? new ArgusMockClient(log.filho('argus-mock')) : new ArgusClient(cfg.argus, log.filho('argus'));
  const notificador = criarNotificador({ cfg, logger: log });
  const fimExpediente = new FimExpedienteService({
    client,
    cfg: cfgFim,
    repositorio: new ArquivoDeEstado({ arquivo: cfg.rotinas.arquivoEstado, logger: log }),
    auditoria: new AuditoriaRepository({ arquivo: cfgFim.arquivoLog, logger: log }),
    notificador,
    logger: log.filho('fim-expediente'),
  });

  const cfgBases = configDasBases(cfg);
  fs.mkdirSync(path.dirname(cfgBases.arquivoLog), { recursive: true });
  const bases = new BasesService({
    client,
    cfg: cfgBases,
    esteira: fonteDaEsteira(cfgBases, log, esteira),
    repositorio: new ArquivoDeEstado({ arquivo: cfgBases.arquivoEstado, logger: log }),
    auditoria: new AuditoriaRepository({ arquivo: cfgBases.arquivoLog, logger: log }),
    notificador,
    logger: log.filho('bases'),
  });
  return { cfg, cfgBases, log, fimExpediente, bases };
}

/** Problemas da execução manual de uma base (vale mesmo com a base desligada na agenda). */
function problemasDaExecucaoManual(cfgBases, { base, esteira, modo }) {
  const b = cfgBases.bases[base];
  if (!b) return [`Base "${base}" não existe em ${cfgBases.arquivoConfig} (há: ${Object.keys(cfgBases.bases).join(', ') || 'nenhuma'}).`];
  const problemas = problemasDaBase(base, b, { modo });
  const v = cfgBases.vanguard;
  if (!esteira && (!v.usuario || !v.senha)) problemas.push('Informe VANGUARD_USUARIO e VANGUARD_SENHA, ou use --esteira <arquivo>.');
  return problemas;
}

function exigirConfigValida({ cfg, cfgBases, log }, opcoes = {}) {
  const soArquivos = opcoes.base && opcoes.modo === 'arquivos'; // ensaio de base: não fala com a Argus
  const fatais = validarConfig(cfg, { escopo: 'rotinas' }).fatais.filter((f) => !(soArquivos && /ARGUS_TOKEN/.test(f)));
  if (opcoes.base) fatais.push(...problemasDaExecucaoManual(cfgBases, opcoes));
  if (!opcoes.base) fatais.push(...validarBases(cfgBases));
  if (!fatais.length) return;
  fatais.forEach((f) => log.erro(f));
  process.exit(1);
}

function lerOpcoes(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      agora: { type: 'boolean', default: false },
      forcar: { type: 'boolean', default: false },
      base: { type: 'string' },
      esteira: { type: 'string' },
      'so-arquivos': { type: 'boolean', default: false },
    },
  });
  return { ...values, soArquivos: values['so-arquivos'] };
}

function montarServidor({ cfg, log }, laco) {
  const health = async () => ({ status: 200, corpo: { uptime: process.uptime(), ultimaExecucao: laco.ultimaExecucao() } });
  return criarServidor({
    rotas: [{ metodo: 'GET', caminho: '/health', handler: health }],
    cfg: cfg.http,
    logger: log.filho('http'),
  });
}

/** Um tique: cada rotina isolada (a falha de uma não impede a outra). */
async function tique({ log, fimExpediente, bases }) {
  const rotinas = [['fim de expediente', () => fimExpediente.tique()], ['bases', () => bases.tique()]];
  for (const [nome, fn] of rotinas) await fn().catch((e) => log.erro(`Rotina ${nome} falhou: ${e.message}`));
}

/** Resumo das bases ligadas para o log de início. */
function descreverBases(cfgBases) {
  const ligadas = Object.entries(cfgBases.bases).filter(([, b]) => b.ativo).map(([nome]) => nome);
  if (!ligadas.length) return 'bases: nenhuma ligada';
  return `bases: ${ligadas.join(', ')} (${cfgBases.modo})`;
}

async function executarContinuamente(app) {
  const { cfg, cfgBases, log, fimExpediente } = app;
  const trava = adquirirTravaOuEncerrar(cfg.rotinas.arquivoTrava, log);
  const laco = executarPeriodicamente({
    nome: 'rotinas', intervaloMs: cfg.rotinas.intervaloMs, tarefa: () => tique(app), logger: log, alertaLentoMs: 10 * 60_000,
  });
  const servidor = montarServidor(app, laco);
  await escutar(servidor, cfg.rotinas.porta);

  registrarDesligamento({
    logger: log,
    etapas: [() => laco.parar(), () => fecharServidor(servidor), () => trava.liberar()],
  });
  const f = cfg.rotinas.fimExpediente;
  log.info(`Rotinas iniciadas | /health na porta ${cfg.rotinas.porta} | fim de expediente: `
    + `${f.ativo ? `${fimExpediente.horarioAlvo} (${f.acao})` : 'desligado'} | ${descreverBases(cfgBases)}`
    + `${cfg.argus.dryRun ? ' | DRY_RUN' : ''}`);
}

/** Gera uma base agora (fora da agenda). Código de saída 0 = gerada, 2 = não gerada ou com falha. */
async function executarBase({ bases }, { base, soArquivos }) {
  try {
    const r = await bases.executar(base, { modo: soArquivos ? 'arquivos' : undefined });
    return r.equipes.some((e) => e.erro) ? 2 : 0;
  } catch {
    return 2;
  }
}

async function executarAgora({ log, fimExpediente }, { forcar }) {
  const relatorio = forcar ? await fimExpediente.executar() : await fimExpediente.tique();
  if (!relatorio) log.info(`Fora do horário (${fimExpediente.horarioAlvo}) ou já executado hoje. Use --forcar para rodar já.`);
}

async function iniciarRotinas(argv = process.argv.slice(2)) {
  const opcoes = lerOpcoes(argv);
  const app = montarRotinas(undefined, { esteira: opcoes.esteira });
  exigirConfigValida(app, { ...opcoes, modo: opcoes.soArquivos ? 'arquivos' : app.cfgBases.modo });
  if (opcoes.base) {
    process.exitCode = await executarBase(app, opcoes);
    return undefined;
  }
  if (!opcoes.agora) return executarContinuamente(app);
  return executarAgora(app, opcoes);
}

module.exports = { montarRotinas, iniciarRotinas };
