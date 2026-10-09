'use strict';
/**
 * Composition root: monta as dependências e controla o ciclo de vida
 * (inicialização e desligamento gracioso).
 */

const { carregarConfig, validarConfig } = require('./config');
const { criarLogger } = require('./utils/logger');
const { dataLocal } = require('./utils/datas');
const { formatarReais } = require('./utils/moeda');
const { CarrosselClient } = require('./integrations/carrossel/carrossel.client');
const { CarrosselMockClient } = require('./integrations/carrossel/carrossel.mock-client');
const { CarrosselService } = require('./integrations/carrossel/carrossel.service');
const { ArgusClient } = require('./integrations/argus/argus.client');
const { ArgusMockClient } = require('./integrations/argus/argus.mock-client');
const { DiretorioOperadores } = require('./integrations/argus/diretorio-operadores.service');
const { DiscadoraService } = require('./integrations/argus/discadora.service');
const { EstadoRepository } = require('./repositories/estado.repository');
const { CadastroRamaisRepository } = require('./repositories/cadastro-ramais.repository');
const { RoteamentoService } = require('./services/roteamento.service');
const { Agendador } = require('./services/agendador');
const { criarControllers } = require('./http/controllers');
const { criarServidor } = require('./http/server');
const { registrarDesligamento, fecharServidor, escutar } = require('./utils/ciclo-de-vida');

/**
 * Monta a camada da Argus (cliente, diretório de usuários e discadora).
 * Usada pelo roteador.
 */
function montarArgus(cfg, log) {
  const argusClient = cfg.usarMock
    ? new ArgusMockClient(log.filho('argus-mock'))
    : new ArgusClient(cfg.argus, log.filho('argus'));

  const diretorio = new DiretorioOperadores({
    client: argusClient,
    cfg: cfg.argus,
    excecoesRamal: new CadastroRamaisRepository({ arquivo: cfg.arquivoRamais, logger: log.filho('excecoes') }),
    arquivoSupervisoresGrupos: cfg.arquivoSupervisoresGrupos,
    logger: log.filho('diretorio'),
  });

  const discadora = new DiscadoraService({
    client: argusClient,
    cfg: cfg.argus,
    diretorio,
    respeitarGruposExternos: cfg.regras.respeitarGruposExternos,
    logger: log.filho('discadora'),
  });

  return { argusClient, diretorio, discadora };
}

/**
 * Cria a aplicação com todas as dependências conectadas.
 * @param {object} [overrides] - Sobrescritas de configuração (testes)
 */
function criarApp(overrides) {
  const cfg = carregarConfig(overrides);
  const log = criarLogger({ debug: cfg.debug });

  const relogio = { hoje: () => dataLocal(cfg.agenda.fusoHorario) };

  const carrosselClient = cfg.usarMock
    ? new CarrosselMockClient(log.filho('carrossel-mock'))
    : new CarrosselClient(cfg.carrossel, log.filho('carrossel'));
  const { argusClient, diretorio, discadora } = montarArgus(cfg, log);

  const roteamento = new RoteamentoService({
    carrossel: new CarrosselService({ client: carrosselClient, metrica: cfg.carrossel.metrica, logger: log.filho('carrossel') }),
    discadora,
    diretorio,
    repositorio: new EstadoRepository({ arquivo: cfg.arquivoEstado, logger: log.filho('estado') }),
    relogio,
    regras: cfg.regras,
    logger: log.filho('roteamento'),
  });

  const agendador = new Agendador({ roteamento, agenda: cfg.agenda, logger: log.filho('agendador') });
  const servidor = criarServidor({
    controllers: criarControllers({ roteamento, logger: log.filho('http') }),
    cfg: cfg.http,
    logger: log.filho('http'),
  });

  return { cfg, log, argusClient, diretorio, discadora, roteamento, agendador, servidor };
}

/** Loga avisos e encerra o processo se houver problema fatal na configuração. */
function exigirConfigValida(cfg, log) {
  const { fatais, avisos } = validarConfig(cfg);
  avisos.forEach((a) => log.aviso(a));
  if (!fatais.length) return;

  fatais.forEach((f) => log.erro(f));
  process.exit(1);
}

function logarResumo(cfg, log) {
  const carrossel = cfg.usarMock ? 'MOCK' : cfg.carrossel.baseUrl + cfg.carrossel.rotaRanking;
  const argus = (cfg.usarMock ? 'MOCK' : cfg.argus.baseUrl) + (cfg.argus.dryRun ? ' (DRY_RUN)' : '');
  log.info('Roteador de Vendas — Carrossel ↔ Argus');
  log.info(`Meta: ${formatarReais(cfg.regras.metaDiaria)} | Expediente: ${cfg.agenda.horarioCarga}–${cfg.agenda.horarioFim} | `
    + `Grupos Ativo: ${cfg.argus.gruposAtivosIds.join(',')} | URA: ${cfg.argus.grupoUraId} | `
    + `Carrossel: ${carrossel} (${cfg.carrossel.metrica}) | Argus: ${argus}`);
}

/** Pré-carrega o diretório e confere os grupos; a Argus fora do ar não impede o boot. */
async function aquecerArgus({ diretorio, discadora, log }) {
  try {
    await diretorio.atualizar({ forcar: true });
  } catch (e) {
    log.aviso(`${e.message}. O roteador seguirá tentando nos próximos ciclos.`);
  }
  await discadora.verificarGruposConfigurados();
}

/** Inicia a aplicação. Encerra o processo se a configuração for inválida. */
async function iniciar() {
  const app = criarApp();
  const { cfg, log, roteamento, agendador, servidor } = app;

  exigirConfigValida(cfg, log);
  logarResumo(cfg, log);

  roteamento.inicializar();
  await aquecerArgus(app);

  await escutar(servidor, cfg.http.porta);
  log.info(`HTTP na porta ${cfg.http.porta}: GET /health, GET /status, POST /recarregar, POST /webhook/venda`);

  agendador.iniciar();
  registrarDesligamento({
    logger: log,
    etapas: [
      () => agendador.parar(),
      () => fecharServidor(servidor),
      () => roteamento.repositorio.aguardarEscritas(),
    ],
  });
  return app;
}

module.exports = { criarApp, iniciar, montarArgus };
