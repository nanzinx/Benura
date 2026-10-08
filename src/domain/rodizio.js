'use strict';
/**
 * Regras do rodízio Ativo ↔ URA e do controle de robôs — funções puras, sem I/O.
 *
 *  1. IDA PARA A URA: operador do Ativo que ATENDEU uma ligação e ficou LIVRE
 *     vai para a URA (rodízio). Se ficar offline, perde o histórico.
 *  2. VOLTA AO ATIVO: depois de TEMPO_MIN na URA (e fora de atendimento), ou
 *     imediatamente se ficar offline, volta ao grupo de origem.
 *  3. ROBÔS: desligados quando ninguém na URA pode atender (todos ocupados,
 *     URA vazia/offline, ou a Argus sem visibilidade); religados quando algum
 *     humano fica livre de novo.
 */

/** Classes de status de operador. */
const Classe = Object.freeze({
  OFFLINE: 'offline',
  ATENDIMENTO: 'atendimento',
  LIVRE: 'livre',
  OUTRO: 'outro', // pausa, tabulação, almoço...
  ERRO: 'erro', // a Argus não respondeu
});

/** Ações sobre os robôs da URA. */
const AcaoRobos = Object.freeze({ DESLIGAR: 'DESLIGAR', RELIGAR: 'RELIGAR', NENHUMA: 'NENHUMA' });

/** Estados conhecidos dos robôs. */
const EstadoRobos = Object.freeze({ LIGADOS: 'on', DESLIGADOS: 'off', DESCONHECIDO: 'unknown' });

/** Status mais antigo que isso indica que a Argus parou de responder. */
const VALIDADE_STATUS_MS = 6000;

/** Tempo de carência antes de considerar que um movido sumiu da URA. */
const CARENCIA_AUSENCIA_MS = 60_000;

/** Quantas verificações seguidas fora da URA até esquecer o movido. */
const AUSENCIAS_PARA_ESQUECER = 2;

/**
 * Classifica o status de um operador.
 * @param {object|null} status - statusOperador da Argus (null = não logado)
 * @param {{ livres: string[], atendimento: string[] }} descricoes - descricaoStatus aceitas (minúsculas)
 */
function classificarStatus(status, { livres, atendimento }) {
  if (!status) return Classe.OFFLINE;
  const descricao = String(status.descricaoStatus || '').trim().toLowerCase();
  if (atendimento.includes(descricao)) return Classe.ATENDIMENTO;
  if (livres.includes(descricao) && !status.descricaoPausa) return Classe.LIVRE;
  return Classe.OUTRO;
}

/** Regra 1: atendeu no Ativo e agora está livre. */
const deveIrParaUra = (classe, atendeuNoAtivo) => classe === Classe.LIVRE && atendeuNoAtivo;

/** Regra 2: tempo cumprido fora de atendimento, ou ficou offline. */
function deveVoltarAoAtivo({ movido, classe, agora, tempoNaUraMs }) {
  if (classe === Classe.OFFLINE) return true;
  return agora - movido.entrouEm >= tempoNaUraMs && classe !== Classe.ATENDIMENTO;
}

/** Motivo da volta, para o log. */
const motivoDaVolta = (classe) => (classe === Classe.OFFLINE ? 'offline' : 'tempo expirado');

/**
 * Regra 3: o que fazer com os robôs agora.
 *
 * @param {object} entrada
 * @param {string[]} entrada.ramaisUra - Humanos que estão na URA
 * @param {Map<string, { classe: string, ts: number }>} entrada.status
 * @param {number} entrada.agora
 * @param {{ estado: string, desligadosDesde: number }} entrada.robos
 * @param {{ reativar: boolean, minDesligadoMs: number }} entrada.cfg
 * @returns {{ acao: string, motivo: string }}
 */
function decidirRobos({ ramaisUra, status, agora, robos, cfg }) {
  const desligar = (motivo) => ({
    acao: robos.estado === EstadoRobos.DESLIGADOS ? AcaoRobos.NENHUMA : AcaoRobos.DESLIGAR,
    motivo,
  });

  const semVisibilidade = ramaisUra.some((r) => {
    const info = status.get(r);
    return !info || info.classe === Classe.ERRO || agora - info.ts > VALIDADE_STATUS_MS;
  });
  if (semVisibilidade) return desligar('sem visibilidade da Argus');

  const humanos = ramaisUra.filter((r) => status.get(r).classe !== Classe.OFFLINE);
  if (!humanos.length) return desligar('URA vazia ou com todos offline');

  const algumLivre = humanos.some((r) => status.get(r).classe === Classe.LIVRE);
  if (!algumLivre) return desligar('nenhum humano livre na URA');

  const podeReligar = cfg.reativar
    && robos.estado === EstadoRobos.DESLIGADOS
    && agora - robos.desligadosDesde >= cfg.minDesligadoMs;
  return podeReligar
    ? { acao: AcaoRobos.RELIGAR, motivo: 'há humano livre na URA' }
    : { acao: AcaoRobos.NENHUMA, motivo: 'há humano livre na URA' };
}

/**
 * Esquece movidos que saíram da URA por fora do rodízio (ex.: alguém os
 * transferiu à mão), depois de uma carência e de verificações seguidas.
 *
 * @param {Record<string, { origemGrupoId: number, entrouEm: number, ausentes?: number }>} movidos
 * @param {Set<string>} ramaisNaUra
 * @param {number} agora
 * @returns {{ movidos: object, esquecidos: string[] }} novo objeto (o original não é alterado)
 */
function reconciliarMovidos(movidos, ramaisNaUra, agora) {
  const resultado = {};
  const esquecidos = [];

  for (const [ramal, movido] of Object.entries(movidos)) {
    if (ramaisNaUra.has(ramal)) {
      resultado[ramal] = { ...movido, ausentes: 0 };
      continue;
    }
    if (agora - movido.entrouEm < CARENCIA_AUSENCIA_MS) {
      resultado[ramal] = movido;
      continue;
    }

    const ausentes = (movido.ausentes || 0) + 1;
    if (ausentes >= AUSENCIAS_PARA_ESQUECER) {
      esquecidos.push(ramal);
      continue;
    }
    resultado[ramal] = { ...movido, ausentes };
  }
  return { movidos: resultado, esquecidos };
}

/**
 * Interpreta um webhook da Argus.
 * Início de atendimento (tipo 1) ou fim de URA receptiva com derivação para
 * humano (tipo 5, conclusão 1) indicam que o operador está atendendo.
 *
 * A documentação escreve o campo como "idConclusaoDerivacao" na tabela e como
 * "FidConclusaoDerivacao" no exemplo do tipo 5; aceitamos os dois.
 *
 * @returns {{ ramal: string }|null} operador em atendimento, ou null se o evento não interessa
 */
function interpretarWebhook(evento) {
  const ramal = evento?.codUsuarioIntegracao;
  if (!ramal) return null;

  const conclusao = evento.idConclusaoDerivacao ?? evento.FidConclusaoDerivacao;
  const inicioAtendimento = evento.idTipoWebhook === 1;
  const derivouDaUra = evento.idTipoWebhook === 5 && conclusao === 1;
  return inicioAtendimento || derivouDaUra ? { ramal: String(ramal) } : null;
}

/** Robô respondeu que já estava deslogado: para nós, é sucesso. */
function jaEstavaDeslogado(descricao) {
  const d = String(descricao || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  return d.includes('ja deslogado') || d.includes('nao esta logado');
}

module.exports = {
  Classe,
  AcaoRobos,
  EstadoRobos,
  VALIDADE_STATUS_MS,
  classificarStatus,
  deveIrParaUra,
  deveVoltarAoAtivo,
  motivoDaVolta,
  decidirRobos,
  reconciliarMovidos,
  interpretarWebhook,
  jaEstavaDeslogado,
};
