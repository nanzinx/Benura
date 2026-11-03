/**
 * [NOVO] Saúde da Argus no painel: soma o que cada serviço viu nos últimos 15 min (roteador,
 * rodízio e robôs falam com a Argus cada um com o seu cliente). Diz se o problema é a Argus.
 */

import type { SaudeArgus, Visao } from './tipos';

export interface SaudeSomada {
  chamadas: number;
  erros: number;
  lentas: number;
  limites: number;
  seguradas: number;
  msMedio: number | null;
  pausaAte: string | null;
  ultimoErro: { em: string; texto: string } | null;
  porServico: { nome: string; s: SaudeArgus }[];
}

export function saudeDaArgus(v: Visao): SaudeSomada | null {
  const porServico = Object.values(v.servicos)
    .map((s) => ({ nome: s?.nome ?? '', s: (s?.online ? (s.dados as { saudeArgus?: SaudeArgus | null } | null)?.saudeArgus : null) ?? null }))
    .filter((x): x is { nome: string; s: SaudeArgus } => Boolean(x.s));
  if (!porServico.length) return null;
  const soma = (campo: 'chamadas' | 'erros' | 'lentas' | 'limites' | 'seguradas') => porServico.reduce((t, { s }) => t + s[campo], 0);
  const chamadas = soma('chamadas');
  const msSoma = porServico.reduce((t, { s }) => t + (s.msMedio ?? 0) * s.chamadas, 0);
  const maisNovo = <T,>(lista: (T | null)[], quando: (x: T) => string) => lista.filter((x): x is T => x != null).sort((a, b) => quando(b).localeCompare(quando(a)))[0] ?? null;
  return {
    chamadas,
    erros: soma('erros'),
    lentas: soma('lentas'),
    limites: soma('limites'),
    seguradas: soma('seguradas'),
    msMedio: chamadas ? Math.round(msSoma / chamadas) : null,
    pausaAte: maisNovo(porServico.map(({ s }) => s.pausaAte), (x) => x),
    ultimoErro: maisNovo(porServico.map(({ s }) => s.ultimoErro), (x) => x.em),
    porServico,
  };
}

/**
 * Faixa do topo (aparece em todas as abas): só quando a Argus pediu para desacelerar (HTTP 429). Essa
 * pausa muda o que o BenURA faz e tem hora para acabar. A taxa de erro fica na aba Serviços (falhasDaArgus).
 */
export function problemaNaArgus(s: SaudeSomada | null, agora = Date.now()): { titulo: string; detalhe: string } | null {
  if (!s?.pausaAte || Date.parse(s.pausaAte) <= agora) return null;
  return {
    titulo: 'A Argus pediu para desacelerar (excesso de chamadas)',
    detalhe: `O BenURA espera até ${new Date(s.pausaAte).toLocaleTimeString('pt-BR')} para voltar a consultar; só desligar robôs segue na hora. Se repetir muito, veja a aba Serviços.`,
  };
}

/**
 * [NOVO] A Argus falhando muito (20% ou mais, com 10 chamadas ou mais, nos últimos 15 min): o aviso
 * no cartão da Argus (aba Serviços) e o pontinho na aba. Não vira faixa: sozinha, não para nada.
 */
export function falhasDaArgus(s: SaudeSomada | null): { pct: number; erros: number; chamadas: number } | null {
  if (!s || s.chamadas < 10) return null;
  const pct = Math.round((s.erros / s.chamadas) * 100);
  return pct >= 20 ? { pct, erros: s.erros, chamadas: s.chamadas } : null;
}
