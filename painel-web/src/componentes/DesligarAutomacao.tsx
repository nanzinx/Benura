/** Botão vermelho do topo e a confirmação forte (digitar DESLIGAR). */

import { Power } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { useAutomacao, useVisao } from '../dados';
import { Botao } from '../ui/base';

const PALAVRA = 'DESLIGAR';

function Dialogo({ fechar }: { fechar: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const [texto, setTexto] = useState('');
  const mutacao = useAutomacao();
  useEffect(() => { ref.current?.showModal(); }, []);
  const confirmar = () => mutacao.mutate(false, { onSettled: fechar });
  return (
    <dialog ref={ref} onCancel={(e) => { e.preventDefault(); fechar(); }}
      className="m-auto w-[min(480px,calc(100%-32px))] animate-entrar rounded-2xl border border-slate-200 bg-white p-0 text-slate-900 shadow-2xl backdrop:bg-marinho-950/60 backdrop:backdrop-blur-sm dark:border-noite-700 dark:bg-noite-900 dark:text-slate-100">
      <div className="p-6">
        <div className="mb-3 grid size-11 place-items-center rounded-xl bg-red-50 text-red-700 dark:bg-red-950 dark:text-red-300"><Power className="size-5" aria-hidden /></div>
        <h2 className="mb-2 text-lg font-semibold">Desligar a automação?</h2>
        <ol className="mb-4 grid list-decimal gap-1.5 pl-5 text-sm text-slate-600 dark:text-slate-300">
          <li>Os robôs são desligados: os parados na hora; os em ligação terminam a chamada (até 90 s) e saem.</li>
          <li>O roteador, o rodízio e as rotinas param. Ninguém mais é movido entre Ativo e URA.</li>
          <li>Fica desligado mesmo se o PC reiniciar, até alguém clicar em <b>Religar automação</b> aqui no painel.</li>
        </ol>
        <label className="grid gap-1.5 text-sm font-semibold">
          Para confirmar, digite {PALAVRA}
          <input value={texto} onChange={(e) => setTexto(e.target.value.toUpperCase())} autoFocus autoComplete="off" spellCheck={false}
            className="rounded-lg border border-slate-300 bg-white px-3 py-2.5 font-mono tracking-widest dark:border-noite-600 dark:bg-noite-950"
            onKeyDown={(e) => { if (e.key === 'Enter' && texto === PALAVRA) confirmar(); }} />
        </label>
      </div>
      <div className="flex justify-end gap-2 border-t border-slate-200 bg-slate-50 px-6 py-4 dark:border-noite-700 dark:bg-noite-950/40">
        <Botao variante="secundario" onClick={fechar}>Cancelar</Botao>
        <Botao variante="perigo" icone={<Power className="size-4" />} disabled={texto !== PALAVRA} carregando={mutacao.isPending} onClick={confirmar}>Desligar automação</Botao>
      </div>
    </dialog>
  );
}

export function BotaoDesligarAutomacao() {
  const { data: v } = useVisao();
  const [aberto, setAberto] = useState(false);
  if (!v || (v.automacao && v.automacao.estado !== 'ligada')) return null;
  return (
    <>
      <button type="button" onClick={() => setAberto(true)} title="Desligar a automação (robôs e serviços)"
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-red-600 px-2.5 py-1.5 text-sm font-semibold text-white hover:bg-red-700 sm:px-3">
        <Power className="size-4" aria-hidden /><span className="hidden md:inline">Desligar automação</span>
      </button>
      {aberto && <Dialogo fechar={() => setAberto(false)} />}
    </>
  );
}
