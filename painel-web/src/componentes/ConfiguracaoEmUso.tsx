/**
 * [NOVO] "Configuração em uso" (aba Serviços, só administrador): cada opção que o BenURA
 * leu do .env, o valor em uso e o padrão. Segredos aparecem só como "definido" ou "vazio".
 * Começa recolhido: só busca quando alguém abre.
 */

import { useQuery } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { ChevronDown, Search, SlidersHorizontal } from 'lucide-react';
import { useState } from 'react';
import { api } from '../api';
import { horaCurta } from '../formatos';
import { Cartao, Esqueleto, Segmentado, Vazio } from '../ui/base';

type Filtro = 'mudadas' | 'todas';

export function ConfiguracaoEmUso() {
  const [aberto, setAberto] = useState(false);
  const [filtro, setFiltro] = useState<Filtro>('mudadas');
  const [busca, setBusca] = useState('');
  const { data, isLoading, isError } = useQuery({ queryKey: ['configuracao'], queryFn: api.configuracao, enabled: aberto, staleTime: 60_000 });

  const mudou = (o: { doEnv: boolean; valor: string; padrao: string }) => o.doEnv && o.valor !== o.padrao;
  const opcoes = data?.opcoes ?? [];
  const termo = busca.trim().toUpperCase();
  const lista = opcoes.filter((o) => (filtro === 'todas' || mudou(o)) && (!termo || o.nome.includes(termo)));
  const qtdMudadas = opcoes.filter(mudou).length;

  const alternar = (
    <button type="button" onClick={() => setAberto((a) => !a)} aria-expanded={aberto}
      className="inline-flex items-center gap-2 font-semibold text-slate-900 dark:text-slate-100">
      <SlidersHorizontal className="size-5 text-azul-600 dark:text-azul-300" aria-hidden />
      Configuração em uso
      <ChevronDown className={clsx('size-4 text-slate-400 transition-transform', aberto && 'rotate-180')} aria-hidden />
    </button>
  );

  return (
    <Cartao className="mb-5" titulo={alternar} extra={aberto && data ? (
      <>
        <label className="relative">
          <span className="sr-only">Buscar opção</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar"
            className="w-40 rounded-lg border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-sm dark:border-noite-600 dark:bg-noite-950" />
        </label>
        <Segmentado rotulo="Quais opções" valor={filtro} aoMudar={setFiltro}
          opcoes={[{ valor: 'mudadas', texto: `Só as que mudei (${qtdMudadas})` }, { valor: 'todas', texto: `Todas (${opcoes.length})` }]} />
      </>
    ) : undefined}>
      {!aberto ? (
        <p className="text-sm text-slate-500 dark:text-slate-400">Os valores que o BenURA está usando agora (tempo na URA, pânico, agenda, simulação...) e o padrão de cada um. Clique para abrir.</p>
      ) : isLoading ? <Esqueleto className="h-40 w-full" /> : isError || !data ? <Vazio>Não deu para ler a configuração.</Vazio> : (
        <>
          <p className="mb-3 text-sm text-slate-500 dark:text-slate-400">
            Lida do <code className="rounded bg-slate-200 px-1 text-xs dark:bg-noite-800">.env</code> às {horaCurta(data.lidaEm)}, quando o painel subiu.
            Mudou o <code className="rounded bg-slate-200 px-1 text-xs dark:bg-noite-800">.env</code>? Só vale depois de <code className="rounded bg-slate-200 px-1 text-xs dark:bg-noite-800">npx pm2 restart all</code>.
            Senhas e tokens aparecem só como "definido" ou "vazio".
          </p>
          {data.avisos.length > 0 && (
            <ul className="mb-4 grid gap-2">
              {data.avisos.map((a) => (
                <li key={a.texto} className={clsx('rounded-lg border px-3 py-2 text-sm',
                  a.nivel === 'fatal' ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-900 dark:bg-red-950/50 dark:text-red-300'
                    : 'border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-200')}>
                  <b>{a.nivel === 'fatal' ? 'Impede de subir' : 'Aviso'} ({a.servicos.join(', ')}):</b> {a.texto}
                </li>
              ))}
            </ul>
          )}
          {lista.length ? (
            <div className="max-h-[520px] overflow-auto rounded-lg border border-slate-200 dark:border-noite-700">
              <table className="w-full text-sm">
                <thead className="sticky top-0 bg-slate-50 text-left text-xs text-slate-500 uppercase dark:bg-noite-900 dark:text-slate-400">
                  <tr><th className="px-3 py-2 font-semibold">Opção</th><th className="px-3 py-2 font-semibold">Em uso</th><th className="px-3 py-2 font-semibold">Padrão</th></tr>
                </thead>
                <tbody className="divide-y divide-slate-100 dark:divide-noite-800">
                  {lista.map((o) => (
                    <tr key={o.nome} className={clsx(mudou(o) && 'bg-sky-50/70 dark:bg-sky-950/30')}>
                      <td className="px-3 py-1.5 font-mono text-xs font-semibold whitespace-nowrap">{o.nome}</td>
                      <td className="px-3 py-1.5 font-mono text-xs break-all">{o.valor || <span className="text-slate-400">(vazio)</span>}</td>
                      <td className="px-3 py-1.5 font-mono text-xs break-all text-slate-500 dark:text-slate-400">{o.padrao || '(vazio)'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <Vazio>{filtro === 'mudadas' && !termo ? 'Nenhuma opção mudada no .env: tudo no padrão.' : 'Nenhuma opção com esse nome.'}</Vazio>}
        </>
      )}
    </Cartao>
  );
}
