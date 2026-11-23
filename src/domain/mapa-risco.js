'use strict';
/**
 * [NOVO] Mapa de risco dos robôs (funções puras). A cada ligação da URA que terminou (lead derivado
 * ou callback), anota a situação do momento em que o cliente entrou: quantos livres havia, quantos
 * robôs estavam ligados e o status da URA. Somando os dias, cada célula (livres × faixa de robôs)
 * mostra quanto custa em callback ligar aquele tanto de robôs com aquele tanto de gente livre.
 *
 * Callback com 1 livre ou mais no momento é "invisível": a ligação não chegou em quem estava livre
 * (telefonia ou Argus), e não depende da quantidade de robôs. Com 0 livre é "de fila": faltou gente.
 * Só o de fila entra na taxa da célula.
 *
 * Etapa 1: só mede e mostra. A etapa 2 (o automático escolher os robôs pelo mapa) vem com dados.
 *
 * [NOVO] Por que os de fila: o raio-x de cada callback (domain/raio-x-callback.js) diz o que faltou.
 * O mapa guarda, por célula, quantos foram cada motivo (MOTIVOS_FILA), para separar o que os robôs
 * causam do que é falta de gente (o livre atendeu outra, saiu, pausou ou estava na carência).
 */

const FAIXAS_LIVRES = Object.freeze(['0', '1', '2', '3', '4+']);
const FAIXAS_ROBOS = Object.freeze(['0', '1-10', '11-20', '21-30', '31-40', '41+']);
const STATUS = Object.freeze(['calma', 'normal', 'agressiva', 'medindo']);
/** Menos ligações que isto na célula: "pouca amostra" (não dá para confiar na taxa). */
const AMOSTRA_MINIMA = 50;

const numero = (n) => (n == null || !Number.isFinite(Number(n)) ? null : Number(n));

function faixaDeLivres(n) {
  const v = numero(n);
  if (v == null) return null;
  return v >= 4 ? '4+' : String(Math.max(0, Math.floor(v)));
}

function faixaDeRobos(n) {
  const v = numero(n);
  if (v == null) return null;
  if (v <= 0) return '0';
  if (v > 40) return '41+';
  const teto = Math.ceil(v / 10) * 10;
  return `${teto - 9}-${teto}`;
}

/** "1|11-20|calma" (sem status: "medindo"); null sem livres ou sem robôs. */
function chave({ livres, robos, status }) {
  const l = faixaDeLivres(livres);
  const r = faixaDeRobos(robos);
  if (l == null || r == null) return null;
  return `${l}|${r}|${STATUS.includes(status) ? status : 'medindo'}`;
}

/**
 * Soma uma ligação no mapa do dia.
 * @param {Record<string, { leads: number, fila: number, invisiveis: number }>} mapa
 * @param {{ livres: number, robos: number|null, status: string|null }|null} foto - a situação quando o cliente entrou
 * @param {{ derivou: boolean, invisivel?: boolean }} ligacao - [NOVO] invisivel: havia gente livre a espera
 *        toda (quem chama olha as fotos da espera); sem ele, decide a foto da entrada
 * @returns {boolean} false sem foto (ex.: logo depois de um reinício)
 */
function anotar(mapa, foto, { derivou, invisivel }) {
  const k = foto ? chave(foto) : null;
  if (!k) return false;
  const c = (mapa[k] ??= { leads: 0, fila: 0, invisiveis: 0 });
  if (derivou) c.leads += 1;
  else if (invisivel ?? Number(foto.livres) > 0) c.invisiveis += 1;
  else c.fila += 1;
  return true;
}

/** Os motivos dos callbacks de fila (a conclusão do raio-x), como chaves curtas. */
const MOTIVOS_FILA = Object.freeze(['juntas', 'semLivre', 'carencia']);

/**
 * [NOVO] Troca o motivo de um callback de fila numa célula: tira o antigo (se havia) e põe o novo
 * (null = só tira, ex.: virou invisível).
 * @param {Record<string, Record<string, number>>} motivos - por célula ("livres|robôs|status")
 */
function trocarMotivo(motivos, k, antigo, novo) {
  if (antigo === novo || !k) return false;
  const c = (motivos[k] ??= {});
  if (antigo && c[antigo]) c[antigo] -= 1;
  if (novo) c[novo] = (c[novo] ?? 0) + 1;
  return true;
}

function somarMotivos(lista) {
  const total = {};
  for (const motivos of lista) {
    for (const [k, c] of Object.entries(motivos ?? {})) {
      for (const [m, n] of Object.entries(c ?? {})) {
        if (!n) continue;
        (total[k] ??= {})[m] = (total[k][m] ?? 0) + n;
      }
    }
  }
  return total;
}

function somarMapas(mapas) {
  const total = {};
  for (const mapa of mapas) {
    for (const [k, c] of Object.entries(mapa ?? {})) {
      const t = (total[k] ??= { leads: 0, fila: 0, invisiveis: 0 });
      t.leads += c.leads ?? 0;
      t.fila += c.fila ?? 0;
      t.invisiveis += c.invisiveis ?? 0;
    }
  }
  return total;
}

/**
 * A grade inteira (livres × robôs), de um status ou de todos.
 * @returns {Array<{ livres, robos, leads, fila, invisiveis, taxaFila: number|null, amostra: 'vazia'|'pouca'|'ok' }>}
 */
function celulas(mapa, { status = null } = {}) {
  const grade = [];
  for (const livres of FAIXAS_LIVRES) {
    for (const robos of FAIXAS_ROBOS) {
      const c = { leads: 0, fila: 0, invisiveis: 0 };
      for (const s of status ? [status] : STATUS) {
        const v = mapa?.[`${livres}|${robos}|${s}`];
        if (!v) continue;
        c.leads += v.leads ?? 0;
        c.fila += v.fila ?? 0;
        c.invisiveis += v.invisiveis ?? 0;
      }
      const total = c.leads + c.fila;
      grade.push({
        livres, robos, ...c,
        taxaFila: total ? c.fila / total : null,
        amostra: total === 0 ? 'vazia' : total < AMOSTRA_MINIMA ? 'pouca' : 'ok',
      });
    }
  }
  return grade;
}

module.exports = {
  faixaDeLivres, faixaDeRobos, chave, anotar, somarMapas, celulas, trocarMotivo, somarMotivos, FAIXAS_LIVRES, FAIXAS_ROBOS, STATUS, AMOSTRA_MINIMA, MOTIVOS_FILA,
};
