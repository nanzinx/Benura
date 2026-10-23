/**
 * [NOVO] Status da URA: fechado mostra só "URA CALMA" (e o cadeado no modo manual);
 * aberto, as opções Automático / URA Calma / URA Normal / URA Agressiva, com o tempo
 * no status atual ao lado da opção ativa. O status vem do backend (o mesmo para todos).
 * Fecha ao escolher, ao clicar fora ou com Esc.
 */

import { clsx } from 'clsx';
import { Check, ChevronDown, Lock, Wand2 } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { useStatusUra, useVisao } from '../dados';
import { semAcesso, usePode } from '../sessao';
import { duracao } from '../formatos';
import type { EstadoTermometro, StatusDaUra } from '../tipos';

export const NOMES_DA_URA: Record<EstadoTermometro, string> = { calma: 'URA Calma', normal: 'URA Normal', agressiva: 'URA Agressiva', medindo: 'URA Medindo' };
export const CORES_DA_URA: Record<EstadoTermometro, string> = {
  calma: 'border-emerald-300 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/60 dark:text-emerald-200',
  normal: 'border-azul-200 bg-azul-50 text-azul-800 dark:border-noite-600 dark:bg-noite-800 dark:text-azul-200',
  agressiva: 'border-red-300 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/60 dark:text-red-300',
  medindo: 'border-slate-300 bg-slate-50 text-slate-600 dark:border-noite-600 dark:bg-noite-800 dark:text-slate-300',
};
const OPCOES: { id: 'automatico' | StatusDaUra; texto: string }[] = [
  { id: 'automatico', texto: 'Automático' },
  { id: 'calma', texto: 'URA Calma' },
  { id: 'normal', texto: 'URA Normal' },
  { id: 'agressiva', texto: 'URA Agressiva' },
];

export function StatusUra() {
  const { data: v } = useVisao();
  const s = v?.servicos.rodizio.dados?.statusUra;
  const mutacao = useStatusUra();
  const pode = usePode('supervisor');
  const [aberto, setAberto] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);
  const idMenu = useId();

  useEffect(() => {
    if (!aberto) return undefined;
    const fora = (e: MouseEvent) => { if (!raiz.current?.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc); };
  }, [aberto]);

  if (!s) return null;
  const manual = s.modo === 'manual';
  const ativa = manual ? (s.status as StatusDaUra) : 'automatico';
  const tempo = s.desde ? duracao((Date.now() - new Date(s.desde).getTime()) / 1000) : null;
  const auto = s.automatico;

  const escolher = (id: 'automatico' | StatusDaUra) => {
    setAberto(false);
    if (id === ativa) return;
    mutacao.mutate(id === 'automatico' ? { modo: 'automatico' } : { modo: 'manual', status: id });
  };

  return (
    <div ref={raiz} className="relative inline-block">
      <button type="button" onClick={() => setAberto((a) => !a)} aria-haspopup="menu" aria-expanded={aberto} aria-controls={idMenu}
        disabled={mutacao.isPending || !pode}
        title={!pode ? `${manual ? 'Fixado pela supervisão' : 'Automático (termômetro)'} · ${semAcesso('supervisor')} troca` : manual ? 'Status fixado pela supervisão (modo manual). Clique para trocar.' : 'Status automático (termômetro). Clique para trocar.'}
        className={clsx('inline-flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-1.5 text-sm font-bold tracking-wide uppercase disabled:cursor-default', pode && 'disabled:opacity-60', CORES_DA_URA[s.status])}>
        {manual && <Lock className="size-3.5" aria-label="manual" />}
        {NOMES_DA_URA[s.status]}
        {pode && <ChevronDown className={clsx('size-4 transition-transform', aberto && 'rotate-180')} aria-hidden />}
      </button>
      {aberto && (
        <div id={idMenu} role="menu" className="absolute left-0 z-40 mt-1.5 w-72 animate-entrar rounded-xl border border-slate-200 bg-white p-1.5 text-sm shadow-xl dark:border-noite-700 dark:bg-noite-900">
          {OPCOES.map((o) => {
            const atual = o.id === ativa;
            return (
              <button key={o.id} type="button" role="menuitemradio" aria-checked={atual} onClick={() => escolher(o.id)}
                className={clsx('flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-noite-800', atual && 'bg-azul-50 font-semibold dark:bg-noite-800')}>
                {o.id === 'automatico' ? <Wand2 className="size-4 text-slate-400" aria-hidden /> : <span className={clsx('size-2.5 rounded-full border', CORES_DA_URA[o.id])} aria-hidden />}
                <span className="flex-1">{o.texto}</span>
                {atual && tempo && <span className="text-xs font-normal text-slate-500 tabular-nums dark:text-slate-400">há {tempo}</span>}
                {atual && <Check className="size-4 text-azul-600 dark:text-azul-300" aria-hidden />}
              </button>
            );
          })}
          <p className="mt-1 border-t border-slate-100 px-3 pt-2 pb-1 text-xs text-slate-500 dark:border-noite-800 dark:text-slate-400">
            {manual
              ? `Fixado${s.por ? ` por ${s.por}` : ''}: o termômetro fica de lado até escolher "Automático".`
              : 'Automático: pelo tempo que os livres esperam por uma ligação.'}
            {auto && ` Termômetro: ${NOMES_DA_URA[auto.estado].toLowerCase()}${auto.esperaSeg != null ? `, espera média ${auto.esperaSeg} s (${auto.janelaMin} min)` : ''}.`}
          </p>
        </div>
      )}
    </div>
  );
}
