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
const { DiscadoraService } = require('./integrations/argus/discadora.service');
const { EstadoRepository } = require('./repositories/estado.repository');
const { CadastroRamaisRepository } = require('./repositories/cadastro-ramais.repository');
const { RoteamentoService } = require('./services/roteamento.service');
const { Agendador } = require('./services/agendador');
const { criarControllers } = require('./http/controllers');
const { criarServidor } = require('./http/server');

/**
 * Cria a aplicação com todas as dependências conectadas.
 * @param {object} [overrides] - Sobrescritas de configuração (testes)
 */
function criarApp(overrides) {
  const cfg = carregarConfig(overrides);
  const log = criarLogger({ debug: cfg.debug });

  const relogio = { hoje: () => dataLocal(cfg.agenda.fusoHorario) };

  const carrosselClient = cfg.carrossel.usarMock
    ? new CarrosselMockClient(log.filho('carrossel-mock'))
    : new CarrosselClient(cfg.carrossel, log.filho('carrossel'));
  const cadastro = new CadastroRamaisRepository({ arquivo: cfg.arquivoRamais, logger: log.filho('cadastro') });

  const discadora = new DiscadoraService({
    client: new ArgusClient(cfg.argus, log.filho('argus')),
    cfg: cfg.argus,
    respeitarGruposExternos: cfg.regras.respeitarGruposExternos,
    logger: log.filho('discadora'),
  });

  const roteamento = new RoteamentoService({
    carrossel: new CarrosselService({
      client: carrosselClient, cadastro, metrica: cfg.carrossel.metrica, logger: log.filho('carrossel'),
    }),
    discadora,
    cadastro,
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

  return { cfg, log, discadora, roteamento, agendador, servidor };
}

/** Inicia a aplicação. Encerra o processo se a configuração for inválida. */
async function iniciar() {
  const app = criarApp();
  const { cfg, log, discadora, roteamento, agendador, servidor } = app;

  const { fatais, avisos } = validarConfig(cfg);
  avisos.forEach((a) => log.aviso(a));
  if (fatais.length) {
    fatais.forEach((f) => log.erro(f));
    process.exit(1);
  }

  log.info('Roteador de Vendas — Carrossel ↔ Argus');
  log.info(`Meta: ${formatarReais(cfg.regras.metaDiaria)} | Expediente: ${cfg.agenda.horarioCarga}–${cfg.agenda.horarioFim} | `
    + `Carrossel: ${cfg.carrossel.usarMock ? 'MOCK' : cfg.carrossel.baseUrl + cfg.carrossel.rotaRanking} (${cfg.carrossel.metrica}) | Argus: ${cfg.argus.dryRun ? 'DRY_RUN' : cfg.argus.baseUrl}`);

  roteamento.inicializar();
  roteamento.cadastro.atualizar();
  await discadora.verificarGruposConfigurados();

  await new Promise((resolve, reject) => {
    servidor.once('error', reject);
    servidor.listen(cfg.http.porta, resolve);
  });
  log.info(`HTTP na porta ${cfg.http.porta}: GET /health, GET /status, POST /recarregar, POST /webhook/venda`);

  agendador.iniciar();
  registrarDesligamento(app);
  return app;
}

function registrarDesligamento({ log, agendador, servidor, roteamento }) {
  let encerrando = false;
  const encerrar = async (motivo, codigo = 0) => {
    if (encerrando) return;
    encerrando = true;
    log.info(`Encerrando (${motivo})...`);

    // Força saída se algo travar no desligamento.
    setTimeout(() => process.exit(codigo || 1), 10_000).unref();
    try {
      await agendador.parar();
      await new Promise((r) => servidor.close(r));
      await roteamento.repositorio.aguardarEscritas();
      log.info('Estado salvo. Até logo.');
    } catch (e) {
      log.erro('Erro durante o desligamento:', e);
    }
    process.exit(codigo);
  };

  process.on('SIGINT', () => encerrar('SIGINT'));
  process.on('SIGTERM', () => encerrar('SIGTERM'));
  process.on('uncaughtException', (e) => {
    log.erro('Exceção não tratada:', e);
    encerrar('uncaughtException', 1);
  });
  process.on('unhandledRejection', (e) => log.erro('Promise rejeitada não tratada:', e));
}

module.exports = { criarApp, iniciar };
