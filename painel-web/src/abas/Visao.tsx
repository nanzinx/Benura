import { clsx } from 'clsx';
import { Bot, Info, PhoneForwarded, PhoneOff, Search, ShieldCheck, Users, UserCheck } from 'lucide-react';
import { useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { GraficoDegraus } from '../componentes/GraficoDegraus';
import { Relatorio } from '../componentes/Relatorio';
import { useDia, useMetricasHoje, useRoteador, useVisao } from '../dados';
import { StatusUra } from '../componentes/StatusUra';
import { useFlip } from '../ui/flip';
import { agoraEmSegundos, degraus, duracao, horaCurta, ordenarOperadores, reais, segundosDoDia } from '../formatos';
import type { Callback, Classe, MetricasHoje, OperadorNaUra, SaudeRodizio, Vendedor } from '../tipos';
import { diaCurto, metaBatidaOntem, subiramHoje } from '../vendas';
import { Cartao, Esqueleto, Segmentado, Selo, Vazio, type Tom } from '../ui/base';

export const CLASSES: Record<Classe, { texto: string; tom: Tom }> = {
  livre: { texto: 'Livre', tom: 'ok' },
  atendimento: { texto: 'Em atendimento', tom: 'info' },
  outro: { texto: 'Pausa / outro', tom: 'alerta' },
  erro: { texto: 'Sem resposta', tom: 'neutro' },
  offline: { texto: 'Offline', tom: 'neutro' },
};

/** Definições da Regra Global 4 (tooltip dos cards [NOVO]). */
export const DEFINICOES = {
  leads: 'Leads Derivados: ligações da URA encaminhadas a um operador humano, de 00:00 até agora. Cada ligação conta em uma só métrica (lead ou transbordo).',
  transbordos: 'Transbordos: ligações da URA que NÃO foram encaminhadas a operador (abandono, sem operador disponível ou time-out na fila), de 00:00 até agora. Cada ligação conta em uma só métrica.',
};

function Kpi({ rotulo, valor, nota, Icone, tom, destaque, dica }: { rotulo: string; valor: ReactNode; nota?: ReactNode; Icone: ComponentType<{ className?: string }>; tom?: 'perigo' | 'ok'; destaque?: boolean; dica?: string }) {
  return (
    <div title={dica} className={clsx('cartao relative overflow-hidden p-4', destaque && 'before:absolute before:inset-y-0 before:left-0 before:w-1 before:bg-amarelo-500', dica && 'cursor-help')}>
      <div className="flex items-center justify-between">
        <span className="rotulo inline-flex items-center gap-1">{rotulo}{dica && <><Info className="size-3.5" aria-hidden /><span className="sr-only">. {dica}</span></>}</span>
        <Icone className="size-4 text-slate-400 dark:text-slate-500" aria-hidden />
      </div>
      <div className={clsx('mt-1 text-3xl font-bold tabular-nums', tom === 'perigo' && 'text-red-700 dark:text-red-400', tom === 'ok' && 'text-emerald-700 dark:text-emerald-400')}>{valor}</div>
      <div className="min-h-5 text-sm text-slate-500 dark:text-slate-400">{nota}</div>
    </div>
  );
}

/** [NOVO] Leads derivados (destaque positivo) e transbordos (sempre em vermelho), de GET /api/metricas/hoje. */
function KpisDoDia({ m }: { m: MetricasHoje | undefined }) {
  const valor = (n: number | null | undefined) => (n == null ? '–' : n);
  const motivos = Object.entries(m?.transbordosPorMotivo ?? {}).map(([k, n]) => `${n} ${k}`).join(' · ');
  return (
    <>
      <Kpi rotulo="Leads Derivados Hoje" valor={valor(m?.leadsDerivadosHoje)} Icone={PhoneForwarded} tom="ok" dica={DEFINICOES.leads}
        nota={m?.ultimoWebhookEncerramento ? `último às ${horaCurta(m.ultimoWebhookEncerramento)}` : 'sem webhook da Argus hoje'} />
      <Kpi rotulo="Transbordos Hoje" valor={valor(m?.transbordosHoje)} Icone={PhoneOff} tom="perigo" dica={DEFINICOES.transbordos} nota={motivos || 'nenhum até agora'} />
    </>
  );
}

function Kpis({ r, metricas }: { r: SaudeRodizio | null | undefined; metricas: MetricasHoje | undefined }) {
  const grade = 'mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6';
  // undefined = carregando; null = rodízio sem resposta (ou automação desligada): mostra traços.
  if (r === undefined) {
    return <div className={grade}>{[1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="cartao h-28 p-4"><Esqueleto className="h-4 w-24" /><Esqueleto className="mt-3 h-8 w-12" /></div>)}</div>;
  }
  if (r === null) {
    return (
      <div className={grade}>
        <Kpi destaque rotulo="Humanos na URA" valor="–" Icone={Users} nota="rodízio parado" />
        <Kpi rotulo="Livres na URA" valor="–" Icone={UserCheck} />
        <Kpi rotulo="Robôs ligados" valor="–" Icone={Bot} />
        <KpisDoDia m={metricas} />
        <Kpi rotulo="Pânico" valor={<span className="text-2xl">–</span>} Icone={ShieldCheck} />
      </div>
    );
  }
  const ura = (r.uraAgora ?? []).filter((u) => !u.virtual);
  const livres = ura.filter((u) => u.classe === 'livre' && !u.emCarencia).length;
  const humanos = ura.filter((u) => u.classe && u.classe !== 'offline').length;
  const p = r.panico;
  const panico = !p?.modo ? 'automático' : p.ativoAgora ? (p.tipo === 'fixo' ? 'reduzindo' : 'desligando') : p.ligado ? 'ligado' : 'desligado';
  const notaPanico = r.statusUra?.status === 'calma' ? `URA calma${r.statusUra.modo === 'manual' ? ' (manual)' : ''}` : r.uraCheia?.ligada ? 'URA cheia ligada' : undefined;
  return (
    <div className={grade}>
      <Kpi destaque rotulo="Humanos na URA" valor={humanos} Icone={Users} nota={`${ura.filter((u) => u.classe === 'atendimento').length} em atendimento`} />
      <Kpi rotulo="Livres na URA" valor={livres} Icone={UserCheck} tom={livres <= 1 ? 'perigo' : undefined} nota={livres <= 1 ? 'atenção: poucos livres' : 'prontos para receber'} />
      <Kpi rotulo="Robôs ligados" valor={r.robos?.ligados ?? '?'} Icone={Bot} nota={`de ${r.robos?.total ?? '?'} robôs`} />
      <KpisDoDia m={metricas} />
      <Kpi rotulo="Pânico" valor={<span className="text-2xl">{panico}</span>} Icone={ShieldCheck} tom={p?.ativoAgora ? 'perigo' : p?.ligado ? 'ok' : undefined} nota={notaPanico} />
    </div>
  );
}

type FiltroUra = 'todos' | 'livre' | 'atendimento' | 'outros';

/**
 * Quem está na URA (só humanos), na ordem: em atendimento → livres → pausa → sem resposta → offline;
 * dentro do grupo, há mais tempo no status primeiro, depois o nome. A troca de posição é animada (FLIP).
 */
function TabelaUra({ ura }: { ura: OperadorNaUra[] }) {
  const [filtro, setFiltro] = useState<FiltroUra>('todos');
  const [busca, setBusca] = useState('');
  const agora = Date.now();
  const humanos = useMemo(() => ordenarOperadores(ura), [ura]);
  const lista = humanos
    .filter((u) => filtro === 'todos' || (filtro === 'outros' ? !['livre', 'atendimento'].includes(u.classe ?? '') : u.classe === filtro))
    .filter((u) => !busca || `${u.ramal} ${u.nome ?? ''}`.toLowerCase().includes(busca.toLowerCase()));
  const corpo = useFlip<HTMLTableSectionElement>(lista.map((u) => u.ramal));

  return (
    <Cartao titulo="Quem está na URA" extra={<span>{humanos.length} humano(s)</span>}>
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
            <thead><tr><th>Ramal</th><th>Operador</th><th>Status</th><th className="text-right">No status há</th></tr></thead>
            <tbody ref={corpo}>
              {lista.map((u) => {
                const c = CLASSES[u.classe ?? 'erro'];
                return (
                  <tr key={u.ramal} data-flip={u.ramal} className="hover:bg-slate-50 dark:hover:bg-noite-800/50">
                    <td className="numero">{u.ramal}</td>
                    <td>{u.nome ?? '—'}{u.fixo && <span className="ml-2 rounded-md bg-amarelo-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200">fixo</span>}</td>
                    <td><Selo tom={c.tom}>{u.classe === 'outro' && u.pausa ? u.pausa : c.texto}{u.emCarencia ? ' · carência' : ''}</Selo></td>
                    <td className="numero text-right">{u.statusDesde ? duracao((agora - new Date(u.statusDesde).getTime()) / 1000) : ''}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      ) : <Vazio>{humanos.length ? 'Ninguém com esse filtro.' : 'Ninguém na URA agora.'}</Vazio>}
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

function TabelaVendedores({ titulo, vendedores, rotuloValor, valor, vazio }: {
  titulo: ReactNode; vendedores: Vendedor[]; rotuloValor: string; valor: (v: Vendedor) => number | null | undefined; vazio: string;
}) {
  return (
    <div className="min-w-0">
      <h3 className="mb-2 flex items-baseline justify-between gap-2 text-sm font-semibold">{titulo}<span className="font-normal text-slate-500 dark:text-slate-400">{vendedores.length}</span></h3>
      {vendedores.length ? (
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead><tr><th>Ramal</th><th>Vendedor</th><th className="hidden sm:table-cell">Equipe</th><th className="text-right">{rotuloValor}</th></tr></thead>
            <tbody>{vendedores.map((v) => (
              <tr key={v.ramal}>
                <td className="numero">{v.ramal}</td>
                <td>{v.nome ?? '—'}{v.fixo && <span className="ml-2 rounded-md bg-amarelo-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200">fixo</span>}</td>
                <td className="hidden sm:table-cell">{v.equipe ?? ''}</td>
                <td className="numero whitespace-nowrap text-right">{reais(valor(v) ?? 0)}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Vazio>{vazio}</Vazio>}
    </div>
  );
}

function Roteador() {
  const { data: s, isError } = useRoteador();
  const subiram = subiramHoje(s);
  const metaOntem = metaBatidaOntem(s);
  const dia = diaCurto(s?.carga?.diaAnterior);
  const resumo = isError ? 'roteador sem resposta' : !s ? '' : s.cargaInicialFeita ? `carga do dia feita${s.ultimoMonitoramento ? ` · vendas lidas às ${horaCurta(s.ultimoMonitoramento)}` : ''}` : 'carga do dia pendente';
  const mini = (rotulo: string, valor: ReactNode) => (
    <div className="grid rounded-lg bg-azul-50 px-3 py-2.5 dark:bg-noite-800"><span className="rotulo">{rotulo}</span><b className="text-xl tabular-nums">{valor}</b></div>
  );
  return (
    <Cartao titulo="Vendas e filas (roteador)" extra={<span>{resumo}</span>}>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-5">
        {mini('Na URA pelo roteador', s?.ura?.length ?? '–')}
        {mini('No Ativo', s?.ativo?.length ?? '–')}
        {mini('Subiram por venda hoje', s ? subiram.length : '–')}
        {mini(`Meta batida ${dia ? `em ${dia}` : 'ontem'}`, s ? metaOntem.length : '–')}
        <div className="col-span-2 md:col-span-1">{mini('Meta diária', s ? reais(s.meta) : '–')}</div>
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <TabelaVendedores titulo="Subiram por venda hoje" vendedores={subiram} rotuloValor="Venda que fez subir"
          valor={(v) => v.vendaQueDisparou} vazio="Ninguém subiu por venda hoje ainda." />
        <TabelaVendedores titulo={`Meta batida ontem${dia ? ` (${dia})` : ''}`} vendedores={metaOntem} rotuloValor="Vendeu ontem"
          valor={(v) => v.vendaOntem} vazio={s?.cargaInicialFeita === false ? 'A carga do dia ainda não saiu.' : 'Ninguém passou da meta ontem.'} />
      </div>
    </Cartao>
  );
}

export function Visao({ escuro }: { escuro: boolean }) {
  const { data: v, dataUpdatedAt } = useVisao();
  const { data: dia } = useDia();
  const { data: metricas } = useMetricasHoje();
  const r = v ? v.servicos.rodizio.dados : undefined;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Visão geral</h1>
          <StatusUra />
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">{dataUpdatedAt ? `Atualizado às ${new Date(dataUpdatedAt).toLocaleTimeString('pt-BR')}` : 'Carregando…'}</p>
      </div>
      <Kpis r={r} metricas={metricas} />
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        <TabelaUra ura={r?.uraAgora ?? []} />
        <ListaCallbacks callbacks={dia?.callbacks ?? []} />
      </div>
      <Relatorio r={r?.relatorio} statusAtual={r?.statusUra?.status} />
      <Graficos escuro={escuro} />
      <Roteador />
    </>
  );
}
