/**
 * [NOVO] Aba Ajuda: o manual da supervisão (o conteúdo fica em ajuda.ts), com busca.
 * Cada seção abre e fecha; com a busca, abrem todas as que acharam o termo.
 */

import { ChevronDown, LifeBuoy, Search } from 'lucide-react';
import { useState } from 'react';
import { filtrarAjuda } from '../ajuda';
import { Vazio } from '../ui/base';

export function Ajuda() {
  const [busca, setBusca] = useState('');
  const secoes = filtrarAjuda(busca);
  const buscando = busca.trim().length > 0;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="flex items-center gap-2 text-2xl font-bold tracking-tight"><LifeBuoy className="size-6 text-azul-600 dark:text-azul-300" aria-hidden />Ajuda</h1>
          <p className="text-sm text-slate-500 dark:text-slate-400">O que cada botão faz e o que cada número quer dizer.</p>
        </div>
        <label className="relative w-full sm:w-72">
          <span className="sr-only">Buscar na ajuda</span>
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar (ex.: pânico, TME, pausa)"
            className="w-full rounded-lg border border-slate-300 bg-white py-2 pr-3 pl-9 text-sm dark:border-noite-600 dark:bg-noite-950" />
        </label>
      </div>
      {secoes.length ? (
        <div className="grid gap-3">
          {secoes.map((s) => (
            <details key={`${s.id}-${buscando}`} open={buscando} className="cartao group p-0">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden">
                <span>
                  <span className="block font-semibold">{s.titulo}</span>
                  <span className="block text-xs text-slate-500 dark:text-slate-400">{s.onde}</span>
                </span>
                <ChevronDown className="size-4 shrink-0 text-slate-400 transition-transform group-open:rotate-180" aria-hidden />
              </summary>
              <ul className="grid list-disc gap-1.5 border-t border-slate-100 px-4 py-3 pl-9 text-sm leading-relaxed dark:border-noite-800">
                {s.itens.map((item) => <li key={item}>{item}</li>)}
              </ul>
            </details>
          ))}
        </div>
      ) : <Vazio>Nada na ajuda com "{busca}". Tente outra palavra.</Vazio>}
    </>
  );
}
