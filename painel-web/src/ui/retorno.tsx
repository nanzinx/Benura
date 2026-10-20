/** Avisos rápidos (toasts) e a confirmação antes de comandos que mexem na URA. */

import { clsx } from 'clsx';
import { CheckCircle2, CircleAlert, X } from 'lucide-react';
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { Botao } from './base';

interface Toast { id: number; tipo: 'ok' | 'erro'; texto: string }
interface Confirmacao { titulo: string; texto: ReactNode; confirmar: string; perigo?: boolean; resolver: (sim: boolean) => void }

interface Retorno {
  avisar: (tipo: Toast['tipo'], texto: string) => void;
  confirmar: (c: Omit<Confirmacao, 'resolver'>) => Promise<boolean>;
}

const Contexto = createContext<Retorno | null>(null);

export function useRetorno(): Retorno {
  const r = useContext(Contexto);
  if (!r) throw new Error('useRetorno fora do <ProvedorDeRetorno>');
  return r;
}

export function ProvedorDeRetorno({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [pergunta, setPergunta] = useState<Confirmacao | null>(null);
  const proximo = useRef(1);

  const avisar = useCallback((tipo: Toast['tipo'], texto: string) => {
    const id = proximo.current++;
    setToasts((t) => [...t.slice(-3), { id, tipo, texto }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), tipo === 'erro' ? 8000 : 4000);
  }, []);

  const confirmar = useCallback((c: Omit<Confirmacao, 'resolver'>) => new Promise<boolean>((resolver) => setPergunta({ ...c, resolver })), []);

  return (
    <Contexto.Provider value={{ avisar, confirmar }}>
      {children}
      <div className="pointer-events-none fixed inset-x-4 bottom-4 z-50 flex flex-col items-end gap-2 sm:inset-x-auto sm:right-6" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} role="status" className={clsx('pointer-events-auto flex max-w-sm animate-entrar items-start gap-3 rounded-xl px-4 py-3 text-sm font-medium text-white shadow-lg',
            t.tipo === 'ok' ? 'bg-marinho-900' : 'bg-red-700')}>
            {t.tipo === 'ok' ? <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-amarelo-400" aria-hidden /> : <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />}
            <span>{t.texto}</span>
            <button type="button" className="ml-1 cursor-pointer opacity-70 hover:opacity-100" aria-label="Fechar" onClick={() => setToasts((x) => x.filter((y) => y.id !== t.id))}>
              <X className="size-4" aria-hidden />
            </button>
          </div>
        ))}
      </div>
      {pergunta && <DialogoConfirmacao pergunta={pergunta} fechar={(sim) => { pergunta.resolver(sim); setPergunta(null); }} />}
    </Contexto.Provider>
  );
}

function DialogoConfirmacao({ pergunta, fechar }: { pergunta: Confirmacao; fechar: (sim: boolean) => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    ref.current?.showModal();
  }, []);
  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); fechar(false); }}
      className="m-auto w-[min(440px,calc(100%-32px))] animate-entrar rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-marinho-950/50 backdrop:backdrop-blur-sm dark:border-noite-700 dark:bg-noite-900 dark:text-slate-100"
    >
      <div className="p-6">
        <h2 className="mb-2 text-lg font-semibold">{pergunta.titulo}</h2>
        <div className="text-sm text-slate-600 dark:text-slate-300">{pergunta.texto}</div>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-noite-700 dark:bg-noite-950/40">
        <Botao variante="secundario" onClick={() => fechar(false)}>Cancelar</Botao>
        <Botao variante={pergunta.perigo ? 'perigo' : 'primario'} onClick={() => fechar(true)} autoFocus>{pergunta.confirmar}</Botao>
      </div>
    </dialog>
  );
}
