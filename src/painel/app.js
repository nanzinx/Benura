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

const { carregarConfig, validarConfig, opcoesEmUso } = require('../config');
const { criarLogger } = require('../utils/logger');
const { ativarLogsEmArquivo } = require('../utils/logs-em-arquivo');
const { registrarDesligamento, fecharServidor, escutar } = require('../utils/ciclo-de-vida');
const { obterSegredo } = require('../utils/segredo-local');
const { Sessoes } = require('./sessoes');
const { Usuarios } = require('./usuarios');
const { Servicos } = require('./servicos');
const { DadosDoDia } = require('./dados-do-dia');
const { criarServidorDoPainel } = require('./servidor');
const { ControleAutomacao } = require('./automacao');
const { AgendaAutomacao } = require('./agenda-automacao');
const { Trava } = require('./trava');
const { Parceiro } = require('./parceiro');
const { criarExecutor } = require('../atualizador/executor');

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
  const servidor = criarServidorDoPainel({
    sessoes,
    servicos,
    automacao,
    trava,
    parceiro,
    dados: new DadosDoDia({ pasta: cfg.logs.pasta, fuso: cfg.agenda.fusoHorario }),
    cfg: { fuso: cfg.agenda.fusoHorario, origensPermitidas: p.origensPermitidas, proxySegredo: p.proxySegredo },
    configuracao: retratoDaConfiguracao(cfg),
    logger: log,
  });
  const agenda = new AgendaAutomacao({ automacao, cfg: { ...cfg.automacao.agenda, fuso: cfg.agenda.fusoHorario }, logger: log });
  return { cfg, log, servidor, sessoes, trava, parceiro, automacao, agenda };
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
  const { cfg, log, servidor, sessoes, trava, parceiro, automacao, agenda } = montarPainel();
  ativarLogsEmArquivo(cfg, 'painel', { segredos: [cfg.argus?.token, cfg.http?.tokenAdmin, cfg.carrossel?.token, cfg.painel.senha, cfg.painel.proxySegredo, cfg.trava.segredo, cfg.trava.segredoLocal, cfg.trava.accessSegredo] });
  // Sem usuários nem senha o painel sobe assim mesmo (avisa na tela): o atualizador pode reiniciá-lo sem risco.
  validarConfig(cfg, { escopo: 'painel' }).avisos.forEach((a) => log.aviso(a));
  if (!sessoes.configurada) log.aviso('Nenhum usuário do painel ainda: rode "npm run usuarios -- criar" neste PC (ou coloque PAINEL_SENHA no .env para entrar uma vez e criar pelo painel).');
  else if (sessoes.emergencia) log.aviso('Painel sem usuários: vale a PAINEL_SENHA (acesso de emergência). Entre e crie os usuários em Serviços → Usuários.');

  await escutar(servidor, cfg.painel.porta);
  const lacoTrava = trava.iniciar(() => ({ deveAgir: automacao.agindoDeVerdade(), ocupado: Boolean(automacao.andamento) }));
  const lacoParceiro = parceiro.iniciar();
  const lacoAgenda = agenda.iniciar();
  if (trava.ativa) log.info(`Dois PCs: este é o PC "${trava.nome}"; trava em ${cfg.trava.url}${parceiro.ativo ? `, outro PC em ${cfg.trava.parceiroUrl}` : ' (sem o outro PC configurado: os usuários não são copiados)'}.`);
  registrarDesligamento({ logger: log, etapas: [() => lacoTrava.parar(), () => lacoParceiro.parar(), () => lacoAgenda.parar(), () => fecharServidor(servidor)] });
  log.info(`Painel da supervisão no ar: http://localhost:${cfg.painel.porta} (na rede: http://<IP deste PC>:${cfg.painel.porta}).`);
}

module.exports = { montarPainel, iniciarPainel };
