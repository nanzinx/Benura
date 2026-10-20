import { clsx } from 'clsx';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { LoaderCircle } from 'lucide-react';

type Variante = 'primario' | 'perigo' | 'secundario' | 'fantasma';

const VARIANTES: Record<Variante, string> = {
  primario: 'bg-azul-600 text-white hover:bg-azul-700 dark:bg-azul-500 dark:hover:bg-azul-400',
  perigo: 'bg-red-700 text-white hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-500',
  secundario: 'border border-slate-300 bg-white text-slate-800 hover:border-azul-600 hover:text-azul-700 dark:border-noite-600 dark:bg-noite-900 dark:text-slate-100 dark:hover:border-azul-400 dark:hover:text-azul-300',
  fantasma: 'text-azul-600 hover:bg-azul-50 dark:text-azul-300 dark:hover:bg-noite-800',
};

export function Botao({ variante = 'primario', carregando = false, icone, className, children, disabled, ...resto }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variante?: Variante; carregando?: boolean; icone?: ReactNode }) {
  return (
    <button
      type="button"
      disabled={disabled || carregando}
      className={clsx('inline-flex min-h-10 cursor-pointer items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition-colors disabled:cursor-progress disabled:opacity-60', VARIANTES[variante], className)}
      {...resto}
    >
      {carregando ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : icone}
      {children}
    </button>
  );
}

export type Tom = 'neutro' | 'ok' | 'alerta' | 'perigo' | 'info';

const TONS: Record<Tom, string> = {
  neutro: 'bg-slate-100 text-slate-600 dark:bg-noite-800 dark:text-slate-300',
  ok: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300',
  alerta: 'bg-amber-50 text-amber-800 dark:bg-amber-950 dark:text-amber-200',
  perigo: 'bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300',
  info: 'bg-azul-50 text-azul-700 dark:bg-noite-800 dark:text-azul-300',
};

/** Selo com bolinha: estado de um interruptor, de um serviço, de um operador. */
export function Selo({ tom = 'neutro', children, pulsar = false, className }: { tom?: Tom; children: ReactNode; pulsar?: boolean; className?: string }) {
  return (
    <span className={clsx('inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold', TONS[tom], className)}>
      <span className="relative flex size-2">
        {pulsar && <span className="absolute inline-flex size-full animate-ping rounded-full bg-current opacity-60" />}
        <span className="relative inline-flex size-2 rounded-full bg-current" />
      </span>
      {children}
    </span>
  );
}

export function Cartao({ titulo, extra, children, className, id }: { titulo?: ReactNode; extra?: ReactNode; children: ReactNode; className?: string; id?: string }) {
  return (
    <section id={id} className={clsx('cartao min-w-0', className)}>
      {(titulo || extra) && (
        <header className="mb-4 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          {titulo && <h2 className="text-base font-semibold">{titulo}</h2>}
          {extra && <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400">{extra}</div>}
        </header>
      )}
      {children}
    </section>
  );
}

export function Vazio({ children }: { children: ReactNode }) {
  return <p className="rounded-lg border border-dashed border-slate-200 px-4 py-6 text-center text-sm text-slate-500 dark:border-noite-700 dark:text-slate-400">{children}</p>;
}

/** Controle segmentado (filtros de uma linha). */
export function Segmentado<T extends string>({ opcoes, valor, aoMudar, rotulo }: { opcoes: { valor: T; texto: string }[]; valor: T; aoMudar: (v: T) => void; rotulo: string }) {
  return (
    <div role="group" aria-label={rotulo} className="inline-flex overflow-hidden rounded-lg border border-slate-300 text-xs font-semibold dark:border-noite-600">
      {opcoes.map((o) => (
        <button
          key={o.valor}
          type="button"
          aria-pressed={valor === o.valor}
          onClick={() => aoMudar(o.valor)}
          className={clsx('cursor-pointer px-3 py-1.5 transition-colors not-first:border-l not-first:border-slate-300 dark:not-first:border-noite-600',
            valor === o.valor ? 'bg-azul-600 text-white dark:bg-azul-500' : 'bg-white text-slate-600 hover:bg-slate-50 dark:bg-noite-900 dark:text-slate-300 dark:hover:bg-noite-800')}
        >
          {o.texto}
        </button>
      ))}
    </div>
  );
}

export function Esqueleto({ className }: { className?: string }) {
  return <span className={clsx('inline-block animate-pulse rounded bg-slate-200 dark:bg-noite-800', className)} aria-hidden />;
}
