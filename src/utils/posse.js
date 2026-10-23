'use strict';
/**
 * [NOVO] Posse da trava dos dois PCs (servidor e reserva), para os serviços.
 *
 * O painel segura a trava na Cloudflare (src/painel/trava.js) e, a cada renovação
 * que dá certo, grava aqui a hora (POSSE_FILE, state-posse.json). Roteador, rodízio
 * e rotinas só agem de verdade com uma posse recente (POSSE_MAX_MS):
 *  - ao subir, esperam por ela (junto com "automação desligada", utils/automacao.js);
 *  - rodando, um vigia confere a cada 10 s e, com a posse velha, encerra o serviço.
 *    O PM2 sobe de novo e ele fica esperando. É o último recurso: o painel já
 *    desliga os robôs em ordem antes.
 * Em DRY_RUN (simulação) não precisa: os dois PCs podem simular juntos.
 */

const fs = require('fs');
const path = require('path');
const { lerJson } = require('./arquivo-json');

/**
 * @returns {{ dono: string|null, renovadaEm: string|null, ultimaPosse: string|null }}
 *          ultimaPosse: a última vez que este PC esteve com a trava (decide de quem copiar o estado do dia)
 */
function lerPosse(arquivo) {
  const { dados } = lerJson(arquivo);
  return { dono: dados?.dono ?? null, renovadaEm: dados?.renovadaEm ?? null, ultimaPosse: dados?.ultimaPosse ?? dados?.renovadaEm ?? null };
}

/** Gravação síncrona e atômica (o vigia de outro processo pode ler a qualquer hora). */
function escrever(arquivo, dados) {
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const tmp = `${arquivo}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(dados));
  fs.renameSync(tmp, arquivo);
}

function gravarPosse(arquivo, dono, agora = new Date()) {
  escrever(arquivo, { dono, renovadaEm: agora.toISOString(), ultimaPosse: agora.toISOString() });
}

/** Sem posse: os serviços param de agir (o vigia encerra, e na subida esperam). Guarda a última posse. */
function apagarPosse(arquivo) {
  const { ultimaPosse } = lerPosse(arquivo);
  escrever(arquivo, { dono: null, renovadaEm: null, ultimaPosse });
}

/**
 * @param {{ exigir: boolean, arquivo: string, maxMs: number }} posse - cfg.automacao.posse
 * @returns {boolean} pode agir de verdade agora?
 */
function posseValida(posse, agora = Date.now()) {
  if (!posse?.exigir) return true;
  const { renovadaEm } = lerPosse(posse.arquivo);
  const idade = renovadaEm ? agora - new Date(renovadaEm).getTime() : Infinity;
  return idade >= 0 && idade <= posse.maxMs;
}

/**
 * Encerra o serviço (SIGTERM: o desligamento de sempre) se a posse ficar velha. O PM2 sobe de novo e ele espera.
 * @returns {{ parar: () => void }}
 */
function vigiarPosse(posse, log, servico, { intervaloMs = 10_000, sair = () => process.kill(process.pid, 'SIGTERM'), agora = Date.now } = {}) {
  if (!posse?.exigir) return { parar: () => {} };
  const timer = setInterval(() => {
    if (posseValida(posse, agora())) return;
    log.erro(`Trava dos dois PCs: o ${servico} perdeu a posse (o painel não renova há mais de ${Math.round(posse.maxMs / 1000)} s). `
      + 'Encerrando para não agir junto com o outro PC; ele volta e espera a trava.');
    clearInterval(timer);
    sair(); // desligamento normal (salva o estado e solta as travas locais)
  }, intervaloMs);
  timer.unref?.();
  return { parar: () => clearInterval(timer) };
}

module.exports = { lerPosse, gravarPosse, apagarPosse, posseValida, vigiarPosse };
