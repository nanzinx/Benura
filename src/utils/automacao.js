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
 */

const { lerJson } = require('./arquivo-json');
const { ArquivoDeEstado } = require('./persistencia-json');

/** @returns {{ desligada: boolean, desde: string|null, por: string|null }} */
function lerAutomacao(arquivo) {
  const { dados } = lerJson(arquivo);
  if (!dados?.desligada) return { desligada: false, desde: null, por: null };
  return { desligada: true, desde: dados.desde ?? null, por: dados.por ?? null };
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
 * até ser religada. Avisa uma vez no log.
 * @param {{ arquivo: string, intervaloMs?: number }} cfg - cfg.automacao
 */
async function aguardarAutomacaoLigada(cfg, log, servico, { esperar = esperarMs } = {}) {
  let estado = lerAutomacao(cfg.arquivo);
  if (!estado.desligada) return;
  log.aviso(`Automação desligada pelo painel${estado.desde ? ` em ${estado.desde}` : ''}${estado.por ? ` (${estado.por})` : ''}: `
    + `o ${servico} espera, sem mexer na Argus. Para religar, use "Religar automação" no painel.`);
  while (estado.desligada) {
    await esperar(cfg.intervaloMs ?? 5000);
    estado = lerAutomacao(cfg.arquivo);
  }
  log.aviso(`Automação religada pelo painel: o ${servico} está iniciando.`);
}

module.exports = { lerAutomacao, gravarAutomacao, aguardarAutomacaoLigada, lerSimulacao };
