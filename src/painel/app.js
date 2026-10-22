'use strict';
/**
 * Composition root do painel da supervisão (benura-painel).
 *
 *   node painel.js      (PM2: benura-painel, porta PAINEL_PORT, padrão 3010)
 *
 * Uma página só com os controles da URA, a esteira manual, a saúde dos serviços
 * e o dia da URA. Não fala com a Argus nem com o Carrossel: só com os outros
 * serviços do BenURA (localhost) e com os logs do dia.
 */

const { carregarConfig, validarConfig } = require('../config');
const { criarLogger } = require('../utils/logger');
const { ativarLogsEmArquivo } = require('../utils/logs-em-arquivo');
const { registrarDesligamento, fecharServidor, escutar } = require('../utils/ciclo-de-vida');
const { obterSegredo } = require('../utils/segredo-local');
const { Sessoes } = require('./sessoes');
const { Servicos } = require('./servicos');
const { DadosDoDia } = require('./dados-do-dia');
const { criarServidorDoPainel } = require('./servidor');
const { ControleAutomacao } = require('./automacao');
const { criarExecutor } = require('../atualizador/executor');

/** Monta as dependências (nada é iniciado aqui). */
function montarPainel(overrides) {
  const cfg = carregarConfig(overrides);
  const log = criarLogger({ debug: cfg.debug, escopo: 'painel' });
  const p = cfg.painel;
  const servicos = new Servicos({ cfg: p, token: cfg.http.tokenAdmin });
  const servidor = criarServidorDoPainel({
    sessoes: new Sessoes({ senha: p.senha, segredo: obterSegredo(p), horas: p.sessaoHoras }),
    servicos,
    automacao: new ControleAutomacao({
      cfg: { ...cfg.automacao, dryRunPeloEnv: cfg.argus.dryRunPeloEnv }, servicos, executar: criarExecutor({ cwd: cfg.atualizador.diretorio, logger: log }), logger: log,
    }),
    dados: new DadosDoDia({ pasta: cfg.logs.pasta, fuso: cfg.agenda.fusoHorario }),
    cfg: { fuso: cfg.agenda.fusoHorario, origensPermitidas: p.origensPermitidas, proxySegredo: p.proxySegredo },
    logger: log,
  });
  return { cfg, log, servidor };
}

async function iniciarPainel() {
  const { cfg, log, servidor } = montarPainel();
  ativarLogsEmArquivo(cfg, 'painel', { segredos: [cfg.argus?.token, cfg.http?.tokenAdmin, cfg.carrossel?.token, cfg.painel.senha, cfg.painel.proxySegredo] });
  // Sem a senha o painel sobe assim mesmo (avisa na tela): o atualizador pode reiniciá-lo sem risco.
  validarConfig(cfg, { escopo: 'painel' }).avisos.forEach((a) => log.aviso(a));

  await escutar(servidor, cfg.painel.porta);
  registrarDesligamento({ logger: log, etapas: [() => fecharServidor(servidor)] });
  log.info(`Painel da supervisão no ar: http://localhost:${cfg.painel.porta} (na rede: http://<IP deste PC>:${cfg.painel.porta}).`);
}

module.exports = { montarPainel, iniciarPainel };
