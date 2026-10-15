'use strict';
/**
 * Raio-x de um callback — funções puras, sem I/O.
 *
 * O rodízio guarda uma "foto" da URA a cada ciclo (quem estava livre, em que
 * grupo a telefonia estava, carência, robôs ligados). Quando o relatório da
 * Argus mostra um callback (cliente pediu humano, esperou na fila e desistiu),
 * as fotos do intervalo da ligação dizem o que a URA tinha naquela hora:
 *
 *  - "livre em carência": só havia livre com a telefonia recém-trocada;
 *  - "derivações juntas": o(s) livre(s) atenderam outra ligação e a fila ficou sem ninguém;
 *  - "URA sem livre": ninguém livre (saída por ocioso, pausa, offline);
 *  - "INVISÍVEL": havia livre com a telefonia na URA durante toda a ligação.
 *
 * Só dados do operador (ramal, nome, grupo); nada do cliente.
 */

const { Classe } = require('./rodizio');

/** Uma foto: { ts, robos: { ligados, alvo }, ura: [{ ramal, nome, classe, grupo, emCarencia, trocouEm, movidoEm }] } */

const Conclusao = Object.freeze({
  SEM_HISTORICO: 'sem histórico do BenURA nesse horário (desligado ou reiniciado)',
  CARENCIA: 'livre ainda na carência da troca de grupo (telefonia recém-trocada)',
  DERIVACOES_JUNTAS: 'derivações juntas: o(s) livre(s) atenderam outra ligação e a fila ficou sem ninguém',
  URA_SEM_LIVRE: 'a URA ficou sem livre durante a ligação (saída, pausa ou offline)',
  INVISIVEL: 'INVISÍVEL: havia livre com a telefonia na URA durante toda a ligação',
});

/** Folga nas pontas: a foto do ciclo pode ser de alguns segundos antes/depois. */
const FOLGA_MS = 5000;

/**
 * "2026-10-15T08:42:18", "2026-10-15 08:42:18" ou "15/10/2026 08:42:18" (hora local
 * do fuso, sem offset, como no relatório da Argus) → instante em ms; null se não for data.
 */
function instanteLocal(texto, fuso) {
  const s = String(texto ?? '').trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})[T\s](\d{2}):(\d{2})(?::(\d{2}))?/.exec(s)
    || (/^(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2})(?::(\d{2}))?/.exec(s) || []).slice(0, 7);
  if (!m || !m[1]) return null;
  const [ano, mes, dia] = m[1].length === 4 ? [m[1], m[2], m[3]] : [m[3], m[2], m[1]];
  const comoUtc = Date.UTC(+ano, +mes - 1, +dia, +m[4], +m[5], +(m[6] || 0));
  return comoUtc - deslocamento(fuso, comoUtc);
}

/** Quanto o fuso está à frente do UTC (ms) perto do instante `t`. */
function deslocamento(fuso, t) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
    timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(t)).map(({ type, value }) => [type, value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - t;
}

/** HH:MM:SS no fuso. */
const horaNoFuso = (t, fuso) => new Intl.DateTimeFormat('pt-BR', {
  timeZone: fuso, hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
}).format(new Date(t));

const naUra = (u, grupoUraId) => u.grupo == null || Number(u.grupo) === Number(grupoUraId);
/** Livre que recebe derivação: livre, fora da carência, telefonia no grupo da URA. */
const livresUteis = (foto, grupoUraId) => foto.ura.filter((u) => u.classe === Classe.LIVRE && !u.emCarencia && naUra(u, grupoUraId));
const emCarencia = (foto) => foto.ura.filter((u) => u.classe === Classe.LIVRE && u.emCarencia);

/** Alguém passou a ATENDIMENTO entre uma foto e a seguinte? */
function alguemComecouAAtender(fotos) {
  for (let i = 1; i < fotos.length; i++) {
    const antes = new Map(fotos[i - 1].ura.map((u) => [u.ramal, u.classe]));
    if (fotos[i].ura.some((u) => u.classe === Classe.ATENDIMENTO && antes.get(u.ramal) !== Classe.ATENDIMENTO)) return true;
  }
  return false;
}

function concluir(fotos, grupoUraId) {
  if (!fotos.length) return Conclusao.SEM_HISTORICO;
  if (fotos.every((f) => livresUteis(f, grupoUraId).length > 0)) return Conclusao.INVISIVEL;
  const semUteis = fotos.filter((f) => livresUteis(f, grupoUraId).length === 0);
  if (semUteis.some((f) => emCarencia(f).length > 0)) return Conclusao.CARENCIA;
  if (alguemComecouAAtender(fotos)) return Conclusao.DERIVACOES_JUNTAS;
  return Conclusao.URA_SEM_LIVRE;
}

/** "2266423 Jamily (grupo 9, telefonia na URA há 37 s, movido pelo BenURA, carência)" */
function descrever(u, t, fuso) {
  const partes = [
    u.grupo != null ? `grupo ${u.grupo}` : null,
    u.trocouEm ? `telefonia na URA há ${Math.round((t - u.trocouEm) / 1000)} s` : null,
    u.movidoEm ? `movido pelo BenURA às ${horaNoFuso(u.movidoEm, fuso)}` : null,
    u.emCarencia ? 'carência' : null,
  ].filter(Boolean);
  return `${u.ramal}${u.nome ? ` ${u.nome}` : ''}${partes.length ? ` (${partes.join(', ')})` : ''}`;
}

/**
 * @param {object} p
 * @param {object[]} p.fotos - fotos da URA (em ordem)
 * @param {number} p.inicio - início da ligação do robô (ms)
 * @param {number} p.fim - fim da ligação (início + duração)
 * @param {number} p.grupoUraId
 * @param {string} p.fuso
 * @param {string} [p.robo] - nome do robô (operador virtual)
 * @returns {{ conclusao: string, linha: string, fotos: number }}
 */
function raioXDoCallback({ fotos, inicio, fim, grupoUraId, fuso, robo }) {
  const daLigacao = fotos.filter((f) => f.ts >= inicio - FOLGA_MS && f.ts <= fim + FOLGA_MS);
  const conclusao = concluir(daLigacao, grupoUraId);
  const cabeca = `CALLBACK ${horaNoFuso(inicio, fuso)}${robo ? ` ${robo}` : ''}, ${Math.round((fim - inicio) / 1000)} s`;
  if (!daLigacao.length) return { conclusao, linha: `${cabeca} | ${conclusao}`, fotos: 0 };

  // O pior momento: menos livres úteis (o último, se empatar: é quando o cliente esperava).
  const pior = daLigacao.reduce((a, f) => (livresUteis(f, grupoUraId).length <= livresUteis(a, grupoUraId).length ? f : a));
  const livres = pior.ura.filter((u) => u.classe === Classe.LIVRE);
  const atendendo = pior.ura.filter((u) => u.classe === Classe.ATENDIMENTO).map((u) => u.ramal);
  const outros = pior.ura.filter((u) => ![Classe.LIVRE, Classe.ATENDIMENTO, Classe.OFFLINE].includes(u.classe)).map((u) => `${u.ramal} ${u.classe}`);
  const linha = [
    cabeca,
    conclusao,
    `às ${horaNoFuso(pior.ts, fuso)}: livres ${livres.length ? livres.map((u) => descrever(u, pior.ts, fuso)).join('; ') : 'nenhum'}`,
    atendendo.length ? `em atendimento: ${atendendo.join(', ')}` : null,
    outros.length ? `outros: ${outros.join(', ')}` : null,
    `robôs ${pior.robos?.ligados ?? '?'}/${pior.robos?.alvo ?? '?'}`,
  ].filter(Boolean).join(' | ');
  return { conclusao, linha, fotos: daLigacao.length };
}

module.exports = { raioXDoCallback, instanteLocal, horaNoFuso, Conclusao };
