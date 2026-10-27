'use strict';
/**
 * Automação desligada pelo painel (botão "Desligar automação").
 *
 * Um arquivo (AUTOMACAO_FILE, state-automacao.json) diz se a automação está
 * desligada. O painel grava; roteador, rodízio e rotinas leem ao subir e, se
 * estiver desligada, esperam sem tocar na Argus até alguém religar pelo painel.
 * Assim, reiniciar o PC, um `pm2 start all` ou o atualizador não religam nada.
 *
 * Também guarda o botão "Modo simulação" (SIMULACAO_FILE): ligado, os serviços
 * sobem em DRY_RUN (veja config/index.js), mesmo com DRY_RUN=0 no .env.
 *
 * [NOVO] Cada componente (roteador, rodízio, rotinas) também pode ser desligado
 * sozinho pelo painel: `componentes` no mesmo arquivo. Um arquivo antigo, sem o
 * campo, quer dizer tudo ligado. Regra única: componenteAtivo().
 */

const { lerJson } = require('./arquivo-json');
const { ArquivoDeEstado } = require('./persistencia-json');
const { dataLocal } = require('./datas');
const { posseValida } = require('./posse');

/** Os componentes que o painel desliga sozinhos (o app do PM2 de cada serviço). */
const COMPONENTES = ['benura-roteador', 'benura-rodizio', 'benura-rotinas'];

/** Só os desligados, com quando e quem. */
function lerComponentes(dados) {
  const lista = dados?.componentes && typeof dados.componentes === 'object' ? dados.componentes : {};
  return Object.fromEntries(Object.entries(lista)
    .filter(([app, c]) => COMPONENTES.includes(app) && c?.desligado === true)
    .map(([app, c]) => [app, { desligado: true, desde: c.desde ?? null, por: c.por ?? null }]));
}

/**
 * @returns {{ desligada: boolean, desde: string|null, por: string|null,
 *            componentes: Record<string, { desligado: true, desde: string|null, por: string|null }> }}
 */
function lerAutomacao(arquivo) {
  const { dados } = lerJson(arquivo);
  const componentes = lerComponentes(dados);
  if (!dados?.desligada) return { desligada: false, desde: null, por: null, componentes };
  return { desligada: true, desde: dados.desde ?? null, por: dados.por ?? null, componentes };
}

/** [NOVO] Regra única: o componente roda se a automação está ligada E ele não foi desligado à mão. */
function componenteAtivo(estado, app) {
  return !estado.desligada && !estado.componentes?.[app]?.desligado;
}

/** Grava (atômico). @returns {Promise<void>} */
function gravarAutomacao(arquivo, estado, logger) {
  const repositorio = new ArquivoDeEstado({ arquivo, logger });
  repositorio.salvar(estado);
  return repositorio.aguardar();
}

/** Botão "Modo simulação": escolha gravada pelo painel. @returns {{ ligada: boolean, desde: string|null, por: string|null }} */
function lerSimulacao(arquivo) {
  const { dados } = lerJson(arquivo);
  return { ligada: dados?.ligada === true, desde: dados?.desde ?? null, por: dados?.por ?? null };
}

const esperarMs = (ms) => new Promise((r) => { setTimeout(r, ms); });

/**
 * Se a automação estiver desligada, espera (conferindo a cada `intervaloMs`)
 * até ser religada. [NOVO] Com a trava dos dois PCs, espera também a posse
 * (utils/posse.js). Avisa uma vez no log.
 * @param {{ arquivo: string, intervaloMs?: number, posse?: object }} cfg - cfg.automacao
 */
async function aguardarAutomacaoLigada(cfg, log, servico, { esperar = esperarMs, app = null } = {}) {
  let estado = lerAutomacao(cfg.arquivo);
  const parado = (e) => (app ? !componenteAtivo(e, app) : e.desligada);
  if (parado(estado)) {
    const proprio = !estado.desligada && app ? estado.componentes[app] : null;
    if (proprio) {
      log.aviso(`${servico[0].toUpperCase()}${servico.slice(1)} desligado pelo painel${proprio.desde ? ` em ${proprio.desde}` : ''}${proprio.por ? ` (${proprio.por})` : ''}: `
        + `espera, sem mexer na Argus. Para ligar, use "Ligar" no cartão dele (aba Serviços).`);
    } else {
      log.aviso(`Automação desligada pelo painel${estado.desde ? ` em ${estado.desde}` : ''}${estado.por ? ` (${estado.por})` : ''}: `
        + `o ${servico} espera, sem mexer na Argus. Para religar, use "Religar automação" no painel.`);
    }
    while (parado(estado)) {
      await esperar(cfg.intervaloMs ?? 5000);
      estado = lerAutomacao(cfg.arquivo);
    }
    log.aviso(`Automação religada pelo painel: o ${servico} está iniciando.`);
  }
  if (posseValida(cfg.posse)) return;
  log.aviso(`Trava dos dois PCs: este PC não está com ela (o outro PC pode estar agindo, ou o painel ainda não pegou): `
    + `o ${servico} espera, sem mexer na Argus.`);
  while (!posseValida(cfg.posse)) await esperar(cfg.intervaloMs ?? 5000);
  log.aviso(`Trava dos dois PCs: posse confirmada, o ${servico} está iniciando.`);
}

/**
 * [NOVO] "Alocar Todos no Ativo" segura todo mundo no Ativo até alguém clicar em
 * "Retomar rodízio da URA" (RETENCAO_ATIVO_FILE). O rodízio grava; o roteador lê
 * antes de subir alguém para a URA. Não vira com o dia: vale até retomarem.
 * @returns {{ ativa: boolean, desde: string|null, por: string|null }}
 */
function lerRetencao(arquivo) {
  const { dados } = lerJson(arquivo);
  if (dados?.ativa !== true) return { ativa: false, desde: null, por: null };
  return { ativa: true, desde: dados.desde ?? null, por: dados.por ?? null };
}

/**
 * [NOVO] Travas manuais do painel (TRAVAS_MANUAIS_FILE): quem a supervisão mexeu à
 * mão fica onde foi posto até liberarem ou virar o dia. O rodízio grava; o roteador
 * lê para não subir a venda de quem está travado no Ativo.
 * @returns {(ramal: string) => 'ativo'|'ura'|null}
 */
function lerTravas(arquivo, fusoHorario, agora = new Date()) {
  const { dados } = lerJson(arquivo);
  const ramais = dados?.dia && dados.dia === dataLocal(fusoHorario, agora) && dados.ramais ? dados.ramais : {};
  return (ramal) => ramais[String(ramal)]?.onde ?? null;
}

module.exports = { COMPONENTES, componenteAtivo, lerAutomacao, gravarAutomacao, aguardarAutomacaoLigada, lerSimulacao, lerRetencao, lerTravas };
