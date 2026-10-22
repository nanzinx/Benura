/**
 * [NOVO] Relatório do dia por atendente (aba Receptivo): tempo livre, em atendimento e
 * em pausa (abre por tipo), atendimentos, pausas estouradas, maior espera e quando foi
 * visto na URA. Ordena por qualquer coluna; a última linha soma o dia.
 * Conta só o tempo no grupo da URA (o BenURA lê o status de quem está nela).
 */

import { clsx } from 'clsx';
import { ArrowDown, ArrowUp, ChevronDown } from 'lucide-react';
import { Fragment, useMemo, useState } from 'react';
import { duracao, horaCurta, minutos } from '../formatos';
import type { AtendenteDoDia } from '../tipos';
import { Cartao, Vazio } from '../ui/base';

type Coluna = 'nome' | 'livreMin' | 'atendimentoMin' | 'pausaMin' | 'atendimentos' | 'pausasEstouradas' | 'maiorEsperaSeg' | 'primeiroEm';

const COLUNAS: { id: Coluna; texto: string; dica?: string; numero?: boolean; esconder?: string }[] = [
  { id: 'nome', texto: 'Atendente' },
  { id: 'livreMin', texto: 'Livre', numero: true, dica: 'Tempo livre na URA, esperando ligação.' },
  { id: 'atendimentoMin', texto: 'Em atendimento', numero: true, dica: 'Tempo em ligação na URA.' },
  { id: 'pausaMin', texto: 'Pausas', numero: true, dica: 'Tempo em pausa na URA (clique na linha para ver por tipo).' },
  { id: 'atendimentos', texto: 'Atend.', numero: true, dica: 'Ligações da URA que ele atendeu hoje.' },
  { id: 'pausasEstouradas', texto: 'Estouros', numero: true, dica: 'Pausas que passaram do limite (src/config/pausas.js).' },
  { id: 'maiorEsperaSeg', texto: 'Maior espera', numero: true, dica: 'O maior tempo livre seguido, esperando ligação.', esconder: 'hidden md:table-cell' },
  { id: 'primeiroEm', texto: 'Na URA', dica: 'Primeira e última vez visto no grupo da URA hoje.', esconder: 'hidden lg:table-cell' },
];

export function RelatorioAtendentes({ lista }: { lista: AtendenteDoDia[] | undefined }) {
  const [ordem, setOrdem] = useState<{ coluna: Coluna; desc: boolean }>({ coluna: 'nome', desc: false });
  const [aberto, setAberto] = useState<string | null>(null);

  const linhas = useMemo(() => [...(lista ?? [])].sort((a, b) => {
    const va = ordem.coluna === 'nome' ? (a.nome ?? a.ramal) : a[ordem.coluna] ?? '';
    const vb = ordem.coluna === 'nome' ? (b.nome ?? b.ramal) : b[ordem.coluna] ?? '';
    const c = typeof va === 'number' && typeof vb === 'number' ? va - vb : String(va).localeCompare(String(vb), 'pt-BR');
    return ordem.desc ? -c : c;
  }), [lista, ordem]);

  const total = useMemo(() => (lista ?? []).reduce((t, a) => ({
    livreMin: t.livreMin + a.livreMin, atendimentoMin: t.atendimentoMin + a.atendimentoMin, pausaMin: t.pausaMin + a.pausaMin,
    atendimentos: t.atendimentos + a.atendimentos, pausasEstouradas: t.pausasEstouradas + a.pausasEstouradas,
  }), { livreMin: 0, atendimentoMin: 0, pausaMin: 0, atendimentos: 0, pausasEstouradas: 0 }), [lista]);

  const ordenar = (coluna: Coluna) => setOrdem((o) => ({ coluna, desc: o.coluna === coluna ? !o.desc : coluna !== 'nome' }));

  return (
    <Cartao titulo="Relatório do dia por atendente" extra={<span>{linhas.length} atendente(s) · só o tempo na URA</span>}>
      {linhas.length ? (
        <>
        {/* Celular: um cartão por atendente (a tabela não cabe) */}
        <ul className="grid gap-2 sm:hidden">
          {linhas.map((a) => {
            const tipos = Object.entries(a.pausasMin).sort((x, y) => y[1] - x[1]);
            return (
              <li key={a.ramal} className="rounded-lg border border-slate-200 px-3 py-2.5 dark:border-noite-700">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="font-medium">{a.nome ?? a.ramal}</span>
                  <span className="text-xs text-slate-500 tabular-nums dark:text-slate-400">{horaCurta(a.primeiroEm)}–{horaCurta(a.ultimoEm)}</span>
                </div>
                <dl className="mt-1.5 grid grid-cols-3 gap-x-3 gap-y-1 text-sm">
                  <div><dt className="rotulo">Livre</dt><dd className="tabular-nums">{minutos(a.livreMin)}</dd></div>
                  <div><dt className="rotulo">Atendendo</dt><dd className="tabular-nums">{minutos(a.atendimentoMin)}</dd></div>
                  <div><dt className="rotulo">Pausas</dt><dd className="tabular-nums">{minutos(a.pausaMin)}</dd></div>
                  <div><dt className="rotulo">Atend.</dt><dd className="font-semibold tabular-nums">{a.atendimentos}</dd></div>
                  <div><dt className="rotulo">Estouros</dt><dd className={clsx('tabular-nums', a.pausasEstouradas > 0 && 'font-bold text-red-700 dark:text-red-300')}>{a.pausasEstouradas}</dd></div>
                  <div><dt className="rotulo">Maior espera</dt><dd className="tabular-nums">{a.maiorEsperaSeg ? duracao(a.maiorEsperaSeg) : '–'}</dd></div>
                </dl>
                {tipos.length > 0 && (
                  <p className="mt-1.5 text-xs text-slate-500 dark:text-slate-400">{tipos.map(([tipo, min]) => `${tipo} ${minutos(min)}`).join(' · ')}</p>
                )}
              </li>
            );
          })}
          <li className="rounded-lg bg-slate-50 px-3 py-2 text-sm font-semibold dark:bg-noite-800">
            Total: {minutos(total.livreMin)} livre · {minutos(total.atendimentoMin)} atendendo · {minutos(total.pausaMin)} em pausa · {total.atendimentos} atend.
            {total.pausasEstouradas > 0 && <span className="text-red-700 dark:text-red-300"> · {total.pausasEstouradas} estouro(s)</span>}
          </li>
        </ul>
        <div className="-mx-1 hidden overflow-x-auto px-1 sm:block">
          <table className="tabela [&_td.numero]:whitespace-nowrap">
            <thead>
              <tr>
                {COLUNAS.map((c) => (
                  <th key={c.id} title={c.dica} className={clsx(c.numero && 'text-right', c.esconder)}
                    aria-sort={ordem.coluna === c.id ? (ordem.desc ? 'descending' : 'ascending') : 'none'}>
                    <button type="button" onClick={() => ordenar(c.id)} className={clsx('inline-flex cursor-pointer items-center gap-1 whitespace-nowrap uppercase', c.numero && 'flex-row-reverse')}>
                      {c.texto}
                      {ordem.coluna === c.id && (ordem.desc ? <ArrowDown className="size-3" aria-hidden /> : <ArrowUp className="size-3" aria-hidden />)}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {linhas.map((a) => {
                const tipos = Object.entries(a.pausasMin).sort((x, y) => y[1] - x[1]);
                const expandido = aberto === a.ramal;
                return (
                  <Fragment key={a.ramal}>
                    <tr className={clsx(tipos.length && 'cursor-pointer')} onClick={() => tipos.length && setAberto(expandido ? null : a.ramal)}>
                      <td>
                        <span className="font-medium">{a.nome ?? '—'}</span>
                        <span className="block text-xs text-slate-500 tabular-nums dark:text-slate-400">{a.ramal}</span>
                      </td>
                      <td className="numero text-right">{minutos(a.livreMin)}</td>
                      <td className="numero text-right">{minutos(a.atendimentoMin)}</td>
                      <td className="numero text-right">
                        <span className="inline-flex items-center gap-1">
                          {minutos(a.pausaMin)}
                          {a.pausaMin > 0 && <span className="text-xs text-slate-500 dark:text-slate-400">({a.pausaPct}%)</span>}
                          {tipos.length > 0 && <ChevronDown className={clsx('size-3.5 text-slate-400 transition-transform', expandido && 'rotate-180')} aria-hidden />}
                        </span>
                      </td>
                      <td className="numero text-right font-semibold">{a.atendimentos}</td>
                      <td className={clsx('numero text-right', a.pausasEstouradas > 0 && 'font-bold text-red-700 dark:text-red-300')}>{a.pausasEstouradas}</td>
                      <td className="numero hidden text-right md:table-cell">{a.maiorEsperaSeg ? duracao(a.maiorEsperaSeg) : '–'}</td>
                      <td className="hidden whitespace-nowrap text-sm text-slate-500 tabular-nums lg:table-cell dark:text-slate-400">
                        {horaCurta(a.primeiroEm)}–{horaCurta(a.ultimoEm)}
                      </td>
                    </tr>
                    {expandido && (
                      <tr className="bg-slate-50 dark:bg-noite-800/50">
                        <td colSpan={COLUNAS.length} className="text-sm">
                          <span className="font-semibold">Pausas de {a.nome ?? a.ramal}:</span>{' '}
                          {tipos.map(([tipo, min]) => `${tipo} ${minutos(min)}`).join(' · ')}
                          {a.outroMin > 0 && <span className="text-slate-500 dark:text-slate-400"> · outros status (tabulação etc.) {minutos(a.outroMin)}</span>}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="border-t-2 border-slate-200 font-semibold dark:border-noite-700">
                <td>Total do dia</td>
                <td className="numero text-right">{minutos(total.livreMin)}</td>
                <td className="numero text-right">{minutos(total.atendimentoMin)}</td>
                <td className="numero text-right">{minutos(total.pausaMin)}</td>
                <td className="numero text-right">{total.atendimentos}</td>
                <td className={clsx('numero text-right', total.pausasEstouradas > 0 && 'text-red-700 dark:text-red-300')}>{total.pausasEstouradas}</td>
                <td className="hidden md:table-cell" />
                <td className="hidden lg:table-cell" />
              </tr>
            </tfoot>
          </table>
        </div>
        </>
      ) : <Vazio>Ninguém passou pela URA hoje ainda.</Vazio>}
    </Cartao>
  );
}
