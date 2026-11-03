'use strict';
/**
 * [NOVO] Diagnóstico de ligações derivadas que chegam mudas ou já caem no pós-chamada (funções puras).
 *
 * Cruza as ligações curtas do grupo da URA (o receptivo, no relatório de ligações da Argus) com o
 * que o BenURA fez no mesmo ramal perto daquela hora (logs do dia): trocar de grupo (Ativo ↔ URA),
 * logar de novo (alinhar o login) ou mover à mão pelo painel. Também marca as rajadas de robôs
 * ligados de uma vez. As ligações normais entram como base, para comparar com o acaso: se as curtas
 * têm muito mais evento por perto que as normais, o BenURA está no caminho; se não, é a Argus, a
 * operadora ou a rede (SIP).
 *
 * Sem dado de cliente: da ligação, só a hora, o operador, o resultado e a duração.
 */

const hhmmss = (texto) => {
  const m = /^(\d{2}):(\d{2}):(\d{2})/.exec(texto);
  return m ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : null;
};

/** As linhas que o BenURA escreve (rodizio.service, alinhar-login, controle-robos). */
const PADROES = [
  ['paraUra', /ATIVO→URA ramal=(\d+)/],
  ['paraAtivo', /URA→ATIVO ramal=(\d+)/],
  ['relogin', /Ramal (\d+) relogado no grupo/],
  ['aMao', /Ramal (\d+) → (?:URA|Ativo) à mão pelo painel/],
  ['telefoniaNaUra', /Ramal (\d+): telefonia na URA/],
];
const RAJADA = /ROBÔS AUMENTADOS para \d+ .*: \+(\d+)\//;

/**
 * @param {string[]} linhas - dos logs do dia (logs/AAAA-MM-DD/rodizio.txt e robos.txt)
 * @param {{ rajadaMin?: number }} [opcoes] - quantos robôs ligados de uma vez contam como rajada (10)
 * @returns {Array<{ seg: number, hora: string, tipo: string, ramal: string|null, robos?: number }>}
 */
function lerEventosDoLog(linhas, { rajadaMin = 10 } = {}) {
  const eventos = [];
  for (const linha of linhas) {
    const seg = hhmmss(linha);
    if (seg == null || linha.includes('[DRY_RUN]')) continue;
    const hora = linha.slice(0, 8);
    const achado = PADROES.find(([, re]) => re.test(linha));
    if (achado) {
      eventos.push({ seg, hora, tipo: achado[0], ramal: achado[1].exec(linha)[1] });
      continue;
    }
    const rajada = RAJADA.exec(linha);
    if (rajada && Number(rajada[1]) >= rajadaMin) eventos.push({ seg, hora, tipo: 'rajada', ramal: null, robos: Number(rajada[1]) });
  }
  return eventos.sort((a, b) => a.seg - b.seg);
}

const horaDaLigacao = (l) => String(l.dataHoraLigacao ?? '').split('T')[1]?.slice(0, 8) ?? '';
const duracao = (l) => (Number.isFinite(Number(l.tempoSegundos)) ? Number(l.tempoSegundos) : null);

const vazio = () => ({ total: 0, comEventoDoRamal: 0, naRajada: 0, semRamal: 0, porTipo: {} });

/**
 * @param {object} p
 * @param {object[]} p.ligacoes - ligacoesDetalhadas do grupo da URA
 * @param {ReturnType<typeof lerEventosDoLog>} p.eventos
 * @param {(nome: string) => string|null} p.ramalPorNome
 * @param {number} [p.ateSeg] - até quantos segundos a ligação conta como curta (15)
 * @param {number} [p.janelaSeg] - quantos segundos antes ou depois um evento conta como "perto" (20)
 */
function cruzar({ ligacoes, eventos, ramalPorNome, ateSeg = 15, janelaSeg = 20 }) {
  const curtas = vazio();
  const normais = vazio();
  const resultadosDasCurtas = {};
  const lista = [];

  for (const l of ligacoes) {
    const hora = horaDaLigacao(l);
    const seg = hhmmss(hora);
    const tempo = duracao(l);
    if (seg == null || tempo == null) continue;
    const curta = tempo <= ateSeg;
    const grupo = curta ? curtas : normais;
    const ramal = ramalPorNome(l.usuarioOperador ?? '') ?? null;
    const perto = eventos
      .filter((e) => Math.abs(e.seg - seg) <= janelaSeg && (e.tipo === 'rajada' || (ramal && e.ramal === ramal)))
      .map((e) => ({ tipo: e.tipo, difSeg: e.seg - seg, ...(e.robos ? { robos: e.robos } : {}) }));

    grupo.total += 1;
    if (!ramal) grupo.semRamal += 1;
    const doRamal = perto.filter((e) => e.tipo !== 'rajada');
    if (doRamal.length) grupo.comEventoDoRamal += 1;
    if (perto.some((e) => e.tipo === 'rajada')) grupo.naRajada += 1;
    for (const tipo of new Set(doRamal.map((e) => e.tipo))) grupo.porTipo[tipo] = (grupo.porTipo[tipo] ?? 0) + 1;

    if (!curta) continue;
    const resultado = String(l.resultadoLigacao ?? '(vazio)');
    resultadosDasCurtas[resultado] = (resultadosDasCurtas[resultado] ?? 0) + 1;
    lista.push({ hora, ramal, operador: l.usuarioOperador ?? null, resultado, tempoSegundos: tempo, eventos: perto });
  }
  return { ateSeg, janelaSeg, curtas, normais, resultadosDasCurtas, lista };
}

/** "17 de 40 (43%)" */
const parte = (n, total) => `${n} de ${total}${total ? ` (${Math.round((n / total) * 100)}%)` : ''}`;

/** O que o resultado sugere, em uma frase. */
function leitura({ curtas, normais }) {
  if (!curtas.total) return 'Nenhuma ligação curta no período.';
  const pc = curtas.comEventoDoRamal / curtas.total;
  const pn = normais.total ? normais.comEventoDoRamal / normais.total : 0;
  if (curtas.comEventoDoRamal >= 3 && pc >= 2 * pn + 0.1) {
    return 'As curtas têm bem mais troca de grupo ou relogin por perto que as normais: o BenURA provavelmente está no caminho.';
  }
  return 'As curtas não têm mais evento do BenURA por perto que as normais: o problema deve estar na Argus, na operadora ou na rede (SIP).';
}

module.exports = { lerEventosDoLog, cruzar, leitura, parte };
