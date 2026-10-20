'use strict';
/**
 * Regras do rodízio Ativo ↔ URA e do controle de robôs — funções puras, sem I/O.
 *
 *  1. IDA PARA A URA: operador ELEGÍVEL do Ativo que ATENDEU uma ligação e
 *     ficou LIVRE vai para a URA (rodízio). Elegível = quem o roteador pôs na
 *     URA hoje (meta de ontem, venda hoje ou fixo); sem a lista do dia, todos.
 *     Se ficar offline, perde o histórico.
 *  2. VOLTA AO ATIVO: QUALQUER humano da URA ocioso (Livre) há TEMPO_MIN
 *     minutos seguidos volta ao Ativo (atender zera a contagem). Quem o rodízio
 *     moveu volta ao grupo de origem; os demais, ao grupo do supervisor. Movido
 *     que fica offline volta na hora. A regra vale SEMPRE (também na URA cheia
 *     e para o último livre); quando o último livre está para sair, os robôs
 *     param de discar antes, para os que estão em ligação terminarem.
 *  3. ROBÔS: ligados em proporção aos humanos livres na URA (ROBOS_POR_LIVRE
 *     por livre); todos desligados quando ninguém na URA pode atender (todos
 *     ocupados, URA vazia/offline, ou a Argus sem visibilidade).
 */

const { Fila } = require('./fila');

/** Classes de status de operador. */
const Classe = Object.freeze({
  OFFLINE: 'offline',
  ATENDIMENTO: 'atendimento',
  LIVRE: 'livre',
  OUTRO: 'outro', // pausa, tabulação, almoço...
  ERRO: 'erro', // a Argus não respondeu
});

/** Robô desligado responde com sucesso e este status (humano deslogado recebe HTTP 500). */
const STATUS_OFFLINE_PADRAO = Object.freeze(['deslogado', 'offline', 'desconectado']);

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
 * @param {{ livres: string[], atendimento: string[], offline?: string[] }} descricoes - descricaoStatus aceitas (minúsculas)
 */
function classificarStatus(status, { livres, atendimento, offline = STATUS_OFFLINE_PADRAO }) {
  if (!status) return Classe.OFFLINE;
  const descricao = String(status.descricaoStatus || '').trim().toLowerCase();
  if (offline.includes(descricao)) return Classe.OFFLINE;
  if (atendimento.includes(descricao)) return Classe.ATENDIMENTO;
  if (livres.includes(descricao) && !status.descricaoPausa) return Classe.LIVRE;
  return Classe.OUTRO;
}

/** Regra 1: atendeu no Ativo e agora está livre. */
const deveIrParaUra = (classe, atendeuNoAtivo) => classe === Classe.LIVRE && atendeuNoAtivo;

/**
 * Regra 1, quem pode subir: os ramais que o roteador decidiu para a URA hoje
 * (fila "URA" no state-vendas.json: meta de ontem, venda hoje ou fixo).
 * @param {object|null} estado - estado do roteador
 * @param {string} hoje - AAAA-MM-DD no fuso da operação
 * @returns {Set<string>|null} null = sem lista do dia (o rodízio gira todos)
 */
function elegiveisDoEstado(estado, hoje) {
  if (!estado?.vendedores || estado.data !== hoje) return null;
  const naUra = Object.entries(estado.vendedores).filter(([, r]) => r?.fila === Fila.URA);
  return new Set(naUra.map(([ramal]) => String(ramal)));
}

/**
 * Regra 2: ocioso (Livre) há `ociosoMs` seguidos, ou movido pelo rodízio que ficou offline
 * por `offlineMs` seguidos.
 * @param {{ classe: string, livreDesde?: number, agora: number, ociosoMs: number, movido?: object,
 *           offlineDesde?: number, offlineMs?: number }} entrada
 */
function deveVoltarAoAtivo({ classe, livreDesde, agora, ociosoMs, movido, offlineDesde, offlineMs = 0 }) {
  // Movido que fica offline volta, mas só se continuar offline: logo depois da
  // transferência (ou de um relogin) o status pisca "deslogado" por alguns segundos.
  if (classe === Classe.OFFLINE) return Boolean(movido) && agora - (offlineDesde ?? agora) >= offlineMs;
  return classe === Classe.LIVRE && Number.isFinite(livreDesde) && agora - livreDesde >= ociosoMs;
}

/**
 * Regra 2b: se todos os livres da URA vão sair por ociosidade (agora ou em
 * breve), quem é o último a sair. A regra do ocioso vale sempre: ninguém fica
 * além do TEMPO_MIN. Saber quem é o último permite parar os robôs antes, para
 * os que estão em ligação terminarem com alguém ainda livre para derivar.
 * @param {{ saindo: string[], ramaisUra: string[], status: Map<string, { classe: string, livreDesde?: number }> }} entrada
 * @returns {string|null} ramal do último livre (o ocioso há menos tempo)
 */
function ultimoLivreQueSai({ saindo, ramaisUra, status }) {
  const livre = (r) => status.get(r)?.classe === Classe.LIVRE;
  if (ramaisUra.some((r) => livre(r) && !saindo.includes(r))) return null;
  const ociosos = saindo.filter(livre).sort((a, b) => status.get(b).livreDesde - status.get(a).livreDesde);
  return ociosos[0] ?? null;
}

/**
 * Os livres que recebem derivação: classe Livre e fora da carência da troca de grupo
 * (a telefonia em outro grupo já chega aqui como OUTRO).
 * @returns {string[]}
 */
const livresUteis = (ramaisUra, status) => ramaisUra.filter((r) => status.get(r)?.classe === Classe.LIVRE && !status.get(r).emCarencia);

/** Motivo da volta, para o log. */
const motivoDaVolta = ({ classe, livreDesde, agora }) => (classe === Classe.OFFLINE
  ? 'offline'
  : `ocioso há ${Math.floor((agora - livreDesde) / 60_000)} min`);

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
    return !info || info.classe === Classe.ERRO || agora - info.ts > (cfg.validadeStatusMs ?? VALIDADE_STATUS_MS);
  });
  if (semVisibilidade) return nenhum('sem visibilidade da Argus');

  const humanos = ramaisUra.filter((r) => status.get(r).classe !== Classe.OFFLINE);
  if (!humanos.length) return nenhum('URA vazia ou com todos offline');

  // Quem acabou de passar a telefonia para a URA ainda não recebe derivação com
  // certeza (visto em 15/10: callback 37 s depois da troca): só conta após a carência.
  const livresTodos = humanos.filter((r) => status.get(r).classe === Classe.LIVRE);
  const livres = livresUteis(livresTodos, status).length;
  if (!livresTodos.length) return nenhum('nenhum humano livre na URA');
  if (!livres) return nenhum('livre(s) na URA ainda na carência da troca de grupo');

  const alvo = Math.min(total, livres * cfg.porLivre, cfg.maximo || Infinity);
  // Com 1 livre só, dois clientes pedindo humano juntos viram callback: menos robôs.
  if (livres === 1 && cfg.maxComUmLivre > 0 && alvo > cfg.maxComUmLivre) {
    return { alvo: cfg.maxComUmLivre, livres, motivo: `1 livre na URA: até ${cfg.maxComUmLivre} robôs` };
  }
  return { alvo, livres, motivo: `${livres} livre(s) na URA × ${cfg.porLivre}` };
}

/**
 * Regra 3b: o que fazer com os robôs agora.
 *
 * Imita a operação manual:
 *  - ninguém livre (alvo 0): desliga todos NA HORA;
 *  - redução parcial: só quando o excesso já dura `reduzirAposMs` (uma piscada
 *    de status não derruba robôs);
 *  - aumentar: espera `minDesligadoMs` desde a última redução e
 *    `intervaloSubidaMs` desde o último aumento (sobe em degraus, sem rajada).
 *
 * @param {object} entrada
 * @param {string[]} entrada.ramaisUra - Humanos que estão na URA
 * @param {Map<string, { classe: string, ts: number }>} entrada.status
 * @param {number} entrada.agora
 * @param {{ ligados: number|null, total: number, ultimaReducao: number, ultimoAumento?: number, excessoDesde?: number|null }} entrada.robos
 *        ligados null = ainda não lido; excessoDesde = desde quando há mais robôs que o alvo
 * @param {{ reativar: boolean, minDesligadoMs: number, porLivre: number, maximo?: number, validadeStatusMs?: number,
 *           reduzirAposMs?: number, intervaloSubidaMs?: number }} entrada.cfg
 * @returns {{ acao: string, alvo: number, livres: number, motivo: string, excesso: boolean }}
 */
function decidirRobos({ ramaisUra, status, agora, robos, cfg }) {
  const decisao = alvoDeRobos({ ramaisUra, status, agora, total: robos.total, cfg });
  const excesso = decisao.alvo > 0 && robos.ligados !== null && robos.ligados > decisao.alvo;
  const com = (acao, motivo = decisao.motivo) => ({ ...decisao, acao, motivo, excesso });
  if (!robos.total) return com(AcaoRobos.NENHUMA, 'nenhum robô conhecido');
  if (decisao.alvo === 0) return com(robos.ligados === 0 ? AcaoRobos.NENHUMA : AcaoRobos.DESLIGAR);
  if (robos.ligados === null) return com(AcaoRobos.NENHUMA, 'aguardando a leitura dos robôs');
  if (excesso) return decidirReducao(robos, agora, cfg, com);

  const podeAumentar = robos.ligados < decisao.alvo && cfg.reativar
    && agora - robos.ultimaReducao >= cfg.minDesligadoMs
    && agora - (robos.ultimoAumento || 0) >= (cfg.intervaloSubidaMs || 0);
  return com(podeAumentar ? AcaoRobos.RELIGAR : AcaoRobos.NENHUMA);
}

/** Redução parcial só quando a queda de livres se confirma por `reduzirAposMs`. */
function decidirReducao(robos, agora, cfg, com) {
  const desde = robos.excessoDesde ?? agora;
  if (agora - desde >= (cfg.reduzirAposMs || 0)) return com(AcaoRobos.DESLIGAR);
  return com(AcaoRobos.NENHUMA, 'aguardando a queda de livres se confirmar');
}

/**
 * Quais robôs desligar numa redução PARCIAL (ainda há humano livre): só os que
 * NÃO estão em ligação. Derrubar um robô falando corta o cliente e vira
 * callback, e ainda há quem receba a derivação dele. Robô cujo status não pôde
 * ser lido também fica. Os poupados saem nos ciclos seguintes, ao terminar a
 * ligação. (Com ninguém livre, o alvo 0 desliga todos: não segue por aqui.)
 * @param {Array<{ ramal: string, classe: string }>} ligados
 * @returns {string[]}
 */
function escolherParaDesligar(ligados, quantidade) {
  const podeDesligar = (classe) => classe !== Classe.ATENDIMENTO && classe !== Classe.ERRO;
  return ligados.filter((r) => podeDesligar(r.classe)).slice(0, quantidade).map((r) => r.ramal);
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

/** Encerramento de URA (webhook tipo 5): conclusões em que o cliente pediu humano e desistiu na fila. */
const CONCLUSOES_CALLBACK = Object.freeze({ 2: 'abandonou a fila', 4: 'time-out na fila' });

/**
 * Callback em tempo real: o cliente pediu um humano e ninguém atendeu a tempo
 * (é o "Gerou Callback" do painel). Sem dados do cliente: a chave só serve
 * para não contar duas vezes o mesmo evento reenviado.
 * @returns {{ motivo: string, chave: string|null }|null}
 */
function interpretarCallback(evento) {
  if (evento?.idTipoWebhook !== 5) return null;
  const motivo = CONCLUSOES_CALLBACK[evento.idConclusaoDerivacao ?? evento.FidConclusaoDerivacao];
  if (!motivo) return null;
  // Com o idLigacao, a chave é a mesma do relatório (vigia-callbacks): o mesmo callback não conta duas vezes.
  if (evento.idLigacao != null && evento.idLigacao !== '') return { motivo, chave: `ligacao:${evento.idLigacao}` };
  const partes = [evento.telefone, evento.dataInicioUra].filter((p) => p != null && p !== '');
  return { motivo, chave: partes.length ? partes.join('|') : null };
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
  STATUS_OFFLINE_PADRAO,
  deveIrParaUra,
  elegiveisDoEstado,
  deveVoltarAoAtivo,
  motivoDaVolta,
  ultimoLivreQueSai,
  livresUteis,
  alvoDeRobos,
  decidirRobos,
  escolherParaDesligar,
  reconciliarMovidos,
  interpretarWebhook,
  interpretarCallback,
  jaEstavaDeslogado,
};
