/**
 * [NOVO] Mapa de risco dos robôs (relatório de 7 e 30 dias): livres × robôs ligados → quanto custou
 * em callback de fila. A meta é 1 em 200 (0,5%). Etapa 1: só mostra; o automático ainda não usa.
 * Limpo de propósito: no topo um número só, na grade só a cor e o %, e o detalhe aparece ao tocar.
 */

import { clsx } from 'clsx';
import { CircleHelp, ShieldCheck, X } from 'lucide-react';
import { useState } from 'react';
import { celulasDoMapa, FAIXAS_LIVRES, FAIXAS_ROBOS, nivelDaCelula, pontoSeguro, resumoDoMapa, taxaEmTexto, type NivelDaCelula, type PontoSeguro } from '../mapa-risco';
import type { CelulaDoMapa, MapaDeRisco as Mapa, StatusDoMapa } from '../tipos';
import { Segmentado } from '../ui/base';

const COR: Record<NivelDaCelula, string> = {
  bom: 'bg-emerald-100 text-emerald-900 dark:bg-emerald-900/60 dark:text-emerald-100',
  atencao: 'bg-amber-100 text-amber-900 dark:bg-amber-900/60 dark:text-amber-100',
  ruim: 'bg-red-100 text-red-900 dark:bg-red-900/60 dark:text-red-100',
  pouca: 'bg-slate-100 text-slate-500 dark:bg-noite-800 dark:text-slate-400',
  vazia: 'border border-dashed border-slate-200 dark:border-noite-700',
};
const PONTO: Record<NivelDaCelula, string> = {
  bom: 'bg-emerald-500', atencao: 'bg-amber-500', ruim: 'bg-red-500', pouca: 'bg-slate-300 dark:bg-noite-600', vazia: '',
};
const FRASE: Record<NivelDaCelula, string> = {
  bom: 'dentro da meta', atencao: 'um pouco acima da meta', ruim: 'acima da meta', pouca: 'pouca amostra: ainda não dá para confiar', vazia: 'sem ligações',
};

const nomeDosLivres = (l: string) => (l === '4+' ? '4 ou mais livres' : `${l} livre${l === '1' ? '' : 's'}`);
const nomeDosRobos = (r: string) => (r === '0' ? 'nenhum robô' : r === '41+' ? '41 robôs ou mais' : `${r} robôs`);
const teto = (r: string) => (r === '41+' ? '41 ou mais robôs' : `até ${r.split('-')[1]} robôs`);
const virgula = (n: number) => String(n).replace('.', ',');

export function MapaDeRisco({ mapa, semFoto = 0 }: { mapa: Mapa | undefined; semFoto?: number }) {
  const [status, setStatus] = useState<StatusDoMapa | 'todos'>('todos');
  const [escolhida, setEscolhida] = useState<{ livres: string; robos: string } | null>(null);
  const [comoLer, setComoLer] = useState(false);
  const filtro = status === 'todos' ? null : status;
  const celulas = celulasDoMapa(mapa, filtro);
  const resumo = resumoDoMapa(mapa, filtro);
  const de = (livres: string, robos: string) => celulas.find((c) => c.livres === livres && c.robos === robos)!;
  const nivelGeral: NivelDaCelula = resumo.porDuzentos == null ? 'vazia' : resumo.porDuzentos <= 1 ? 'bom' : resumo.porDuzentos <= 2 ? 'atencao' : 'ruim';
  const atual = escolhida ? de(escolhida.livres, escolhida.robos) : null;

  return (
    <div className="grid gap-4">
      {/* o número do período e o filtro */}
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex items-baseline gap-2">
          <span className={clsx('text-3xl font-bold tabular-nums', {
            'text-emerald-600 dark:text-emerald-400': nivelGeral === 'bom',
            'text-amber-600 dark:text-amber-400': nivelGeral === 'atencao',
            'text-red-600 dark:text-red-400': nivelGeral === 'ruim',
            'text-slate-400': nivelGeral === 'vazia',
          })}>{resumo.porDuzentos == null ? '–' : virgula(resumo.porDuzentos)}</span>
          <span className="text-sm leading-tight text-slate-600 dark:text-slate-300">
            callback(s) de fila a cada 200 leads<br />
            <span className="text-xs text-slate-500 dark:text-slate-400">meta: 1 · {resumo.leads} leads e {resumo.fila} callback(s) no período</span>
          </span>
        </div>
        <Segmentado rotulo="Status da URA no mapa" valor={status} aoMudar={(v) => { setStatus(v); setEscolhida(null); }}
          opcoes={[{ valor: 'todos', texto: 'Todos' }, { valor: 'calma', texto: 'Calma' }, { valor: 'normal', texto: 'Normal' }, { valor: 'agressiva', texto: 'Agressiva' }]} />
      </div>

      {/* a grade: só a cor e o %; o detalhe aparece ao tocar */}
      <div role="grid" aria-label="Mapa de risco: livres × robôs ligados" className="grid grid-cols-[3.25rem_repeat(6,minmax(0,1fr))] gap-1 sm:grid-cols-[6.5rem_repeat(6,minmax(0,1fr))] sm:gap-1.5">
        <span className="self-end text-[10px] font-semibold uppercase tracking-wide text-slate-400 sm:text-xs">livres</span>
        {FAIXAS_ROBOS.map((r) => (
          <span key={r} className="self-end text-center text-[10px] font-semibold text-slate-500 sm:text-xs dark:text-slate-400">
            {r}
          </span>
        ))}
        {FAIXAS_LIVRES.map((l, li) => (
          <Linha key={`${l}-${status}`} livres={l} indice={li} de={de} escolhida={escolhida}
            aoEscolher={(robos) => setEscolhida(escolhida?.livres === l && escolhida.robos === robos ? null : { livres: l, robos })} />
        ))}
        <span />
        <span className="col-span-6 text-center text-[10px] text-slate-400 sm:text-xs">robôs ligados →</span>
      </div>

      {/* embaixo: o detalhe do quadrinho tocado ou, sem nenhum, o ponto seguro */}
      <div className="min-h-24 rounded-xl bg-slate-50 p-3 dark:bg-noite-800/60">
        {atual ? <Detalhe c={atual} aoFechar={() => setEscolhida(null)} /> : <PontosSeguros pontos={pontoSeguro(celulas)} />}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-xs text-slate-500 dark:text-slate-400">
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          {(['bom', 'atencao', 'ruim', 'pouca'] as const).map((n) => (
            <span key={n} className="inline-flex items-center gap-1"><span className={clsx('size-2.5 rounded-full', PONTO[n])} aria-hidden />
              {n === 'bom' ? 'até 0,5%' : n === 'atencao' ? 'até 1%' : n === 'ruim' ? 'acima de 1%' : 'pouca amostra'}
            </span>
          ))}
        </span>
        <button type="button" onClick={() => setComoLer(!comoLer)} aria-expanded={comoLer}
          className="inline-flex cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 font-medium text-azul-700 hover:bg-azul-50 dark:text-azul-300 dark:hover:bg-noite-800">
          <CircleHelp className="size-3.5" aria-hidden /> Como ler
        </button>
      </div>
      {comoLer && (
        <div className="animate-entrar grid gap-1.5 text-sm text-slate-600 dark:text-slate-300">
          <p>Cada quadrinho é um momento da URA: quanta gente estava livre (linha) e quantos robôs estavam ligados (coluna) quando o cliente entrou. O % é quantas dessas ligações viraram callback de fila. A meta é 1 a cada 200 (0,5%).</p>
          <p>Ainda não muda os robôs: com umas duas semanas de dados, o automático poderá ligar o máximo que fica no verde.</p>
          <p className="text-slate-500 dark:text-slate-400">
            <b>{resumo.invisiveis}</b> callback(s) invisível(is) ficaram fora da conta: tinha gente livre e a ligação não chegou (telefonia ou Argus), então não depende dos robôs.
            {semFoto > 0 && <> {semFoto} ligação(ões) logo depois de um reinício ficaram fora do mapa.</>}
          </p>
        </div>
      )}
    </div>
  );
}

function Linha({ livres, indice, de, escolhida, aoEscolher }: {
  livres: string; indice: number; de: (l: string, r: string) => CelulaDoMapa;
  escolhida: { livres: string; robos: string } | null; aoEscolher: (robos: string) => void;
}) {
  return (
    <>
      <span className="self-center text-xs font-semibold text-slate-700 sm:text-sm dark:text-slate-200">
        {livres}<span className="max-sm:hidden"> livre{livres === '1' ? '' : 's'}</span>
      </span>
      {FAIXAS_ROBOS.map((r, ri) => {
        const c = de(livres, r);
        const nivel = nivelDaCelula(c);
        const marcada = escolhida?.livres === livres && escolhida.robos === r;
        const apagada = escolhida && !marcada;
        if (nivel === 'vazia') return <span key={r} aria-hidden className={clsx('h-10 rounded-lg sm:h-12', COR.vazia)} />;
        return (
          <button key={r} type="button" onClick={() => aoEscolher(r)} aria-pressed={marcada}
            aria-label={`${nomeDosLivres(livres)}, ${nomeDosRobos(r)}: ${taxaEmTexto(c)}, ${FRASE[nivel]}`}
            style={{ animationDelay: `${(indice * 6 + ri) * 18}ms` }}
            className={clsx('animate-entrar [animation-duration:0.3s] [animation-fill-mode:backwards] h-10 cursor-pointer rounded-lg text-[11px] font-bold tabular-nums transition duration-150 sm:h-12 sm:text-sm',
              'hover:scale-[1.06] hover:shadow-md focus-visible:outline-2 focus-visible:outline-azul-500',
              COR[nivel], marcada && 'scale-[1.06] shadow-md ring-2 ring-azul-500 dark:ring-azul-300', apagada && 'opacity-45')}>
            {taxaEmTexto(c)}
          </button>
        );
      })}
    </>
  );
}

function Detalhe({ c, aoFechar }: { c: CelulaDoMapa; aoFechar: () => void }) {
  const nivel = nivelDaCelula(c);
  const total = c.leads + c.fila;
  const porDuzentos = total ? Math.round((c.fila / total) * 200 * 10) / 10 : 0;
  return (
    <div key={`${c.livres}|${c.robos}`} className="animate-entrar grid gap-2">
      <div className="flex items-start justify-between gap-2">
        <p className="text-sm font-semibold text-slate-800 dark:text-slate-100">
          {nomeDosLivres(c.livres)} com {nomeDosRobos(c.robos)}
        </p>
        <button type="button" onClick={aoFechar} aria-label="Fechar o detalhe" className="-m-1 cursor-pointer rounded-md p-1 text-slate-400 hover:bg-slate-200 dark:hover:bg-noite-700">
          <X className="size-4" aria-hidden />
        </button>
      </div>
      <p className="flex flex-wrap items-center gap-2 text-sm text-slate-600 dark:text-slate-300">
        <span className={clsx('rounded-md px-2 py-0.5 font-bold tabular-nums', COR[nivel])}>{taxaEmTexto(c)}</span>
        <span>{FRASE[nivel]}{nivel !== 'pouca' && <> · mais ou menos <b>{virgula(porDuzentos)}</b> a cada 200</>}</span>
      </p>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        {c.leads} lead(s) · {c.fila} callback(s) de fila{c.invisiveis ? ` · ${c.invisiveis} invisível(is), fora da conta` : ''}
      </p>
    </div>
  );
}

function PontosSeguros({ pontos }: { pontos: PontoSeguro[] }) {
  const algum = pontos.some((p) => p.ate || p.parou);
  return (
    <div className="grid gap-2">
      <p className="flex items-center gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
        <ShieldCheck className="size-4 text-emerald-600 dark:text-emerald-400" aria-hidden /> Até onde ficou na meta
        <span className="font-normal text-slate-500 dark:text-slate-400">· toque num quadrinho para ver o detalhe</span>
      </p>
      {algum ? (
        <ul className="flex flex-wrap gap-1.5 text-xs">
          {pontos.map((p) => (
            <li key={p.livres} className={clsx('rounded-full px-2.5 py-1', p.ate ? COR.bom : p.parou ? COR.ruim : COR.pouca)}>
              <b>{nomeDosLivres(p.livres)}:</b>{' '}
              {p.ate ? teto(p.ate) : p.parou ? `nem ${p.parou} robôs` : 'sem dados ainda'}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-xs text-slate-500 dark:text-slate-400">Ainda sem ligações suficientes (50 por quadrinho) para dizer. O mapa vai enchendo com os dias.</p>
      )}
    </div>
  );
}
