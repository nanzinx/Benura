'use strict';
/**
 * Perfis de clientes das bases da URA — funções puras, sem I/O.
 *
 * Cada ligação dos robôs (relatório de ligações detalhadas) conta no perfil do
 * telefone: se o cliente atendeu o robô e se gerou callback (abandono em fila).
 * Cliente de risco: muito callback ou atende muito; quando um robô estiver
 * falando com ele, a supervisão é avisada (e, se quiser, os robôs desligam).
 *
 * Não se guarda o telefone: a chave é um HMAC do número (com um segredo local)
 * e, para mostrar na tela, só a versão mascarada, ex.: (11) 9****-1594.
 * Nada de nome, CPF ou lead.
 */

const crypto = require('crypto');

const Resultado = Object.freeze({ CALLBACK: 'callback', ATENDEU: 'atendeu', EM_CURSO: 'emCurso', NAO_ATENDEU: 'naoAtendeu' });

/** Campo do telefone do cliente no relatório (dddTelefone, telefone...). */
const CAMPO_TELEFONE = /^(ddd)?telefone\d?$|^dddtelefone$|^fone$/i;
const CAMPO_RESULTADO = /result/i;

/** Só os dígitos; sem 0 ou 55 na frente. @returns {string|null} DDD + número (10 ou 11 dígitos) */
function normalizarTelefone(texto) {
  let d = String(texto ?? '').replace(/\D/g, '');
  if (d.length > 11 && d.startsWith('55')) d = d.slice(2);
  if (d.length > 11 && d.startsWith('0')) d = d.replace(/^0+/, '');
  return d.length === 10 || d.length === 11 ? d : null;
}

/** (11) 9****-1594 */
function mascarar(telefone) {
  const ddd = telefone.slice(0, 2);
  const fim = telefone.slice(-4);
  return telefone.length === 11 ? `(${ddd}) ${telefone[2]}****-${fim}` : `(${ddd}) ****-${fim}`;
}

/** Chave do perfil: HMAC-SHA256 do telefone normalizado (não dá para voltar ao número sem o segredo). */
const chaveDoCliente = (telefone, segredo) => crypto.createHmac('sha256', segredo).update(telefone).digest('hex').slice(0, 24);

/** O telefone da ligação, já normalizado. @returns {string|null} */
function telefoneDaLigacao(ligacao) {
  const campo = Object.keys(ligacao || {}).find((c) => CAMPO_TELEFONE.test(c) && ligacao[c] != null && ligacao[c] !== '');
  return campo ? normalizarTelefone(ligacao[campo]) : null;
}

/** Como a ligação conta no perfil. */
function classificarLigacao(ligacao) {
  const resultado = Object.entries(ligacao || {}).filter(([c, v]) => CAMPO_RESULTADO.test(c) && typeof v === 'string').map(([, v]) => v.trim());
  if (resultado.some((v) => /abandono em fila/i.test(v))) return Resultado.CALLBACK;
  if (resultado.some((v) => /liga[cç][aã]o em curso/i.test(v))) return Resultado.EM_CURSO;
  if (resultado.some((v) => /^atendimento$|oper\.?\s*virtual/i.test(v))) return Resultado.ATENDEU;
  return Resultado.NAO_ATENDEU;
}

/**
 * Soma uma ligação final no perfil (callback conta também como "atendeu": o cliente falou com o robô).
 * @param {{ mascara: string, dias: Record<string, [number, number]> }|undefined} perfil
 * @returns {object} perfil atualizado (o mesmo objeto, ou um novo)
 */
function somar(perfil, { mascara, dia, tipo }) {
  const p = perfil || { mascara, dias: {} };
  const [atendeu, callbacks] = p.dias[dia] || [0, 0];
  p.dias[dia] = [atendeu + 1, callbacks + (tipo === Resultado.CALLBACK ? 1 : 0)];
  p.mascara = mascara;
  return p;
}

/** Totais do perfil a partir de `desde` (AAAA-MM-DD). */
function totais(perfil, desde = '') {
  let atendeu = 0;
  let callbacks = 0;
  let ultimoDia = null;
  for (const [dia, [a, c]] of Object.entries(perfil?.dias || {})) {
    if (dia < desde) continue;
    atendeu += a;
    callbacks += c;
    if (!ultimoDia || dia > ultimoDia) ultimoDia = dia;
  }
  return { atendeu, callbacks, ultimoDia };
}

/** Por que é de risco (vazio = não é). */
function motivosDeRisco({ atendeu, callbacks }, { minCallbacks, minAtendeu }) {
  const motivos = [];
  if (minCallbacks > 0 && callbacks >= minCallbacks) motivos.push(`${callbacks} callback(s)`);
  if (minAtendeu > 0 && atendeu >= minAtendeu) motivos.push(`atendeu ${atendeu} vez(es)`);
  return motivos;
}

/** Tira os dias anteriores a `desde`; perfil sem dia nenhum some. */
function podar(perfis, desde) {
  for (const [chave, p] of Object.entries(perfis)) {
    p.dias = Object.fromEntries(Object.entries(p.dias).filter(([dia]) => dia >= desde));
    if (!Object.keys(p.dias).length) delete perfis[chave];
  }
  return perfis;
}

/** Tira de `perfis` os dias do intervalo [desde, ate). */
function tirarPeriodo(perfis, desde, ate) {
  for (const [chave, p] of Object.entries(perfis)) {
    p.dias = Object.fromEntries(Object.entries(p.dias).filter(([dia]) => dia < desde || dia >= ate));
    if (!Object.keys(p.dias).length) delete perfis[chave];
  }
  return perfis;
}

/**
 * Histórico novo = o anterior sem o período relido + o que acabou de ser lido.
 * Rodar perfis:montar de novo não perde os dias mais antigos que a Argus não entrega mais.
 */
function juntarHistorico(anterior, novos, { desde, ate }) {
  const juntos = tirarPeriodo(structuredClone(anterior || {}), desde, ate);
  for (const [chave, p] of Object.entries(novos)) {
    const alvo = juntos[chave] || { mascara: p.mascara, dias: {} };
    Object.assign(alvo.dias, p.dias);
    alvo.mascara = p.mascara;
    juntos[chave] = alvo;
  }
  return juntos;
}

module.exports = {
  tirarPeriodo, juntarHistorico,
  Resultado, normalizarTelefone, mascarar, chaveDoCliente, telefoneDaLigacao, classificarLigacao, somar, totais, motivosDeRisco, podar,
};
