import { clsx } from 'clsx';
import { ArrowDownUp, Bot, PhoneMissed, Search, ShieldCheck, Users, UserCheck } from 'lucide-react';
import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { GraficoDegraus } from '../componentes/GraficoDegraus';
import { Relatorio } from '../componentes/Relatorio';
import { ESTADOS_TERMOMETRO } from '../componentes/Termometro';
import { useDia, useRoteador, useVisao } from '../dados';
import { agoraEmSegundos, degraus, duracao, horaCurta, reais, segundosDoDia } from '../formatos';
import type { Callback, Classe, OperadorNaUra, SaudeRodizio } from '../tipos';
import { Cartao, Esqueleto, Segmentado, Selo, Vazio, type Tom } from '../ui/base';

const CLASSES: Record<Classe, { texto: string; tom: Tom; ordem: number }> = {
  livre: { texto: 'Livre', tom: 'ok', ordem: 0 },
  atendimento: { texto: 'Em atendimento', tom: 'info', ordem: 1 },
  outro: { texto: 'Pausa / outro', tom: 'alerta', ordem: 2 },
  erro: { texto: 'Sem resposta', tom: 'neutro', ordem: 3 },
  offline: { texto: 'Offline', tom: 'neutro', ordem: 4 },
};

function Kpi({ rotulo, valor, nota, Icone, tom, destaque }: { rotulo: string; valor: ReactNode; nota?: ReactNode; Icone: ComponentType<{ className?: string }>; tom?: 'perigo' | 'ok'; destaque?: boolean }) {
  return (
    <div className={clsx('cartao relative overflow-hidden p-4', destaque && 'before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-amarelo-500')}>
      <div className="flex items-center justify-between">
        <span className="rotulo">{rotulo}</span>
        <Icone className="size-4 text-slate-400 dark:text-slate-500" aria-hidden />
      </div>
      <div className={clsx('mt-1 text-3xl font-bold tabular-nums', tom === 'perigo' && 'text-red-700 dark:text-red-400', tom === 'ok' && 'text-emerald-700 dark:text-emerald-400')}>{valor}</div>
      <div className="min-h-5 text-sm text-slate-500 dark:text-slate-400">{nota}</div>
    </div>
  );
}

function Kpis({ r, callbacks }: { r: SaudeRodizio | null | undefined; callbacks: Callback[] | undefined }) {
  // undefined = carregando; null = rodízio sem resposta (ou automação desligada): mostra traços.
  if (r === undefined) {
    return <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-5">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="cartao h-28 p-4"><Esqueleto className="h-4 w-24" /><Esqueleto className="mt-3 h-8 w-12" /></div>)}</div>;
  }
  if (r === null) {
    return (
      <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
        <Kpi destaque rotulo="Livres na URA" valor="–" Icone={UserCheck} nota="rodízio parado" />
        <Kpi rotulo="Humanos na URA" valor="–" Icone={Users} />
        <Kpi rotulo="Robôs ligados" valor="–" Icone={Bot} />
        <Kpi rotulo="Callbacks hoje" valor={callbacks?.length ?? '–'} Icone={PhoneMissed} />
        <div className="col-span-2 lg:col-span-1"><Kpi rotulo="Pânico" valor={<span className="text-2xl">–</span>} Icone={ShieldCheck} /></div>
      </div>
    );
  }
  const ura = r.uraAgora ?? [];
  const livres = ura.filter((u) => u.classe === 'livre' && !u.emCarencia).length;
  const humanos = ura.filter((u) => u.classe && u.classe !== 'offline').length;
  const p = r.panico;
  const panico = !p?.modo ? 'automático' : p.ativoAgora ? (p.tipo === 'fixo' ? 'reduzindo' : 'desligando') : p.ligado ? 'ligado' : 'desligado';
  const t = r.termometro;
  const notaPanico = p?.uraPassiva?.ligado ? 'URA passiva hoje'
    : p?.passivaAgora ? 'URA calma (passiva automática)'
      : t && t.estado !== 'medindo' ? `URA ${ESTADOS_TERMOMETRO[t.estado].texto}` : r.uraCheia?.ligada ? 'URA cheia ligada' : undefined;
  return (
    <div className="mb-5 grid grid-cols-2 gap-4 lg:grid-cols-5">
      <Kpi destaque rotulo="Livres na URA" valor={livres} Icone={UserCheck} tom={livres <= 1 ? 'perigo' : undefined} nota={livres <= 1 ? 'atenção: poucos livres' : 'prontos para receber'} />
      <Kpi rotulo="Humanos na URA" valor={humanos} Icone={Users} nota={`${ura.filter((u) => u.classe === 'atendimento').length} em atendimento`} />
      <Kpi rotulo="Robôs ligados" valor={r.robos?.ligados ?? '?'} Icone={Bot} nota={`de ${r.robos?.total ?? '?'} robôs`} />
      <Kpi rotulo="Callbacks hoje" valor={callbacks?.length ?? '–'} Icone={PhoneMissed} nota={callbacks?.length ? `último às ${callbacks[callbacks.length - 1]!.hora.slice(0, 5)}` : 'nenhum até agora'} />
      <div className="col-span-2 lg:col-span-1">
        <Kpi rotulo="Pânico" valor={<span className="text-2xl">{panico}</span>} Icone={ShieldCheck} tom={p?.ativoAgora ? 'perigo' : p?.ligado ? 'ok' : undefined}
          nota={notaPanico} />
      </div>
    </div>
  );
}

type FiltroUra = 'todos' | 'livre' | 'atendimento' | 'outros';

function TabelaUra({ ura }: { ura: OperadorNaUra[] }) {
  const [filtro, setFiltro] = useState<FiltroUra>('todos');
  const [busca, setBusca] = useState('');
  const [porNome, setPorNome] = useState(false);
  const agora = Date.now();
  const lista = useMemo(() => ura
    .filter((u) => filtro === 'todos' || (filtro === 'outros' ? !['livre', 'atendimento'].includes(u.classe ?? '') : u.classe === filtro))
    .filter((u) => !busca || `${u.ramal} ${u.nome ?? ''}`.toLowerCase().includes(busca.toLowerCase()))
    .sort((a, b) => (porNome ? 0 : (CLASSES[a.classe ?? 'erro'].ordem - CLASSES[b.classe ?? 'erro'].ordem)) || String(a.nome).localeCompare(String(b.nome))), [ura, filtro, busca, porNome]);

  return (
    <Cartao titulo="Quem está na URA" extra={<span>{ura.length} na lista</span>}>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Segmentado rotulo="Filtrar por status" valor={filtro} aoMudar={setFiltro}
          opcoes={[{ valor: 'todos', texto: 'Todos' }, { valor: 'livre', texto: 'Livres' }, { valor: 'atendimento', texto: 'Atendendo' }, { valor: 'outros', texto: 'Outros' }]} />
        <label className="relative ml-auto">
          <span className="sr-only">Buscar operador</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Ramal ou nome"
            className="w-40 rounded-lg border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-sm dark:border-noite-600 dark:bg-noite-950" />
        </label>
      </div>
      {lista.length ? (
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead><tr>
              <th>Ramal</th>
              <th><button type="button" className="inline-flex cursor-pointer items-center gap-1 uppercase" onClick={() => setPorNome((v) => !v)} title="Ordenar por nome ou por status">Operador<ArrowDownUp className="size-3" aria-hidden /></button></th>
              <th>Status</th><th className="text-right">Livre há</th>
            </tr></thead>
            <tbody>
              {lista.map((u) => {
                const c = CLASSES[u.classe ?? 'erro'];
                return (
                  <tr key={u.ramal} className="hover:bg-slate-50 dark:hover:bg-noite-800/50">
                    <td className="numero">{u.ramal}</td>
                    <td>{u.nome ?? '—'}{u.fixo && <span className="ml-2 rounded-md bg-amarelo-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200">fixo</span>}</td>
                    <td><Selo tom={c.tom}>{c.texto}{u.emCarencia ? ' · carência' : ''}</Selo></td>
                    <td className="numero text-right">{u.livreDesde ? duracao((agora - new Date(u.livreDesde).getTime()) / 1000) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <Vazio>{ura.length ? 'Ninguém com esse filtro.' : 'Ninguém na URA agora.'}</Vazio>}
    </Cartao>
  );
}

function ListaCallbacks({ callbacks }: { callbacks: Callback[] }) {
  const [tipo, setTipo] = useState('todos');
  const tipos = useMemo(() => [...new Set(callbacks.map((c) => c.conclusao ?? 'callback'))], [callbacks]);
  const lista = [...callbacks].reverse().filter((c) => tipo === 'todos' || (c.conclusao ?? 'callback') === tipo);
  return (
    <Cartao titulo="Callbacks de hoje" extra={tipos.length > 1 && (
      <select value={tipo} onChange={(e) => setTipo(e.target.value)} aria-label="Filtrar por conclusão"
        className="max-w-56 rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-noite-600 dark:bg-noite-950">
        <option value="todos">Todas as conclusões</option>
        {tipos.map((t) => <option key={t} value={t}>{t}</option>)}
      </select>
    )}>
      {lista.length ? (
        <ol className="max-h-[430px] divide-y divide-slate-100 overflow-y-auto pr-1 dark:divide-noite-800">
          {lista.slice(0, 80).map((c, i) => (
            <li key={`${c.hora}-${i}`} className="grid gap-0.5 py-2.5">
              <div className="flex flex-wrap items-baseline gap-x-3">
                <span className="font-bold tabular-nums">{c.hora}</span>
                <span className={clsx('font-semibold', /INVIS/i.test(c.conclusao ?? '') && 'text-red-700 dark:text-red-400')}>{c.conclusao ?? 'callback'}</span>
                <span className="text-sm text-slate-500 dark:text-slate-400">{[c.robo, `${c.duracaoSeg} s`].filter(Boolean).join(' · ')}</span>
              </div>
              {c.detalhes.length > 0 && <p className="text-sm text-slate-600 dark:text-slate-300">{c.detalhes.join(' · ')}</p>}
            </li>
          ))}
        </ol>
      ) : <Vazio>Nenhum callback {tipo === 'todos' ? 'hoje' : 'com essa conclusão'}.</Vazio>}
    </Cartao>
  );
}

type Periodo = 'dia' | '3h' | '1h';
const JANELAS: Record<Periodo, number | null> = { dia: null, '3h': 3 * 3600, '1h': 3600 };

function Graficos({ escuro }: { escuro: boolean }) {
  const { data: dia } = useDia();
  const [periodo, setPeriodo] = useState<Periodo>('dia');
  const [mostrarCallbacks, setMostrarCallbacks] = useState(true);
  if (!dia) return <Cartao titulo="O dia da URA"><Esqueleto className="h-60 w-full" /></Cartao>;
  const agora = agoraEmSegundos();
  const janela = { agora, janelaSeg: JANELAS[periodo] };
  const marcas = mostrarCallbacks ? dia.callbacks.map((c) => ({ t: segundosDoDia(c.hora), texto: `${c.hora.slice(0, 5)} · ${c.conclusao ?? 'callback'}` })) : [];
  const controles = (
    <>
      <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
        <input type="checkbox" checked={mostrarCallbacks} onChange={(e) => setMostrarCallbacks(e.target.checked)} className="size-4 accent-red-700" />
        <span className="inline-block h-3 w-0.5 rounded bg-red-700 dark:bg-red-400" aria-hidden />Callbacks
      </label>
      <Segmentado rotulo="Período" valor={periodo} aoMudar={setPeriodo} opcoes={[{ valor: 'dia', texto: 'Dia todo' }, { valor: '3h', texto: '3 h' }, { valor: '1h', texto: '1 h' }]} />
    </>
  );
  return (
    <>
      <Cartao titulo="Livres na URA ao longo do dia" extra={controles} className="mb-5">
        <GraficoDegraus escuro={escuro} rotulo="livre(s)" marcas={marcas} serie={degraus(dia.linhaDoTempo, (p) => p.livres, janela)} />
      </Cartao>
      <Cartao titulo="Robôs ligados ao longo do dia" className="mb-5">
        <GraficoDegraus escuro={escuro} altura={190} rotulo="robô(s) ligado(s)" serie={degraus(dia.linhaDoTempo, (p) => p.robos, janela)} />
      </Cartao>
    </>
  );
}

function Roteador() {
  const { data: s, isError } = useRoteador();
  const subiram = (s?.ura ?? []).filter((v) => v.promovidoNoDia);
  const resumo = isError ? 'roteador sem resposta' : !s ? '' : s.cargaInicialFeita ? `carga do dia feita${s.ultimoMonitoramento ? ` · vendas lidas às ${horaCurta(s.ultimoMonitoramento)}` : ''}` : 'carga do dia pendente';
  const mini = (rotulo: string, valor: ReactNode) => (
    <div className="grid rounded-lg bg-azul-50 px-3 py-2.5 dark:bg-noite-800"><span className="rotulo">{rotulo}</span><b className="text-xl tabular-nums">{valor}</b></div>
  );
  return (
    <Cartao titulo="Vendas e filas (roteador)" extra={<span>{resumo}</span>}>
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        {mini('Na URA pelo roteador', s?.ura?.length ?? '–')}
        {mini('No Ativo', s?.ativo?.length ?? '–')}
        {mini('Subiram por venda hoje', s ? subiram.length : '–')}
        {mini('Meta diária', s ? reais(s.meta) : '–')}
      </div>
      {subiram.length ? (
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead><tr><th>Ramal</th><th>Vendedor</th><th>Equipe</th><th className="text-right">Venda que fez subir</th></tr></thead>
            <tbody>{subiram.map((v) => (
              <tr key={v.ramal}><td className="numero">{v.ramal}</td><td>{v.nome}</td><td>{v.equipe ?? ''}</td><td className="numero text-right">{reais(v.vendaQueDisparou)}</td></tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Vazio>Ninguém subiu por venda hoje ainda.</Vazio>}
    </Cartao>
  );
}

export function Visao({ escuro }: { escuro: boolean }) {
  const { data: v, dataUpdatedAt } = useVisao();
  const { data: dia } = useDia();
  const r = v ? v.servicos.rodizio.dados : undefined;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Visão geral</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">{dataUpdatedAt ? `Atualizado às ${new Date(dataUpdatedAt).toLocaleTimeString('pt-BR')}` : 'Carregando…'}</p>
      </div>
      <Kpis r={r} callbacks={dia?.callbacks} />
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <TabelaUra ura={r?.uraAgora ?? []} />
        <ListaCallbacks callbacks={dia?.callbacks ?? []} />
      </div>
      <Relatorio r={r?.relatorio} callbacks={dia?.callbacks} />
      <Graficos escuro={escuro} />
      <Roteador />
    </>
  );
}
