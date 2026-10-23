/** [NOVO] Janela modal (dialog nativo) no mesmo estilo da confirmação: corpo e rodapé com os botões. */

import { useEffect, useRef, type FormEvent, type ReactNode } from 'react';

export function Dialogo({ titulo, icone, children, rodape, fechar, aoEnviar, largura = 480 }: {
  titulo: string;
  icone?: ReactNode;
  children: ReactNode;
  rodape: ReactNode;
  fechar: () => void;
  /** com aoEnviar, o conteúdo é um formulário (Enter envia) */
  aoEnviar?: () => void;
  largura?: number;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { ref.current?.showModal(); }, []);
  const conteudo = (
    <>
      <div className="p-6">
        {icone && <div className="mb-3 grid size-11 place-items-center rounded-xl bg-azul-50 text-azul-600 dark:bg-noite-800 dark:text-azul-300">{icone}</div>}
        <h2 className="mb-3 text-lg font-semibold">{titulo}</h2>
        <div className="text-sm text-slate-600 dark:text-slate-300">{children}</div>
      </div>
      <div className="flex flex-wrap justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-noite-700 dark:bg-noite-950/40">{rodape}</div>
    </>
  );
  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); fechar(); }} style={{ width: `min(${largura}px, calc(100% - 32px))` }}
      className="m-auto animate-entrar rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-marinho-950/50 backdrop:backdrop-blur-sm dark:border-noite-700 dark:bg-noite-900 dark:text-slate-100">
      {aoEnviar ? <form onSubmit={(e: FormEvent) => { e.preventDefault(); aoEnviar(); }}>{conteudo}</form> : conteudo}
    </dialog>
  );
}

export const CAMPO = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 font-normal text-slate-900 dark:border-noite-600 dark:bg-noite-950 dark:text-slate-100';

export function Campo({ rotulo, dica, children }: { rotulo: string; dica?: ReactNode; children: ReactNode }) {
  return (
    <label className="grid gap-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">
      {rotulo}
      {children}
      {dica && <span className="text-xs font-normal text-slate-500 dark:text-slate-400">{dica}</span>}
    </label>
  );
}
