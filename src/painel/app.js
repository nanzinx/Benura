'use strict';
/**
 * Composition root do painel da supervisão (benura-painel).
 *
 *   node painel.js      (PM2: benura-painel, porta PAINEL_PORT, padrão 3010)
 *
 * Uma página só com os controles da URA, a esteira manual, a saúde dos serviços
 * e o dia da URA. Não fala com a Argus: só com os outros serviços do BenURA (localhost),
 * com os logs do dia e, [NOVO] para os Liberados da URA, com o ranking do Carrossel (só leitura).
 */

const { carregarConfig, validarConfig, opcoesEmUso } = require('../config');
const { criarLogger } = require('../utils/logger');
const { ativarLogsEmArquivo } = require('../utils/logs-em-arquivo');
const { registrarDesligamento, fecharServidor, escutar } = require('../utils/ciclo-de-vida');
const { obterSegredo } = require('../utils/segredo-local');
const { Sessoes } = require('./sessoes');
const { Usuarios } = require('./usuarios');
const { Servicos } = require('./servicos');
const { VigiaIndicadores } = require('./vigia-indicadores');
const { DadosDoDia } = require('./dados-do-dia');
const { criarServidorDoPainel } = require('./servidor');
const { ControleAutomacao } = require('./automacao');
const { AgendaAutomacao } = require('./agenda-automacao');
const { Trava } = require('./trava');
const { Parceiro } = require('./parceiro');
const { criarExecutor } = require('../atualizador/executor');
const { criarNotificador } = require('../notificacoes');
const { textoDoResumo } = require('../notificacoes/resumo-do-dia');
const { VigiaSaude } = require('./vigia-saude');
const { LiberadosUra } = require('./liberados-ura');
const { FonteVendasCarrossel } = require('../integrations/vendas/fonte-carrossel');
const { CarrosselClient } = require('../integrations/carrossel/carrossel.client');
const { CarrosselMockClient } = require('../integrations/carrossel/carrossel.mock-client');
const { CarrosselService } = require('../integrations/carrossel/carrossel.service');
const { NotificadorWebhook } = require('../notificacoes/notificador-webhook');

/** Monta as dependências (nada é iniciado aqui). */
function montarPainel(overrides) {
  const cfg = carregarConfig(overrides);
  const log = criarLogger({ debug: cfg.debug, escopo: 'painel' });
  const p = cfg.painel;
  const servicos = new Servicos({ cfg: p, token: cfg.http.tokenAdmin });
  const usuarios = new Usuarios({ arquivo: p.arquivoUsuarios, logger: log }).carregar();
  const sessoes = new Sessoes({ senha: p.senha, segredo: obterSegredo(p), horas: p.sessaoHoras, usuarios });
  // [NOVO] Dois PCs (servidor e reserva): a trava na Cloudflare e o outro PC pela rede.
  const parceiro = new Parceiro({
    cfg: cfg.trava,
    arquivos: {
      usuarios: p.arquivoUsuarios,
      posse: cfg.automacao.posse.arquivo,
      dia: {
        modoRobos: cfg.rodizio.arquivoModoRobos,
        statusUra: cfg.rodizio.arquivoStatusUra,
        retencao: cfg.automacao.arquivoRetencao,
        travas: cfg.automacao.arquivoTravas,
      },
    },
    logger: log,
  });
  let automacao = null;
  const trava = new Trava({ cfg: cfg.trava, arquivoPosse: cfg.automacao.posse.arquivo, aoPerder: (motivo) => automacao?.pararPelaTrava(motivo), logger: log });
  automacao = new ControleAutomacao({
    cfg: { ...cfg.automacao, dryRunPeloEnv: cfg.argus.dryRunPeloEnv }, servicos, executar: criarExecutor({ cwd: cfg.atualizador.diretorio, logger: log }), logger: log,
    trava, parceiro,
  });
  // [NOVO] Avisos (log ou BenHub): serviço fora do ar, resumo das 18:00 e o "Testar envio".
  const notificador = criarNotificador({ cfg, logger: log });
  // [NOVO] Alertas de OPL alto e TOR subindo: lidos do mesmo /health que o vigia de saúde já busca.
  const indicadores = new VigiaIndicadores({ automacao, notificador, cfg: cfg.notificacoes.alertas, logger: log });
  const vigiaSaude = new VigiaSaude({ servicos, automacao, notificador, fuso: cfg.agenda.fusoHorario, logger: log, indicadores });
  const liberadosUra = montarLiberadosUra({ cfg, log, notificador });
  const servidor = criarServidorDoPainel({
    sessoes,
    notificador,
    liberadosUra,
    servicos,
    automacao,
    trava,
    parceiro,
    dados: new DadosDoDia({ pasta: cfg.logs.pasta, fuso: cfg.agenda.fusoHorario }),
    cfg: { fuso: cfg.agenda.fusoHorario, origensPermitidas: p.origensPermitidas, proxySegredo: p.proxySegredo, ipsPermitidos: p.ipsPermitidos },
    configuracao: retratoDaConfiguracao(cfg),
    logger: log,
  });
  const agenda = new AgendaAutomacao({
    automacao, cfg: { ...cfg.automacao.agenda, fuso: cfg.agenda.fusoHorario }, logger: log,
    aoFimDoDia: () => enviarResumoDoDia({ servicos, automacao, notificador, log }),
  });
  return { cfg, log, servidor, sessoes, trava, parceiro, automacao, agenda, vigiaSaude, notificador, liberadosUra };
}

/** [NOVO] Liberados da URA: as vendas do Carrossel (com a foto de cada dia) e, se configurado, o webhook do grupo. */
function montarLiberadosUra({ cfg, log, notificador }) {
  const lg = log.filho ? log.filho('liberados-ura') : log;
  // As novas tentativas do cliente vão para o debug: a foto de 10 em 10 min não enche o log do painel.
  const quieto = { ...lg, aviso: (m) => lg.debug?.(m) };
  const client = cfg.usarMock ? new CarrosselMockClient(quieto) : new CarrosselClient(cfg.carrossel, quieto);
  const carrossel = new CarrosselService({ client, metrica: cfg.carrossel.metrica, logger: lg });
  const c = cfg.liberadosUra;
  const fonte = new FonteVendasCarrossel({ carrossel, arquivo: c.arquivoVendas, fuso: cfg.agenda.fusoHorario, logger: lg });
  // O registro no log é o mesmo dos outros avisos (o NotificadorWebhook usa `registro` ou ele mesmo).
  const registro = notificador.registro ?? notificador;
  const grupo = c.webhook.url ? new NotificadorWebhook({ url: c.webhook.url, token: c.webhook.token, registro, logger: lg }) : null;
  return new LiberadosUra({ fonte, cfg: c, fuso: cfg.agenda.fusoHorario, logger: lg, grupo });
}

/** [NOVO] Às 18:00, antes de a agenda desligar: o relatório do dia (do rodízio, ainda no ar) vira aviso. */
async function enviarResumoDoDia({ servicos, automacao, notificador, log }) {
  if (!automacao.agindoDeVerdade()) return; // o reserva ou a simulação: quem manda é o PC que age
  const r = await servicos.chamar('rodizio', '/health');
  const relatorio = r.status === 200 ? r.corpo?.relatorio : null;
  if (!relatorio) {
    log.aviso('Resumo do dia: o rodízio não respondeu com o relatório; não saiu.');
    return;
  }
  await notificador.notificar({ titulo: 'BenURA: resumo do dia', texto: textoDoResumo(relatorio), nivel: 'info' });
}

const ESCOPOS = ['roteador', 'rodizio', 'rotinas', 'atualizador', 'painel'];

/**
 * [NOVO] "Configuração em uso" (aba Serviços): o que foi lido do .env quando o painel subiu.
 * Os outros serviços leem o mesmo .env; mudou, só vale depois de "npx pm2 restart all".
 */
function retratoDaConfiguracao(cfg) {
  const lidaEm = new Date().toISOString();
  const opcoes = opcoesEmUso();
  const avisos = [];
  for (const escopo of ESCOPOS) {
    const { fatais, avisos: soAvisos } = validarConfig(cfg, { escopo });
    for (const [nivel, textos] of [['fatal', fatais], ['aviso', soAvisos]]) {
      for (const texto of textos) {
        const ja = avisos.find((a) => a.texto === texto);
        if (ja) ja.servicos.push(escopo);
        else avisos.push({ nivel, texto, servicos: [escopo] });
      }
    }
  }
  return () => ({ lidaEm, opcoes, avisos });
}

async function iniciarPainel() {
  const { cfg, log, servidor, sessoes, trava, parceiro, automacao, agenda, vigiaSaude, liberadosUra } = montarPainel();
  ativarLogsEmArquivo(cfg, 'painel', {
    segredos: [cfg.argus?.token, cfg.http?.tokenAdmin, cfg.carrossel?.token, cfg.painel.senha, cfg.painel.proxySegredo, cfg.trava.segredo, cfg.trava.segredoLocal, cfg.trava.accessSegredo,
      cfg.notificacoes.webhook.url, cfg.notificacoes.webhook.token, cfg.liberadosUra.webhook.url, cfg.liberadosUra.webhook.token],
  });
  // Sem usuários nem senha o painel sobe assim mesmo (avisa na tela): o atualizador pode reiniciá-lo sem risco.
  validarConfig(cfg, { escopo: 'painel' }).avisos.forEach((a) => log.aviso(a));
  if (!sessoes.configurada) log.aviso('Nenhum usuário do painel ainda: rode "npm run usuarios -- criar" neste PC (ou coloque PAINEL_SENHA no .env para entrar uma vez e criar pelo painel).');
  else if (sessoes.emergencia) log.aviso('Painel sem usuários: vale a PAINEL_SENHA (acesso de emergência). Entre e crie os usuários em Serviços → Usuários.');

  await escutar(servidor, cfg.painel.porta);
  const lacoTrava = trava.iniciar(() => ({ deveAgir: automacao.agindoDeVerdade(), ocupado: Boolean(automacao.andamento) }));
  const lacoParceiro = parceiro.iniciar();
  const lacoAgenda = agenda.iniciar();
  const lacoSaude = vigiaSaude.iniciar();
  const pararLiberados = liberadosUra.iniciar();
  if (trava.ativa) log.info(`Dois PCs: este é o PC "${trava.nome}"; trava em ${cfg.trava.url}${parceiro.ativo ? `, outro PC em ${cfg.trava.parceiroUrl}` : ' (sem o outro PC configurado: os usuários não são copiados)'}.`);
  registrarDesligamento({ logger: log, etapas: [() => lacoTrava.parar(), () => lacoParceiro.parar(), () => lacoAgenda.parar(), () => lacoSaude.parar(), () => pararLiberados(), () => fecharServidor(servidor)] });
  log.info(`Painel da supervisão no ar: http://localhost:${cfg.painel.porta} (na rede: http://<IP deste PC>:${cfg.painel.porta}).`);
}

module.exports = { montarPainel, iniciarPainel };
