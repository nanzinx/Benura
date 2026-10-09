'use strict';
/**
 * Regras do rodízio Ativo ↔ URA e do controle de robôs — funções puras, sem I/O.
 *
 *  1. IDA PARA A URA: operador do Ativo que ATENDEU uma ligação e ficou LIVRE
 *     vai para a URA (rodízio). Se ficar offline, perde o histórico.
 *  2. VOLTA AO ATIVO: depois de TEMPO_MIN na URA (e fora de atendimento), ou
 *     imediatamente se ficar offline, volta ao grupo de origem.
 *  3. ROBÔS: ligados em proporção aos humanos livres na URA (ROBOS_POR_LIVRE
 *     por livre); todos desligados quando ninguém na URA pode atender (todos
 *     ocupados, URA vazia/offline, ou a Argus sem visibilidade).
 */

/** Classes de status de operador. */
const Classe = Object.freeze({
  OFFLINE: 'offline',
  ATENDIMENTO: 'atendimento',
  LIVRE: 'livre',
  OUTRO: 'outro', // pausa, tabulação, almoço...
  ERRO: 'erro', // a Argus não respondeu
});

/** Ações sobre os robôs da URA: DESLIGAR = reduzir (até 0), RELIGAR = aumentar até o alvo. */
const AcaoRobos = Object.freeze({ DESLIGAR: 'DESLIGAR', RELIGAR: 'RELIGAR', NENHUMA: 'NENHUMA' });

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
 * Regra 3a: quantos robôs devem estar ligados agora.
 *
 * Proporcional aos humanos LIVRES na URA: cada livre "segura" `porLivre` robôs
 * (padrão 7). Com 1 livre e dezenas de robôs ligados, o robô conecta clientes
 * que ninguém atende e vira callback. Sem visibilidade da Argus, URA vazia ou
 * ninguém livre → 0 (desliga tudo, como sempre foi).
 *
 * @returns {{ alvo: number, livres: number, motivo: string }}
 */
function alvoDeRobos({ ramaisUra, status, agora, total, cfg }) {
  const nenhum = (motivo) => ({ alvo: 0, livres: 0, motivo });
  const semVisibilidade = ramaisUra.some((r) => {
    const info = status.get(r);
    return !info || info.classe === Classe.ERRO || agora - info.ts > VALIDADE_STATUS_MS;
  });
  if (semVisibilidade) return nenhum('sem visibilidade da Argus');

  const humanos = ramaisUra.filter((r) => status.get(r).classe !== Classe.OFFLINE);
  if (!humanos.length) return nenhum('URA vazia ou com todos offline');

  const livres = humanos.filter((r) => status.get(r).classe === Classe.LIVRE).length;
  if (!livres) return nenhum('nenhum humano livre na URA');

  const alvo = Math.min(total, livres * cfg.porLivre, cfg.maximo || Infinity);
  return { alvo, livres, motivo: `${livres} livre(s) na URA × ${cfg.porLivre}` };
}

/**
 * Regra 3b: o que fazer com os robôs agora.
 *
 * Reduzir é imediato (é o que evita callback); aumentar espera `minDesligadoMs`
 * desde a última redução, para não ficar liga-desliga a cada ciclo.
 *
 * @param {object} entrada
 * @param {string[]} entrada.ramaisUra - Humanos que estão na URA
 * @param {Map<string, { classe: string, ts: number }>} entrada.status
 * @param {number} entrada.agora
 * @param {{ ligados: number|null, total: number, ultimaReducao: number }} entrada.robos - ligados null = ainda não lido
 * @param {{ reativar: boolean, minDesligadoMs: number, porLivre: number, maximo?: number }} entrada.cfg
 * @returns {{ acao: string, alvo: number, livres: number, motivo: string }}
 */
function decidirRobos({ ramaisUra, status, agora, robos, cfg }) {
  const decisao = alvoDeRobos({ ramaisUra, status, agora, total: robos.total, cfg });
  const com = (acao, motivo = decisao.motivo) => ({ ...decisao, acao, motivo });
  if (!robos.total) return com(AcaoRobos.NENHUMA, 'nenhum robô conhecido');
  if (decisao.alvo === 0) return com(robos.ligados === 0 ? AcaoRobos.NENHUMA : AcaoRobos.DESLIGAR);
  if (robos.ligados === null) return com(AcaoRobos.NENHUMA, 'aguardando a leitura dos robôs');
  if (robos.ligados > decisao.alvo) return com(AcaoRobos.DESLIGAR);

  const podeAumentar = robos.ligados < decisao.alvo && cfg.reativar && agora - robos.ultimaReducao >= cfg.minDesligadoMs;
  return com(podeAumentar ? AcaoRobos.RELIGAR : AcaoRobos.NENHUMA);
}

/**
 * Quais robôs desligar para chegar ao alvo: primeiro os que NÃO estão em
 * ligação (derrubar um robô falando corta o cliente).
 * @param {Array<{ ramal: string, classe: string }>} ligados
 * @returns {string[]}
 */
function escolherParaDesligar(ligados, quantidade) {
  const peso = (classe) => (classe === Classe.ATENDIMENTO ? 1 : 0);
  return [...ligados].sort((a, b) => peso(a.classe) - peso(b.classe)).slice(0, quantidade).map((r) => r.ramal);
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
  VALIDADE_STATUS_MS,
  classificarStatus,
  deveIrParaUra,
  deveVoltarAoAtivo,
  motivoDaVolta,
  alvoDeRobos,
  decidirRobos,
  escolherParaDesligar,
  reconciliarMovidos,
  interpretarWebhook,
  jaEstavaDeslogado,
};
