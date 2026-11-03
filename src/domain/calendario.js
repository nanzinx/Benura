'use strict';
/**
 * [NOVO] Feriados e dias úteis (funções puras, datas em AAAA-MM-DD, sem fuso: o dia do calendário).
 *
 * Nacionais de lei (Leis 662/1949, 6.802/1980 e 14.759/2023) e a Sexta-feira Santa, mais o Carnaval
 * (segunda e terça) e o Corpus Christi, em que a empresa não trabalha. Outros dias (feriado da cidade,
 * emenda) entram por FERIADOS_EXTRAS: AAAA-MM-DD (só aquele dia) ou DD/MM (todo ano).
 */

const FIXOS = Object.freeze({
  '01-01': 'Confraternização Universal',
  '04-21': 'Tiradentes',
  '05-01': 'Dia do Trabalho',
  '09-07': 'Independência',
  '10-12': 'Nossa Senhora Aparecida',
  '11-02': 'Finados',
  '11-15': 'Proclamação da República',
  '11-20': 'Consciência Negra',
  '12-25': 'Natal',
});

const iso = (d) => d.toISOString().slice(0, 10);
const somarDias = (dia, n) => {
  const d = new Date(`${dia}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return iso(d);
};

/** Domingo de Páscoa (algoritmo de Meeus/Jones/Butcher). */
function pascoa(ano) {
  const a = ano % 19;
  const b = Math.floor(ano / 100);
  const c = ano % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mes = Math.floor((h + l - 7 * m + 114) / 31);
  const dia = ((h + l - 7 * m + 114) % 31) + 1;
  return `${ano}-${String(mes).padStart(2, '0')}-${String(dia).padStart(2, '0')}`;
}

/**
 * FERIADOS_EXTRAS do .env: "2026-11-30, 25/01". Datas impossíveis e texto que não é data ficam de fora.
 * @returns {{ dias: Set<string>, todoAno: Set<string> }}  todoAno: "MM-DD"
 */
function lerFeriadosExtras(texto) {
  const dias = new Set();
  const todoAno = new Set();
  for (const item of String(texto ?? '').split(/[,;\s]+/).filter(Boolean)) {
    let m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item);
    if (m && iso(new Date(`${item}T12:00:00Z`)) === item) {
      dias.add(item);
      continue;
    }
    m = /^(\d{1,2})\/(\d{1,2})$/.exec(item);
    if (!m) continue;
    const mmdd = `${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
    // 29/02 só existe em ano bissexto: confere num deles
    if (iso(new Date(`2028-${mmdd}T12:00:00Z`)) === `2028-${mmdd}`) todoAno.add(mmdd);
  }
  return { dias, todoAno };
}

const SEM_EXTRAS = Object.freeze({ dias: new Set(), todoAno: new Set() });

/** @returns {Map<string, string>} AAAA-MM-DD → nome, do ano (com os extras) */
function feriados(ano, extras = SEM_EXTRAS) {
  const lista = new Map(Object.entries(FIXOS).map(([mmdd, nome]) => [`${ano}-${mmdd}`, nome]));
  const p = pascoa(ano);
  lista.set(somarDias(p, -48), 'Carnaval');
  lista.set(somarDias(p, -47), 'Carnaval');
  lista.set(somarDias(p, -2), 'Sexta-feira Santa');
  lista.set(somarDias(p, 60), 'Corpus Christi');
  for (const mmdd of extras.todoAno) if (!lista.has(`${ano}-${mmdd}`)) lista.set(`${ano}-${mmdd}`, 'Feriado (FERIADOS_EXTRAS)');
  for (const dia of extras.dias) if (dia.startsWith(`${ano}-`) && !lista.has(dia)) lista.set(dia, 'Feriado (FERIADOS_EXTRAS)');
  return lista;
}

/** Nome do feriado do dia, ou null. */
const feriadoEm = (dia, extras = SEM_EXTRAS) => feriados(Number(dia.slice(0, 4)), extras).get(dia) ?? null;

/** Segunda a sexta e fora dos feriados. */
function diaUtil(dia, extras = SEM_EXTRAS) {
  const semana = new Date(`${dia}T12:00:00Z`).getUTCDay();
  return semana >= 1 && semana <= 5 && !feriadoEm(dia, extras);
}

/** O dia útil mais recente antes de `dia`. */
function ultimoDiaUtilAntes(dia, extras = SEM_EXTRAS) {
  let d = somarDias(dia, -1);
  for (let i = 0; i < 30 && !diaUtil(d, extras); i++) d = somarDias(d, -1);
  return d;
}

/** "02/11/2026" → "2026-11-02" (null se não for data). */
function deDiaBr(texto) {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(String(texto ?? '').trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : null;
}

module.exports = { pascoa, feriados, feriadoEm, diaUtil, ultimoDiaUtilAntes, lerFeriadosExtras, deDiaBr, SEM_EXTRAS };
