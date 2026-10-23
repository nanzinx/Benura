import { clsx } from 'clsx';
import { useId, useState, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { ChevronDown, Info, LoaderCircle } from 'lucide-react';

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

/** [NOVO] Lembra se um bloco está aberto (por navegador). Sem acesso ao armazenamento, só não lembra. */
export function useAberto(chave: string | undefined, padrao: boolean): [boolean, (v: boolean) => void] {
  const ler = () => {
    if (!chave) return padrao;
    try {
      const v = localStorage.getItem(`benura:aberto:${chave}`);
      return v == null ? padrao : v === '1';
    } catch {
      return padrao;
    }
  };
  const [aberto, setAberto] = useState(ler);
  const mudar = (v: boolean) => {
    setAberto(v);
    if (!chave) return;
    try { localStorage.setItem(`benura:aberto:${chave}`, v ? '1' : '0'); } catch { /* sem armazenamento */ }
  };
  return [aberto, mudar];
}

/**
 * [NOVO] Cartão que abre e fecha: o título e um resumo ficam sempre à vista; o conteúdo
 * só quando aberto. Lembra a escolha (`chave`).
 */
export function Recolhivel({ titulo, resumo, extra, children, chave, abertoPadrao = false, className, id }: {
  titulo: ReactNode; resumo?: ReactNode; extra?: ReactNode; children: ReactNode; chave?: string; abertoPadrao?: boolean; className?: string; id?: string;
}) {
  const [aberto, setAberto] = useAberto(chave, abertoPadrao);
  const idConteudo = useId();
  return (
    <section id={id} className={clsx('cartao min-w-0', className)}>
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <button type="button" onClick={() => setAberto(!aberto)} aria-expanded={aberto} aria-controls={idConteudo}
          className="group inline-flex cursor-pointer items-center gap-2 text-left">
          <ChevronDown className={clsx('size-4 text-slate-400 transition-transform duration-200 group-hover:text-azul-600 motion-reduce:transition-none', !aberto && '-rotate-90')} aria-hidden />
          <h2 className="text-base font-semibold">{titulo}</h2>
        </button>
        {extra && <div className="flex flex-wrap items-center gap-2 text-sm text-slate-500 dark:text-slate-400">{extra}</div>}
      </header>
      {resumo && <div className="mt-3">{resumo}</div>}
      {aberto && <div id={idConteudo} className="mt-4 animate-entrar">{children}</div>}
    </section>
  );
}

/** [NOVO] "ⓘ Como funciona": a explicação longa só quando pedida. */
export function ComoFunciona({ children, texto = 'Como funciona' }: { children: ReactNode; texto?: string }) {
  const [aberto, setAberto] = useState(false);
  return (
    <div className="text-sm">
      <button type="button" onClick={() => setAberto((a) => !a)} aria-expanded={aberto}
        className="inline-flex cursor-pointer items-center gap-1.5 font-medium text-azul-600 hover:underline dark:text-azul-300">
        <Info className="size-4" aria-hidden />{texto}
        <ChevronDown className={clsx('size-3.5 transition-transform motion-reduce:transition-none', aberto && 'rotate-180')} aria-hidden />
      </button>
      {aberto && (
        <div className="mt-2 grid animate-entrar gap-1.5 rounded-lg bg-slate-50 px-3 py-2.5 leading-relaxed text-slate-700 dark:bg-noite-800/60 dark:text-slate-300">
          {children}
        </div>
      )}
    </div>
  );
}

/** [NOVO] Mostra só os primeiros `limite` itens, com "ver todos (N)". */
export function VerMais<T>({ itens, limite, render, chave }: { itens: T[]; limite: number; render: (itens: T[]) => ReactNode; chave?: string }) {
  const [todos, setTodos] = useAberto(chave ? `todos:${chave}` : undefined, false);
  const visiveis = todos ? itens : itens.slice(0, limite);
  return (
    <>
      {render(visiveis)}
      {itens.length > limite && (
        <button type="button" onClick={() => setTodos(!todos)}
          className="mt-2 w-full cursor-pointer rounded-lg py-1.5 text-sm font-medium text-azul-600 hover:bg-azul-50 dark:text-azul-300 dark:hover:bg-noite-800">
          {todos ? 'Mostrar menos' : `Ver todos (${itens.length})`}
        </button>
      )}
    </>
  );
}
