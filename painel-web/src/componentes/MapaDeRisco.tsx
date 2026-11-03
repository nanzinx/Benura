/**
 * [NOVO] Mapa de risco dos robôs (relatório de 7 e 30 dias): livres × robôs ligados → quanto custou
 * em callback de fila. A meta é 1 em 200 (0,5%). Etapa 1: só mostra; o automático ainda não usa.
 */

import { clsx } from 'clsx';
import { useState } from 'react';
import { celulasDoMapa, FAIXAS_LIVRES, FAIXAS_ROBOS, nivelDaCelula, resumoDoMapa, taxaEmTexto, type NivelDaCelula } from '../mapa-risco';
import type { MapaDeRisco as Mapa, StatusDoMapa } from '../tipos';
import { Segmentado } from '../ui/base';

const COR: Record<NivelDaCelula, string> = {
  bom: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100',
  atencao: 'bg-amarelo-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100',
  ruim: 'bg-red-50 text-red-900 dark:bg-red-950/60 dark:text-red-100',
  pouca: 'bg-slate-50 text-slate-500 dark:bg-noite-800/60 dark:text-slate-400',
  vazia: 'text-slate-300 dark:text-noite-600',
};

const nomeDosLivres = (l: string) => (l === '4+' ? '4 ou mais livres' : `${l} livre${l === '1' ? '' : 's'}`);
const nomeDosRobos = (r: string) => (r === '0' ? 'nenhum robô' : `${r} robôs`);

export function MapaDeRisco({ mapa, semFoto = 0 }: { mapa: Mapa | undefined; semFoto?: number }) {
  const [status, setStatus] = useState<StatusDoMapa | 'todos'>('todos');
  const filtro = status === 'todos' ? null : status;
  const celulas = celulasDoMapa(mapa, filtro);
  const resumo = resumoDoMapa(mapa, filtro);
  const de = (livres: string, robos: string) => celulas.find((c) => c.livres === livres && c.robos === robos)!;

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="max-w-2xl text-sm text-slate-600 dark:text-slate-300">
          Para cada tanto de gente livre e de robôs ligados, quantos callbacks de fila houve a cada lead. A meta é <b>1 em 200</b> (0,5%).
          Ainda não muda os robôs: com dados de umas duas semanas, o automático poderá ligar o máximo que fica no verde.
        </p>
        <Segmentado rotulo="Status da URA no mapa" valor={status} aoMudar={setStatus}
          opcoes={[{ valor: 'todos', texto: 'Todos' }, { valor: 'calma', texto: 'Calma' }, { valor: 'normal', texto: 'Normal' }, { valor: 'agressiva', texto: 'Agressiva' }]} />
      </div>
      <div className="overflow-x-auto">
        <table className="tabela tabela-cartoes sm:whitespace-nowrap">
          <thead><tr>
            <th>Livres</th>
            {FAIXAS_ROBOS.map((r) => <th key={r} className="text-center">{r === '0' ? 'sem robô' : `${r} robôs`}</th>)}
          </tr></thead>
          <tbody>
            {FAIXAS_LIVRES.map((l) => (
              <tr key={l}>
                <td data-rotulo="Livres" className="font-semibold whitespace-nowrap">{nomeDosLivres(l)}</td>
                {FAIXAS_ROBOS.map((r) => {
                  const c = de(l, r);
                  const nivel = nivelDaCelula(c);
                  return (
                    <td key={r} data-rotulo={nomeDosRobos(r)} className="p-1 text-center"
                      title={`${nomeDosLivres(l)}, ${nomeDosRobos(r)}: ${c.leads} lead(s), ${c.fila} callback(s) de fila, ${c.invisiveis} invisível(is)${nivel === 'pouca' ? ' (pouca amostra: menos de 50 ligações)' : ''}`}>
                      <span className={clsx('block rounded-lg px-2 py-1.5 tabular-nums', COR[nivel])}>
                        <b className="block text-sm">{nivel === 'vazia' ? '·' : taxaEmTexto(c)}</b>
                        {nivel !== 'vazia' && <span className="block text-[11px] opacity-80">{c.leads} leads · {c.fila} cb</span>}
                      </span>
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-slate-500 dark:text-slate-400">
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-emerald-100 dark:bg-emerald-900" aria-hidden />até 0,5% (meta)</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-amarelo-100 dark:bg-amber-900" aria-hidden />até 1%</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-red-100 dark:bg-red-900" aria-hidden />acima de 1%</span>
        <span className="inline-flex items-center gap-1.5"><span className="size-3 rounded bg-slate-100 dark:bg-noite-700" aria-hidden />pouca amostra (menos de 50)</span>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300">
        No período: <b>{resumo.leads}</b> leads e <b>{resumo.fila}</b> callback(s) de fila
        {resumo.porDuzentos != null && <> ({String(resumo.porDuzentos).replace('.', ',')} a cada 200)</>}.
        {' '}<b>{resumo.invisiveis}</b> invisível(is): havia gente livre e a ligação não chegou. Esses não dependem dos robôs (telefonia ou Argus).
        {semFoto > 0 && <span className="text-slate-500 dark:text-slate-400"> {semFoto} ligação(ões) logo depois de um reinício ficaram fora do mapa.</span>}
      </p>
    </div>
  );
}
