/**
 * Relatório do dia do pessoal do receptivo (aba Receptivo), visual e interativo:
 * - números do dia da equipe (atendimentos, ocupação, pausa, estouros);
 * - uma barra por atendente com o dia dele (livre, em atendimento, em pausa, outros),
 *   do tamanho do tempo que ficou na URA, com o valor de cada parte ao passar o mouse;
 * - busca, "só quem estourou", ordenação (atendimentos, ocupação, pausa, nome) e a lista
 *   desliza para a nova ordem;
 * - clicar abre o detalhe: pausas por tipo contra o limite, maior espera, média livre por
 *   atendimento e quando foi visto na URA;
 * - a visão "Tabela" mostra os mesmos números em colunas.
 * Conta só o tempo no grupo da URA (o BenURA lê o status de quem está nela).
 */

import { clsx } from 'clsx';
import { AlertTriangle, BarChart3, ChevronDown, Crown, Search, Table2 } from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import { duracao, horaCurta, limiteDaPausa, minutos } from '../formatos';
import type { AtendenteDoDia } from '../tipos';
import { Cartao, Segmentado, Vazio } from '../ui/base';
import { useFlip } from '../ui/flip';
import { TabelaAtendentes } from './TabelaAtendentes';

type Parte = 'livre' | 'atendimento' | 'pausa' | 'outro';

/** Cores das partes (validadas: claro em superfície branca, escuro em noite-900). A ordem é a da barra. */
const PARTES: { id: Parte; texto: string; cor: string; campo: keyof AtendenteDoDia }[] = [
  { id: 'atendimento', texto: 'Em atendimento', cor: 'bg-[#2f63d6] dark:bg-[#4f86f0]', campo: 'atendimentoMin' },
  { id: 'livre', texto: 'Livre', cor: 'bg-[#1baf7a] dark:bg-[#199e70]', campo: 'livreMin' },
  { id: 'pausa', texto: 'Em pausa', cor: 'bg-[#eda100] dark:bg-[#c98500]', campo: 'pausaMin' },
  { id: 'outro', texto: 'Outros status', cor: 'bg-[#6250d6] dark:bg-[#9085e9]', campo: 'outroMin' },
];

type Ordem = 'atendimentos' | 'ocupacao' | 'pausa' | 'nome';

const totalMin = (a: AtendenteDoDia) => a.livreMin + a.atendimentoMin + a.pausaMin + a.outroMin;
/** Do tempo disponível (livre + atendendo), quanto foi atendendo. */
const ocupacao = (a: AtendenteDoDia) => {
  const base = a.livreMin + a.atendimentoMin;
  return base > 0 ? Math.round((a.atendimentoMin / base) * 100) : 0;
};
const iniciais = (nome: string | null, ramal: string) => (nome ?? ramal).split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

function Numero({ rotulo, valor, nota, alerta }: { rotulo: string; valor: string | number; nota?: string; alerta?: boolean }) {
  return (
    <div className={clsx('rounded-xl border px-4 py-3', alerta
      ? 'border-red-200 bg-red-50 dark:border-red-900 dark:bg-red-950/40'
      : 'border-slate-200 bg-slate-50/60 dark:border-noite-700 dark:bg-noite-800/40')}>
      <span className="rotulo flex items-center gap-1">{alerta && <AlertTriangle className="size-3.5 text-red-600 dark:text-red-400" aria-hidden />}{rotulo}</span>
      <b className={clsx('block text-2xl tabular-nums', alerta && 'text-red-700 dark:text-red-300')}>{valor}</b>
      {nota && <span className="block text-xs leading-snug text-slate-500 dark:text-slate-400">{nota}</span>}
    </div>
  );
}

/** A barra do dia de um atendente: cada parte com o seu tamanho; o valor aparece ao passar o mouse (ou focar). */
function BarraDoDia({ a, escala, crescer }: { a: AtendenteDoDia; escala: number; crescer: boolean }) {
  const [ativa, setAtiva] = useState<Parte | null>(null);
  const total = totalMin(a);
  const partes = PARTES.map((p) => ({ ...p, min: Number(a[p.campo]) || 0 })).filter((p) => p.min > 0);
  const largura = escala > 0 ? Math.max(4, (total / escala) * 100) : 0;
  const mostrar = partes.find((p) => p.id === ativa);
  return (
    <div className="relative">
      <div className="flex h-3.5 overflow-hidden rounded-full bg-slate-100 dark:bg-noite-800" onMouseLeave={() => setAtiva(null)}>
        <div className="flex h-full gap-0.5 transition-[width] duration-700 ease-out" style={{ width: crescer ? `${largura}%` : '0%' }}>
          {partes.map((p, i) => (
            <span key={p.id} role="img" tabIndex={0} aria-label={`${p.texto}: ${minutos(p.min)}`}
              onMouseEnter={() => setAtiva(p.id)} onFocus={() => setAtiva(p.id)} onBlur={() => setAtiva(null)}
              className={clsx('h-full cursor-default outline-none transition-opacity focus-visible:ring-2 focus-visible:ring-azul-400',
                p.cor, i === 0 && 'rounded-l-full', i === partes.length - 1 && 'rounded-r-full', ativa && ativa !== p.id && 'opacity-40')}
              style={{ width: `${(p.min / total) * 100}%`, minWidth: 3 }} />
          ))}
        </div>
      </div>
      {mostrar && (
        <div role="tooltip" className="pointer-events-none absolute -top-9 left-0 z-10 whitespace-nowrap rounded-lg bg-marinho-900 px-2.5 py-1 text-xs font-medium text-white shadow-lg dark:bg-noite-700">
          {mostrar.texto}: <b className="tabular-nums">{minutos(mostrar.min)}</b> <span className="opacity-75">({Math.round((mostrar.min / total) * 100)}%)</span>
        </div>
      )}
    </div>
  );
}

function Detalhe({ a, limites }: { a: AtendenteDoDia; limites: Record<string, number> }) {
  const tipos = Object.entries(a.pausasMin).sort((x, y) => y[1] - x[1]);
  const mediaLivre = a.atendimentos ? (a.livreMin * 60) / a.atendimentos : null;
  return (
    <div className="mt-3 grid gap-4 rounded-xl bg-slate-50 p-4 text-sm sm:grid-cols-[1fr_1.4fr] dark:bg-noite-800/50">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 content-start">
        <div><dt className="rotulo">Na URA</dt><dd className="tabular-nums">{horaCurta(a.primeiroEm)} – {horaCurta(a.ultimoEm)}</dd></div>
        <div><dt className="rotulo">Tempo na URA</dt><dd className="tabular-nums">{minutos(totalMin(a))}</dd></div>
        <div><dt className="rotulo" title="Do tempo disponível (livre + atendendo), quanto foi atendendo">Ocupação</dt><dd className="tabular-nums">{ocupacao(a)}%</dd></div>
        <div><dt className="rotulo" title="Tempo livre dividido pelos atendimentos">Espera média</dt><dd className="tabular-nums">{mediaLivre != null ? duracao(mediaLivre) : '–'}</dd></div>
        <div><dt className="rotulo">Maior espera</dt><dd className="tabular-nums">{a.maiorEsperaSeg ? duracao(a.maiorEsperaSeg) : '–'}</dd></div>
        <div><dt className="rotulo">Outros status</dt><dd className="tabular-nums">{minutos(a.outroMin)}</dd></div>
      </dl>
      <div>
        <h4 className="rotulo mb-2">Pausas de hoje{a.pausasEstouradas > 0 && <span className="ml-1 text-red-700 dark:text-red-300">· {a.pausasEstouradas} estouro(s)</span>}</h4>
        {tipos.length ? (
          <ul className="grid gap-2">
            {tipos.map(([tipo, min]) => {
              const limite = limiteDaPausa(tipo, limites);
              // A barra é o total do dia; o traço é o limite de UMA pausa (várias curtas podem somar mais sem estourar).
              const base = Math.max(min, limite ?? 0) || 1;
              return (
                <li key={tipo}>
                  <div className="flex justify-between gap-2">
                    <span className="font-medium">{tipo}</span>
                    <span className="tabular-nums">
                      <b>{minutos(min)}</b>{limite != null && <span className="text-slate-500 dark:text-slate-400"> no dia · limite {limite} min por pausa</span>}
                    </span>
                  </div>
                  <div className="relative mt-1 h-2 rounded-full bg-slate-200 dark:bg-noite-700">
                    <span className="absolute inset-y-0 left-0 rounded-full bg-[#eda100] transition-[width] duration-500 dark:bg-[#c98500]" style={{ width: `${(min / base) * 100}%` }} />
                    {limite != null && <span className="absolute -inset-y-1 w-0.5 rounded bg-slate-700 dark:bg-slate-200" style={{ left: `calc(${(limite / base) * 100}% - 1px)` }} title={`limite de uma pausa: ${limite} min`} />}
                  </div>
                </li>
              );
            })}
          </ul>
        ) : <p className="text-slate-500 dark:text-slate-400">Nenhuma pausa hoje.</p>}
        <p className="mt-2 text-xs text-slate-500 dark:text-slate-400">O traço marca o limite de uma pausa. O total do dia pode passar dele sem estourar: o estouro conta quando uma pausa sozinha passa do limite.</p>
      </div>
    </div>
  );
}

export function RelatorioPessoal({ lista, limites = {} }: { lista: AtendenteDoDia[] | undefined; limites?: Record<string, number> }) {
  const [visao, setVisao] = useState<'barras' | 'tabela'>('barras');
  const [ordem, setOrdem] = useState<Ordem>('atendimentos');
  const [busca, setBusca] = useState('');
  const [soEstouro, setSoEstouro] = useState(false);
  const [aberto, setAberto] = useState<string | null>(null);
  const [crescer, setCrescer] = useState(false);
  useEffect(() => {
    const t = requestAnimationFrame(() => setCrescer(true)); // as barras crescem ao abrir
    return () => cancelAnimationFrame(t);
  }, []);

  const todos = lista ?? [];
  const equipe = useMemo(() => {
    const soma = (f: (a: AtendenteDoDia) => number) => todos.reduce((t, a) => t + f(a), 0);
    const livre = soma((a) => a.livreMin);
    const atendendo = soma((a) => a.atendimentoMin);
    const tudo = soma(totalMin);
    return {
      atendimentos: soma((a) => a.atendimentos),
      ocupacao: livre + atendendo > 0 ? Math.round((atendendo / (livre + atendendo)) * 100) : 0,
      pausaPct: tudo > 0 ? Math.round((soma((a) => a.pausaMin) / tudo) * 100) : 0,
      pausaMin: soma((a) => a.pausaMin),
      estouros: soma((a) => a.pausasEstouradas),
      comEstouro: todos.filter((a) => a.pausasEstouradas > 0).length,
      escala: Math.max(0, ...todos.map(totalMin)),
      maxAtend: Math.max(0, ...todos.map((a) => a.atendimentos)),
    };
  }, [todos]);
  const lider = useMemo(() => [...todos].sort((a, b) => b.atendimentos - a.atendimentos)[0], [todos]);

  const linhas = useMemo(() => {
    const t = busca.trim().toLowerCase();
    const filtrados = todos.filter((a) => (!soEstouro || a.pausasEstouradas > 0)
      && (!t || (a.nome ?? '').toLowerCase().includes(t) || a.ramal.includes(t)));
    const chave: Record<Ordem, (a: AtendenteDoDia) => number | string> = {
      atendimentos: (a) => -a.atendimentos, ocupacao: (a) => -ocupacao(a), pausa: (a) => -a.pausaMin, nome: (a) => a.nome ?? a.ramal,
    };
    return filtrados.sort((a, b) => {
      const x = chave[ordem](a);
      const y = chave[ordem](b);
      return typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y), 'pt-BR');
    });
  }, [todos, busca, soEstouro, ordem]);
  const corpo = useFlip<HTMLUListElement>(linhas.map((a) => a.ramal));

  const alternar = (ramal: string) => setAberto((r) => (r === ramal ? null : ramal));
  const teclado = (e: KeyboardEvent, ramal: string) => {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); alternar(ramal); }
  };

  return (
    <Cartao
      titulo="Relatório do dia do pessoal"
      extra={(
        <>
          <span className="hidden sm:inline">{todos.length} atendente(s) · só o tempo na URA</span>
          <Segmentado rotulo="Visão do relatório" valor={visao} aoMudar={setVisao}
            opcoes={[{ valor: 'barras', texto: 'Barras' }, { valor: 'tabela', texto: 'Tabela' }]} />
        </>
      )}
    >
      {!todos.length ? <Vazio>Ninguém passou pela URA hoje ainda.</Vazio> : (
        <>
          <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
            <Numero rotulo="Atendimentos" valor={equipe.atendimentos}
              nota={lider?.atendimentos ? `mais: ${lider.nome ?? lider.ramal} (${lider.atendimentos})` : undefined} />
            <Numero rotulo="Ocupação da equipe" valor={`${equipe.ocupacao}%`} nota="do tempo disponível, atendendo" />
            <Numero rotulo="Em pausa" valor={`${equipe.pausaPct}%`} nota={`${minutos(equipe.pausaMin)} somando todos`} />
            <Numero rotulo="Pausas estouradas" valor={equipe.estouros} alerta={equipe.estouros > 0}
              nota={equipe.estouros ? `${equipe.comEstouro} atendente(s)` : 'ninguém passou do limite'} />
          </div>

          {visao === 'tabela' ? <TabelaAtendentes lista={todos} /> : (
            <>
              <div className="mb-3 flex flex-wrap items-center gap-2">
                <label className="relative min-w-48 flex-1">
                  <span className="sr-only">Buscar atendente</span>
                  <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
                  <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar por nome ou ramal"
                    className="w-full rounded-lg border border-slate-300 bg-white py-1.5 pr-3 pl-9 text-sm dark:border-noite-600 dark:bg-noite-900" />
                </label>
                <button type="button" aria-pressed={soEstouro} onClick={() => setSoEstouro((v) => !v)} disabled={!equipe.comEstouro}
                  className={clsx('inline-flex cursor-pointer items-center gap-1.5 rounded-lg border px-3 py-1.5 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    soEstouro ? 'border-red-600 bg-red-600 text-white' : 'border-slate-300 text-slate-600 hover:border-red-400 dark:border-noite-600 dark:text-slate-300')}>
                  <AlertTriangle className="size-3.5" aria-hidden /> Só quem estourou ({equipe.comEstouro})
                </button>
                <Segmentado rotulo="Ordenar por" valor={ordem} aoMudar={setOrdem} opcoes={[
                  { valor: 'atendimentos', texto: 'Atendimentos' }, { valor: 'ocupacao', texto: 'Ocupação' },
                  { valor: 'pausa', texto: 'Pausa' }, { valor: 'nome', texto: 'Nome' },
                ]} />
              </div>

              <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300" aria-label="Legenda">
                {PARTES.map((p) => <li key={p.id} className="inline-flex items-center gap-1.5"><span className={clsx('size-2.5 rounded-sm', p.cor)} aria-hidden />{p.texto}</li>)}
                <li className="text-slate-500 dark:text-slate-400">· o comprimento da barra é o tempo na URA</li>
              </ul>

              {linhas.length ? (
                <ul ref={corpo} className="grid gap-1">
                  {linhas.map((a) => {
                    const expandido = aberto === a.ramal;
                    const lider1 = ordem === 'atendimentos' && a.ramal === lider?.ramal && a.atendimentos > 0;
                    return (
                      <li key={a.ramal} data-flip={a.ramal}
                        className={clsx('rounded-xl border px-3 py-2.5 transition-colors', expandido
                          ? 'border-azul-300 bg-white shadow-sm dark:border-noite-600 dark:bg-noite-900'
                          : 'border-transparent hover:border-slate-200 hover:bg-slate-50/70 dark:hover:border-noite-700 dark:hover:bg-noite-800/40')}>
                        <div role="button" tabIndex={0} aria-expanded={expandido} onClick={() => alternar(a.ramal)} onKeyDown={(e) => teclado(e, a.ramal)}
                          className="grid cursor-pointer grid-cols-[auto_1fr_auto] items-center gap-x-3 gap-y-2 outline-none focus-visible:ring-2 focus-visible:ring-azul-400 sm:grid-cols-[auto_minmax(9rem,14rem)_1fr_auto]">
                          <span className={clsx('relative flex size-9 items-center justify-center rounded-full text-xs font-bold',
                            a.pausasEstouradas ? 'bg-red-100 text-red-800 dark:bg-red-950 dark:text-red-200' : 'bg-azul-50 text-azul-700 dark:bg-noite-700 dark:text-azul-300')}>
                            {iniciais(a.nome, a.ramal)}
                            {lider1 && <Crown className="absolute -top-2 -right-1 size-4 fill-amarelo-400 text-amarelo-500" aria-label="mais atendimentos" />}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate font-medium">{a.nome ?? `Ramal ${a.ramal}`}</span>
                            <span className="block text-xs text-slate-500 tabular-nums dark:text-slate-400">
                              {a.ramal} · {horaCurta(a.primeiroEm)}–{horaCurta(a.ultimoEm)}
                            </span>
                          </span>
                          <span className="col-span-3 sm:col-span-1 sm:row-start-1 sm:col-start-3">
                            <BarraDoDia a={a} escala={equipe.escala} crescer={crescer} />
                            <span className="mt-1 flex gap-3 text-xs text-slate-500 tabular-nums dark:text-slate-400">
                              <span>ocupação {ocupacao(a)}%</span>
                              <span>pausa {minutos(a.pausaMin)}</span>
                              <span className="hidden sm:inline">na URA {minutos(totalMin(a))}</span>
                            </span>
                          </span>
                          <span className="col-start-3 row-start-1 flex items-center gap-2 sm:col-start-4">
                            {a.pausasEstouradas > 0 && (
                              <span title={`${a.pausasEstouradas} pausa(s) passaram do limite`}
                                className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-xs font-bold text-red-700 dark:bg-red-950 dark:text-red-300">
                                <AlertTriangle className="size-3" aria-hidden />{a.pausasEstouradas}
                              </span>
                            )}
                            <span className="w-14 text-right">
                              <b className="block text-lg leading-tight tabular-nums">{a.atendimentos}</b>
                              <span className="block h-1 overflow-hidden rounded-full bg-slate-100 dark:bg-noite-800" aria-hidden>
                                <span className="block h-full rounded-full bg-[#2f63d6] transition-[width] duration-700 dark:bg-[#4f86f0]"
                                  style={{ width: crescer && equipe.maxAtend ? `${(a.atendimentos / equipe.maxAtend) * 100}%` : '0%' }} />
                              </span>
                              <span className="text-[10px] text-slate-500 uppercase dark:text-slate-400">atend.</span>
                            </span>
                            <ChevronDown className={clsx('size-4 text-slate-400 transition-transform', expandido && 'rotate-180')} aria-hidden />
                          </span>
                        </div>
                        {expandido && <Detalhe a={a} limites={limites} />}
                      </li>
                    );
                  })}
                </ul>
              ) : <Vazio>Ninguém com esse filtro.</Vazio>}
            </>
          )}
          <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            {visao === 'barras' ? <BarChart3 className="size-3.5" aria-hidden /> : <Table2 className="size-3.5" aria-hidden />}
            Clique num atendente para ver as pausas por tipo e o detalhe. Conta só o tempo no grupo da URA, de hoje.
          </p>
        </>
      )}
    </Cartao>
  );
}
