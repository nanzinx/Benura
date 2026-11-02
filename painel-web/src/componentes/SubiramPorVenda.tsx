/**
 * [NOVO] "Subiram por venda hoje": quem saiu do Ativo para a URA porque vendeu. Cada um vira um
 * cartãozinho com as iniciais, a equipe, a venda e a hora. Quem chega com a tela aberta entra
 * deslizando, com um brilho e um confete rápido; quem subiu nos últimos 15 min leva o selo "novo".
 * A maior venda do dia ganha o troféu. "Meta batida ontem" usa o mesmo cartão (MetaBatidaOntem).
 * "Reduzir movimento" do sistema: sem animação.
 */

import { clsx } from 'clsx';
import { ChevronDown, Sparkles, Target, Trophy } from 'lucide-react';
import { useEffect, useRef, useState, type ComponentType, type CSSProperties, type ReactNode } from 'react';
import { horaCurta } from '../formatos';
import type { StatusRoteador, Vendedor } from '../tipos';
import { Segmentado, Vazio } from '../ui/base';
import { useFlip } from '../ui/flip';
import { acimaDaMeta, chegaram, diaCurto, haQuanto, iniciais, metaBatidaOntem, recente, somaDasVendas, subiramHoje, tomDoAvatar } from '../vendas';

/** Fechado, mostra estes; o resto atrás do "ver todos". */
const VISIVEIS = 6;
/** Quanto tempo quem acabou de chegar fica destacado. */
const DESTAQUE_MS = 6000;

const TONS = [
  'bg-azul-100 text-azul-700 dark:bg-azul-700/40 dark:text-azul-100',
  'bg-amarelo-100 text-amber-800 dark:bg-amber-500/25 dark:text-amber-200',
  'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-200',
  'bg-violet-100 text-violet-800 dark:bg-violet-500/25 dark:text-violet-200',
  'bg-rose-100 text-rose-800 dark:bg-rose-500/20 dark:text-rose-200',
  'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-200',
];

/** R$ 25.000 (sem ",00"; com centavos, mostra os centavos). */
const valor = (v: number | null | undefined) => Number(v ?? 0).toLocaleString('pt-BR', {
  style: 'currency', currency: 'BRL', minimumFractionDigits: Number.isInteger(v ?? 0) ? 0 : 2, maximumFractionDigits: 2,
});

/** Os pedacinhos do confete: para onde cada um voa (px) e a cor. */
const CONFETE = [
  [-34, -26, 'bg-amarelo-500'], [30, -30, 'bg-azul-500'], [-40, 6, 'bg-emerald-500'], [38, 4, 'bg-amarelo-400'],
  [-18, -40, 'bg-rose-400'], [16, -42, 'bg-emerald-400'], [-28, 26, 'bg-azul-400'], [26, 26, 'bg-violet-400'],
] as const;

function useAgora(intervaloMs = 30_000) {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs]);
  return agora;
}

/** Quem apareceu desde a leitura anterior (não conta a primeira: abrir a página não anima ninguém). */
function useChegadas(lista: Vendedor[], carregado: boolean) {
  const vistos = useRef<Set<string> | null>(null);
  const [chegados, setChegados] = useState<Set<string>>(() => new Set());
  const chave = lista.map((v) => v.ramal).sort().join('|');
  useEffect(() => {
    if (!carregado) return undefined;
    const novos = chegaram(vistos.current, lista);
    vistos.current = new Set(lista.map((v) => v.ramal));
    if (!novos.length) return undefined;
    setChegados((c) => new Set([...c, ...novos]));
    const t = setTimeout(() => setChegados((c) => new Set([...c].filter((r) => !novos.includes(r)))), DESTAQUE_MS);
    return () => clearTimeout(t);
    // a lista muda de objeto a cada leitura: o que conta é quem está nela (chave)
  }, [chave, carregado]);
  return chegados;
}

/** O cartãozinho de um vendedor (as duas listas): iniciais, nome, equipe e ramal, o valor e o detalhe. */
function CartaoVendedor({ v, valorEmReais, detalhe, tituloDetalhe, novo = false, chegou = false, campeao, barra }: {
  v: Vendedor; valorEmReais: number | null | undefined; detalhe: ReactNode; tituloDetalhe?: string;
  novo?: boolean; chegou?: boolean; campeao?: string | null; barra?: number;
}) {
  return (
    <li data-flip={v.ramal}
      className={clsx('venda-item group relative flex min-w-0 items-center gap-3 overflow-hidden rounded-xl border px-3 py-2.5 transition-[box-shadow,transform,border-color] duration-200 hover:-translate-y-0.5 hover:shadow-md',
        chegou ? 'venda-chegou border-amarelo-400 bg-amarelo-100/60 dark:border-amarelo-500/70 dark:bg-amber-500/10'
          : novo ? 'border-azul-100 bg-azul-50/70 dark:border-noite-600 dark:bg-noite-800/70'
            : 'border-slate-200 bg-white dark:border-noite-700 dark:bg-noite-900')}>
      <span className="relative shrink-0">
        <span className={clsx('grid size-10 place-items-center rounded-full text-sm font-bold ring-2', TONS[tomDoAvatar(v.ramal)],
          // no celular, o "novo" é o anel amarelo (o selo tiraria o espaço do nome)
          novo || chegou ? 'ring-amarelo-400 sm:ring-white sm:dark:ring-noite-900' : 'ring-white dark:ring-noite-900')} aria-hidden>
          {iniciais(v.nome, v.ramal)}
        </span>
        {campeao && (
          <span className="absolute -top-1.5 -right-1.5 grid size-5 place-items-center rounded-full bg-amarelo-500 text-marinho-950 shadow ring-2 ring-white dark:ring-noite-900" title={campeao}>
            <Trophy className="size-3" aria-hidden />
          </span>
        )}
        {chegou && CONFETE.map(([x, y, cor], i) => (
          <span key={i} className={clsx('venda-confete absolute top-1/2 left-1/2 size-1.5 rounded-[2px]', cor)}
            style={{ '--x': `${x}px`, '--y': `${y}px`, animationDelay: `${i * 25}ms` } as CSSProperties} aria-hidden />
        ))}
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <b className="min-w-0 truncate">{v.nome ?? `Ramal ${v.ramal}`}</b>
          {v.fixo && <span className="rounded-md bg-amarelo-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200">fixo</span>}
          {(novo || chegou) && (
            <span className="hidden shrink-0 items-center gap-1 rounded-full bg-amarelo-500 sm:inline-flex px-1.5 py-0.5 text-[10px] font-bold tracking-wide text-marinho-950 uppercase">
              <span className="relative flex size-1.5"><span className="venda-ping absolute inline-flex size-full rounded-full bg-marinho-950/60" /><span className="relative inline-flex size-1.5 rounded-full bg-marinho-950" /></span>
              novo
            </span>
          )}
        </span>
        <span className="block truncate text-xs text-slate-500 dark:text-slate-400">
          {[v.equipe, `ramal ${v.ramal}`].filter(Boolean).join(' · ')}
        </span>
      </span>
      <span className="shrink-0 text-right">
        <b className="block text-[15px] text-emerald-700 tabular-nums dark:text-emerald-300">{valor(valorEmReais)}</b>
        <span className="block text-xs whitespace-nowrap text-slate-500 dark:text-slate-400" title={tituloDetalhe}>{detalhe}</span>
      </span>
      {barra != null && (
        <span className="absolute inset-x-0 bottom-0 h-[3px] bg-slate-100 dark:bg-noite-800" aria-hidden>
          <span className="venda-barra block h-full rounded-r-full bg-gradient-to-r from-emerald-400 to-amarelo-400" style={{ width: `${barra}%` }} />
        </span>
      )}
    </li>
  );
}

/** O topo das duas listas: ícone, título, o número e (opcional) o controle de ordem. */
function TopoDaLista({ Icone, titulo, total, children }: { Icone: ComponentType<{ className?: string }>; titulo: ReactNode; total: number; children?: ReactNode }) {
  return (
    <div className="mb-3 flex min-h-8 flex-wrap items-center justify-between gap-2">
      <h3 className="flex items-center gap-2 text-sm font-semibold">
        <Icone className="size-4 text-amarelo-500" aria-hidden />
        {titulo}
        <span key={total} className="venda-pulo rounded-full bg-azul-600 px-2 py-0.5 text-xs font-bold text-white tabular-nums dark:bg-azul-500">{total}</span>
      </h3>
      {children}
    </div>
  );
}

function VerTodos({ total, todos, alternar }: { total: number; todos: boolean; alternar: () => void }) {
  if (total <= VISIVEIS) return null;
  return (
    <button type="button" onClick={alternar} aria-expanded={todos}
      className="mt-2 inline-flex cursor-pointer items-center gap-1 text-sm font-semibold text-azul-600 hover:underline dark:text-azul-300">
      {todos ? 'Mostrar menos' : `Ver todos (${total})`}
      <ChevronDown className={clsx('size-4 transition-transform', todos && 'rotate-180')} aria-hidden />
    </button>
  );
}

export function SubiramPorVenda({ s }: { s: StatusRoteador | undefined }) {
  const [ordem, setOrdem] = useState<'recentes' | 'valor'>('recentes');
  const [todos, setTodos] = useState(false);
  const agora = useAgora();
  const lista = subiramHoje(s, ordem);
  const chegados = useChegadas(lista, Boolean(s));
  const maior = Math.max(0, ...lista.map((v) => v.vendaQueDisparou ?? 0));
  const ultimo = subiramHoje(s, 'recentes')[0];
  const visiveis = todos ? lista : lista.slice(0, VISIVEIS);
  const corpo = useFlip<HTMLUListElement>(visiveis.map((v) => v.ramal));
  const anuncio = [...chegados].map((r) => lista.find((v) => v.ramal === r)).filter(Boolean)
    .map((v) => `${v!.nome ?? `Ramal ${v!.ramal}`} subiu para a URA com ${valor(v!.vendaQueDisparou)}`).join('. ');

  return (
    <div className="min-w-0">
      <TopoDaLista Icone={Sparkles} titulo="Subiram por venda hoje" total={lista.length}>
        {lista.length > 1 && (
          <Segmentado rotulo="Ordem de quem subiu" valor={ordem} aoMudar={setOrdem}
            opcoes={[{ valor: 'recentes', texto: 'Mais recentes' }, { valor: 'valor', texto: 'Maior venda' }]} />
        )}
      </TopoDaLista>
      {lista.length ? (
        <>
          <p className="mb-2.5 text-xs text-slate-500 dark:text-slate-400">
            <b className="font-semibold text-slate-700 dark:text-slate-200">{valor(somaDasVendas(lista))}</b> nas vendas que fizeram subir
            {ultimo?.promovidoEm && <> · o último às {horaCurta(ultimo.promovidoEm)}</>}
          </p>
          <ul ref={corpo} className="grid grid-cols-1 gap-2">
            {visiveis.map((v) => (
              <CartaoVendedor key={v.ramal} v={v} valorEmReais={v.vendaQueDisparou} novo={recente(v, agora)} chegou={chegados.has(v.ramal)}
                campeao={lista.length > 1 && (v.vendaQueDisparou ?? 0) === maior && maior > 0 ? 'Maior venda que fez subir hoje' : null}
                tituloDetalhe={v.promovidoEm ? new Date(v.promovidoEm).toLocaleString('pt-BR') : undefined}
                detalhe={v.promovidoEm ? <>subiu às {horaCurta(v.promovidoEm)}<span className="hidden sm:inline"> · {haQuanto(v.promovidoEm, agora)}</span></> : 'subiu hoje'} />
            ))}
          </ul>
          <VerTodos total={lista.length} todos={todos} alternar={() => setTodos((t) => !t)} />
        </>
      ) : <Vazio>Ninguém subiu por venda hoje ainda.</Vazio>}
      <p className="sr-only" aria-live="polite">{anuncio}</p>
    </div>
  );
}

/**
 * [NOVO] "Meta batida ontem", no mesmo visual: quem passou da meta no dia anterior (começou o dia
 * na URA), do maior para o menor, com quanto passou da meta e a barra em relação ao primeiro.
 */
export function MetaBatidaOntem({ s }: { s: StatusRoteador | undefined }) {
  const [todos, setTodos] = useState(false);
  const lista = metaBatidaOntem(s);
  const dia = diaCurto(s?.carga?.diaAnterior);
  const maior = lista[0]?.vendaOntem ?? 0;
  const visiveis = todos ? lista : lista.slice(0, VISIVEIS);
  const soma = lista.reduce((t, v) => t + (v.vendaOntem ?? 0), 0);

  return (
    <div className="min-w-0">
      <TopoDaLista Icone={Target} titulo={`Meta batida ontem${dia ? ` (${dia})` : ''}`} total={lista.length} />
      {lista.length ? (
        <>
          <p className="mb-2.5 text-xs text-slate-500 dark:text-slate-400">
            <b className="font-semibold text-slate-700 dark:text-slate-200">{valor(soma)}</b> somados
            {s?.meta ? <> · meta de {valor(s.meta)} por dia</> : null}
          </p>
          <ul className="grid grid-cols-1 gap-2">
            {visiveis.map((v, i) => {
              const m = acimaDaMeta(v.vendaOntem, s?.meta, maior);
              return (
                <CartaoVendedor key={v.ramal} v={v} valorEmReais={v.vendaOntem} barra={m.barra}
                  campeao={i === 0 && lista.length > 1 ? 'Maior venda de ontem' : null}
                  tituloDetalhe={m.sobra != null ? `${valor(m.sobra)} acima da meta` : undefined}
                  detalhe={m.porcento != null ? <>{m.porcento}% da meta<span className="hidden sm:inline"> · +{valor(m.sobra)}</span></> : 'vendeu ontem'} />
              );
            })}
          </ul>
          <VerTodos total={lista.length} todos={todos} alternar={() => setTodos((t) => !t)} />
        </>
      ) : <Vazio>{s?.cargaInicialFeita === false ? 'A carga do dia ainda não saiu.' : 'Ninguém passou da meta ontem.'}</Vazio>}
    </div>
  );
}
