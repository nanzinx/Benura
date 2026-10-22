/**
 * [NOVO] Quem está no Ativo agora (aba Receptivo), para trazer alguém para a URA à mão.
 * Fechado mostra só a contagem; aberto, a lista com busca e o menu de ações de cada um.
 */

import { clsx } from 'clsx';
import { ChevronDown, Lock, Search } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { OperadorNoAtivo } from '../tipos';
import { Cartao, Vazio } from '../ui/base';
import { AcoesAtendente } from './AcoesAtendente';

export function NoAtivo({ lista }: { lista: OperadorNoAtivo[] }) {
  const [aberto, setAberto] = useState(false);
  const [busca, setBusca] = useState('');
  const travados = lista.filter((o) => o.travado).length;
  const filtrados = useMemo(() => {
    const t = busca.trim().toLowerCase();
    return [...lista]
      .filter((o) => !t || (o.nome ?? '').toLowerCase().includes(t) || o.ramal.includes(t) || (o.grupoDesc ?? '').toLowerCase().includes(t))
      .sort((a, b) => Number(Boolean(b.travado)) - Number(Boolean(a.travado)) || String(a.nome ?? a.ramal).localeCompare(String(b.nome ?? b.ramal), 'pt-BR'));
  }, [lista, busca]);

  return (
    <Cartao
      titulo={(
        <button type="button" onClick={() => setAberto((a) => !a)} aria-expanded={aberto} className="inline-flex cursor-pointer items-center gap-2">
          No Ativo agora
          <ChevronDown className={clsx('size-4 transition-transform', aberto && 'rotate-180')} aria-hidden />
        </button>
      )}
      extra={<span>{lista.length} atendente(s){travados ? ` · ${travados} travado(s) à mão` : ''}</span>}
    >
      {!aberto ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Abra para trazer alguém do Ativo para a URA à mão (fica lá até liberar).</p>
      ) : (
        <>
          <label className="relative mb-3 block">
            <span className="sr-only">Buscar no Ativo</span>
            <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
            <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nome, ramal ou grupo"
              className="w-full rounded-lg border border-slate-300 bg-white py-2 pr-3 pl-9 text-sm dark:border-noite-600 dark:bg-noite-900" />
          </label>
          {filtrados.length ? (
            <ul className="grid max-h-96 gap-1 overflow-y-auto sm:grid-cols-2">
              {filtrados.map((o) => (
                <li key={o.ramal} className="flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-1.5 dark:border-noite-700">
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium">{o.nome ?? `Ramal ${o.ramal}`}</span>
                    <span className="block truncate text-xs text-slate-500 tabular-nums dark:text-slate-400">{o.ramal}{o.grupoDesc ? ` · ${o.grupoDesc}` : ''}</span>
                  </span>
                  {o.travado === 'ativo' && (
                    <span title="Travado no Ativo à mão: o rodízio não sobe até liberar" className="inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-700 dark:bg-noite-800 dark:text-slate-200">
                      <Lock className="size-3" aria-hidden /> Travado
                    </span>
                  )}
                  <AcoesAtendente a={{ ramal: o.ramal, nome: o.nome, onde: 'ativo', travado: o.travado }} />
                </li>
              ))}
            </ul>
          ) : <Vazio>{lista.length ? 'Ninguém com esse nome no Ativo.' : 'Ninguém no Ativo agora.'}</Vazio>}
        </>
      )}
    </Cartao>
  );
}
