'use strict';
/**
 * Alinha a sessão de telefonia ao grupo em que o operador está vinculado.
 *
 * Mover de grupo quem JÁ ESTÁ LOGADO (pelo painel ou pelo transferiroperadorgrupo)
 * muda só a lista: a telefonia continua no grupo onde a pessoa logou até ela
 * relogar (visto na operação em 14/10/2026: na lista do RECEPTIVO - URA, mas
 * statusoperador.idGrupo = MAYSA - COMERCIAL, atendendo preditivo; depois de
 * deslogar e logar, ficou na URA). Na URA, isso faz a derivação dos robôs não
 * chegar na pessoa: o cliente espera na fila e vira callback.
 *
 * Aqui se faz o que o operador faria: logar de novo. O logaroperador sem
 * codIntegGrupo loga "no grupo já vinculado" (doc 4.5), que depois da
 * transferência é o destino. [NOVO] Nunca desloga ninguém: se logar de novo não
 * bastar, só avisa. Vem ligado (ALINHAR_LOGIN_APOS_TRANSFERIR=true): sem isso, a
 * telefonia não troca sozinha, e quem foi movido para a URA não recebe derivação.
 *
 * Só mexe em quem está LIVRE: em ligação ou em pausa, espera (quem chama tenta
 * de novo depois).
 */

const { esperar } = require('../../utils/http-client');

const Alinhamento = Object.freeze({
  OK: 'ok', // já logado no grupo certo
  DESLOGADO: 'deslogado', // ao logar, já cai no grupo vinculado
  AGUARDANDO: 'aguardando', // em ligação ou pausa: tentar quando estiver livre
  RELOGADO: 'relogado',
  OUTRO_VINCULO: 'outro vínculo', // relogou, mas o vínculo não é o esperado (lista desatualizada?)
  FALHOU: 'falhou',
  SIMULADO: 'simulado', // DRY_RUN
});

const LIVRE = /livre|dispon/i;

const estaLivre = (s) => LIVRE.test(String(s.descricaoStatus || '')) && !s.descricaoPausa;
const mesmoGrupo = (s, idGrupo) => s != null && s.idGrupo != null && Number(s.idGrupo) === Number(idGrupo);
const nomeDoGrupo = (s) => (s.grupo ? `"${s.grupo}" (${s.idGrupo})` : `grupo ${s.idGrupo}`);

/** Loga e relê: @returns {Promise<object|null>} status depois do login */
async function logarERelere(client, ramal, esperaMs) {
  await client.logarOperador(ramal);
  await esperar(esperaMs);
  return client.statusOperador(ramal);
}

/** Só loga de novo (nunca desloga): se a sessão não sair do lugar, avisa. */
async function relogar({ client, ramal, idGrupo, antes, esperaMs }) {
  const depois = await logarERelere(client, ramal, esperaMs);
  if (mesmoGrupo(depois, idGrupo)) return Alinhamento.RELOGADO;
  if (depois && !mesmoGrupo(depois, antes.idGrupo)) return Alinhamento.OUTRO_VINCULO;
  return Alinhamento.FALHOU;
}

/**
 * @param {object} p
 * @param {{ statusOperador, logarOperador }} p.client
 * @param {string} p.ramal
 * @param {number} p.idGrupo - grupo em que a pessoa acabou de ser colocada
 * @param {boolean} [p.dryRun]
 * @param {object} p.log
 * @param {number} [p.esperaMs] - tempo para a Argus refletir o login
 * @returns {Promise<string>} um valor de Alinhamento
 */
async function alinharLogin({ client, ramal, idGrupo, dryRun = false, log, esperaMs = 1500 }) {
  try {
    const antes = await client.statusOperador(ramal);
    if (!antes) return Alinhamento.DESLOGADO;
    if (mesmoGrupo(antes, idGrupo)) return Alinhamento.OK;
    if (!estaLivre(antes)) return Alinhamento.AGUARDANDO;
    if (dryRun) {
      log.info(`[DRY_RUN] Relogaria ramal ${ramal} no grupo ${idGrupo} (hoje logado em ${nomeDoGrupo(antes)}).`);
      return Alinhamento.SIMULADO;
    }

    const resultado = await relogar({ client, ramal, idGrupo, antes, esperaMs });
    logarResultado(log, ramal, idGrupo, antes, resultado);
    return resultado;
  } catch (e) {
    log.aviso(`Não foi possível relogar o ramal ${ramal} no grupo ${idGrupo}: ${e.message}. Peça para ele deslogar e logar.`);
    return Alinhamento.FALHOU;
  }
}

function logarResultado(log, ramal, idGrupo, antes, resultado) {
  if (resultado === Alinhamento.RELOGADO) {
    log.info(`Ramal ${ramal} relogado no grupo ${idGrupo} (estava logado em ${nomeDoGrupo(antes)}).`);
    return;
  }
  const motivo = resultado === Alinhamento.OUTRO_VINCULO ? 'relogou, mas em outro grupo (a lista mudou?)' : 'a telefonia não mudou de grupo';
  log.aviso(`Ramal ${ramal} não ficou logado no grupo ${idGrupo}: ${motivo}. A telefonia troca quando ele ficar livre (o BenURA não desloga ninguém).`);
}

module.exports = { alinharLogin, Alinhamento };
