'use strict';
/**
 * [NOVO] Liberados da URA (funções puras): quem pode iniciar na URA hoje e o comunicado do grupo.
 *
 *  - Entra quem vendeu pelo menos a meta (padrão R$ 50.000) no dia anterior com operação.
 *  - Os fixos entram sempre; o fixo é casado pelo primeiro nome (sem acento, sem maiúscula).
 *  - "Dia anterior" = o último dia com operação antes do dia da URA (padrão: segunda a sábado;
 *    na segunda conta o sábado, domingo não conta).
 *  - O texto segue exatamente o modelo combinado com a supervisão.
 */

const QUASE_PCT = 80;
const DIAS_OPERACAO_PADRAO = Object.freeze([1, 2, 3, 4, 5, 6]);

const semAcento = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '');
const normalizar = (s) => semAcento(s).toLowerCase().replace(/\s+/g, ' ').trim();
const primeiroNome = (s) => normalizar(s).split(' ')[0] || '';

/** "Stephanny, Jamily, Eduardo (CLT)" → [{ nome: 'Stephanny', obs: '' }, …, { nome: 'Eduardo', obs: 'CLT' }] */
function lerFixos(texto) {
  return String(texto ?? '').split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
    const m = /^(.*?)\s*\((.*)\)\s*$/.exec(s);
    return m ? { nome: m[1].trim(), obs: m[2].trim() } : { nome: s, obs: '' };
  });
}

/** "1,2,3" ou [1,2,3] → dias da semana (0 = domingo … 6 = sábado). Vazio → segunda a sábado. */
function lerDiasOperacao(valor) {
  const lista = (Array.isArray(valor) ? valor : String(valor ?? '').split(','))
    .map((d) => String(d).trim()).filter(Boolean).map(Number).filter((d) => Number.isInteger(d) && d >= 0 && d <= 6);
  return lista.length ? [...new Set(lista)].sort() : [...DIAS_OPERACAO_PADRAO];
}

/** AAAA-MM-DD ± n dias (meio-dia UTC: sem efeito de horário de verão). */
function somarDias(dia, n) {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const diaDaSemana = (dia) => new Date(`${dia}T12:00:00Z`).getUTCDay();

/** O último dia com operação antes de `diaUra` (AAAA-MM-DD). */
function diaAnteriorComOperacao(diaUra, diasOperacao = DIAS_OPERACAO_PADRAO) {
  const dias = lerDiasOperacao(diasOperacao);
  let d = somarDias(diaUra, -1);
  for (let i = 0; i < 7 && !dias.includes(diaDaSemana(d)); i++) d = somarDias(d, -1);
  return d;
}

/**
 * @param {{ vendas: Array<{ nome: string, valor: number }>, meta: number, fixos: Array<{ nome: string, obs?: string }> }} p
 * @returns {{ ranking, bateram, quaseLa, liberados, total, meta, coroa: string|null, fixosNaUra: number, pelaMeta: number }}
 */
function calcular({ vendas, meta, fixos }) {
  const ranking = (vendas ?? [])
    .filter((v) => v && v.nome && Number.isFinite(Number(v.valor)))
    .map((v) => ({ nome: String(v.nome).trim(), valor: Math.round(Number(v.valor) * 100) / 100 }))
    .sort((a, b) => b.valor - a.valor);
  const usados = new Set();
  const fixoDe = new Map();
  for (const f of fixos ?? []) {
    // O de maior venda com esse primeiro nome (o ranking já está em ordem).
    const r = ranking.find((x) => !usados.has(x) && primeiroNome(x.nome) === primeiroNome(f.nome));
    if (r) { usados.add(r); fixoDe.set(r, f); }
  }
  for (const r of ranking) {
    r.pct = meta > 0 ? (r.valor / meta) * 100 : 0;
    r.bateu = meta > 0 && r.valor >= meta;
    r.status = r.bateu ? 'bateu' : r.pct >= QUASE_PCT ? 'quase' : 'abaixo';
    r.fixo = fixoDe.get(r) ?? null;
    r.diferenca = Math.round((r.valor - meta) * 100) / 100;
  }
  const liberados = ranking.filter((r) => r.fixo || r.bateu).map((r) => ({ ...r, semVenda: false }));
  // Fixo sem venda no dia: entra assim mesmo (no fim, com R$ 0).
  for (const f of fixos ?? []) {
    if (![...fixoDe.values()].includes(f)) {
      liberados.push({ nome: f.nome, valor: 0, pct: 0, bateu: false, status: 'abaixo', fixo: f, diferenca: -meta, semVenda: true });
    }
  }
  const total = Math.round(ranking.reduce((t, r) => t + r.valor, 0) * 100) / 100;
  return {
    ranking,
    bateram: ranking.filter((r) => r.bateu),
    quaseLa: ranking.filter((r) => r.status === 'quase'),
    liberados,
    total,
    meta,
    coroa: ranking[0]?.nome ?? null,
    fixosNaUra: (fixos ?? []).length,
    pelaMeta: liberados.filter((r) => !r.fixo).length,
  };
}

const reais = (v) => new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' }).format(v).replace(/\s/g, ' ');
const reaisInteiros = (v) => `R$ ${Math.round(v).toLocaleString('pt-BR')}`;
const ddmm = (dia) => (dia ? `${dia.slice(8, 10)}/${dia.slice(5, 7)}` : '');
/** 1️⃣ … 🔟, depois "11." */
const numeral = (i) => (i < 9 ? `${i + 1}️⃣` : i === 9 ? '🔟' : `${i + 1}.`);

/** O comunicado do dia, no formato combinado (negrito do WhatsApp com *). */
function comunicado({ diaUra, diaVendas, meta, fixos, bateram }) {
  const lista = bateram.length
    ? bateram.map((r, i) => `${numeral(i)} *${r.nome}* — ${reais(r.valor)} (${Math.round(r.pct)}%${i === 0 ? ' da meta) 🥇' : ')'}`)
    : ['Ninguém bateu a meta ontem.'];
  return [
    `📢 *URA — Lista de hoje (${ddmm(diaUra)})*`,
    '',
    'Bom dia, time! Seguimos com a *regra padrão da URA*:',
    `👉 Para iniciar na URA, é preciso ter vendido *${reaisInteiros(meta)} em ANDAMENTO no dia anterior*.`,
    '',
    '📌 *Fixos na URA:*',
    ...fixos.map((f) => `• ${f.nome}`),
    '',
    `🏆 *Bateram a meta ontem (${ddmm(diaVendas)}):*`,
    ...lista,
    '',
    '⚠️ *ATENÇÃO:* todas as ligações serão *acompanhadas*. Caso seja identificado *qualquer desvio de conduta*, o colaborador será *banido da URA pelo restante do mês*.',
    '',
    '🕘 A lista será enviada aqui *todos os dias até as 09:00*.',
    '',
    'Parabéns a quem bateu e bora pra cima! 🚀',
  ].join('\n');
}

module.exports = {
  lerFixos, lerDiasOperacao, diaAnteriorComOperacao, calcular, comunicado, primeiroNome, normalizar, reais, somarDias,
  QUASE_PCT, DIAS_OPERACAO_PADRAO,
};
