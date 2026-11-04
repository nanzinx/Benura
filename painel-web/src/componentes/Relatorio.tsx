import { clsx } from 'clsx';
import { CalendarDays, ChartLine, Check, Grid3x3, ChevronDown, Download, Hourglass, Lightbulb, Lock, TriangleAlert, Wand2 } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { duracao, minutos } from '../formatos';
import { baixarXlsx } from '../planilha';
import {
  abasDoPeriodo, abasDoRelatorio, colunaDoStatus, diaCurto, diaMaisOcioso, diasVisiveis, horaMaisOciosa, indicadoresDoPeriodo, nivelDoIndicador, statusPorDia, statusPorHora, tendencia,
  totaisDoRelatorio, type CampoDaTendencia, type CampoDoQuadro, type Nivel, type Tendencia,
} from '../relatorio';
import { useRelatorioPeriodo, useStatusUra, useVisao } from '../dados';
import { semAcesso, usePode } from '../sessao';
import type { EstadoTermometro, RelatorioDoDia, RelatorioDoPeriodo, StatusDaUra, Sugestao } from '../tipos';
import { Botao, Cartao, Esqueleto, Segmentado, Vazio, useAberto } from '../ui/base';
import { GraficoTendencia } from './GraficoTendencia';
import { MapaDeRisco } from './MapaDeRisco';
import { CORES_DA_URA, NOMES_DA_URA } from './StatusUra';

const CORES_TERMOMETRO: Record<EstadoTermometro, string> = {
  agressiva: 'bg-red-600 dark:bg-red-700',
  normal: 'bg-azul-600 dark:bg-azul-500',
  calma: 'bg-emerald-600 dark:bg-emerald-700',
  medindo: 'bg-slate-300 dark:bg-noite-600',
};

/** Siglas do relatório (o significado aparece ao passar o mouse). */
const DICAS = {
  transbordos: 'Transbordos: os callbacks (o "Gerou Callback" da Argus): o cliente pediu um humano, esperou na fila e desistiu ou estourou o tempo, de 00:00 até agora.',
  tor: 'TOR — Tempo Ocioso sem Robô: tempo com alguém livre na URA e todos os robôs desligados (o que o pânico custa).',
  tme: 'TME — Tempo Médio de Espera: quanto tempo, em média, cada operador ficou livre (o "Tempo" da Argus) antes de receber uma ligação.',
  opl: 'OPL — Ociosidade Por Lead: o tempo livre de todos somado, dividido pelas ligações que chegaram aos humanos. Alto = gente demais livre para as ligações.',
  tpa: 'TPA — Tempo de Pânico Ativo: tempo em que o BenURA estava desligando ou reduzindo os robôs (0 livre, último livre saindo ou 1 fixo livre).',
  leads: 'Leads derivados: ligações dos robôs que a Argus derivou para um humano (o "Derivou" da Argus), na hora da ligação.',
  status: 'Status da URA: clique para trocar e ver quanto tempo ela passou em cada um hoje.',
};

/** [NOVO] Cor de cada quadro pelo nível (faixas em relatorio.ts: FAIXAS_DOS_QUADROS). */
const FUNDO_DO_NIVEL: Record<Nivel, string> = {
  bom: 'bg-emerald-50 dark:bg-emerald-950/40',
  atencao: 'bg-amarelo-100 dark:bg-amber-950/50',
  ruim: 'bg-red-50 dark:bg-red-950/50',
};
const TEXTO_DO_NIVEL: Record<Nivel, string> = {
  bom: 'text-emerald-800 dark:text-emerald-200',
  atencao: 'text-amber-900 dark:text-amber-100',
  ruim: 'text-red-700 dark:text-red-300',
};

function Numero({ rotulo, valor, nota, nivel, dica, comparar }: { rotulo: string; valor: ReactNode; nota?: ReactNode; nivel?: Nivel | null; dica?: string; comparar?: ReactNode }) {
  return (
    <div title={dica} className={clsx(dica && 'cursor-help', 'grid min-w-0 content-start gap-0.5 rounded-lg px-2.5 py-2', nivel ? FUNDO_DO_NIVEL[nivel] : 'bg-azul-50 dark:bg-noite-800')}>
      <span className="truncate text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">{rotulo}</span>
      <b className={clsx('text-lg leading-tight tabular-nums', nivel && TEXTO_DO_NIVEL[nivel])}>{valor}</b>
      {nota && <span className="truncate text-[11px] text-slate-500 dark:text-slate-400">{nota}</span>}
      {comparar && <span className="mt-0.5 grid gap-px border-t border-slate-200/80 pt-1 text-[11px] leading-tight text-slate-500 dark:border-noite-700 dark:text-slate-400">{comparar}</span>}
    </div>
  );
}

type Comparacao = NonNullable<RelatorioDoDia['comparacao']>;

const SETA: Record<Tendencia, string> = { melhor: '▼', pior: '▲', igual: '=' };
const COR_DA_TENDENCIA: Record<Tendencia, string> = {
  melhor: 'font-semibold text-emerald-700 dark:text-emerald-300',
  pior: 'font-semibold text-red-700 dark:text-red-300',
  igual: '',
};
const TEXTO_DA_TENDENCIA: Record<Tendencia, string> = { melhor: 'hoje está melhor', pior: 'hoje está pior', igual: 'igual a hoje' };

/**
 * [NOVO] "sex 23/10: 5" e "7 dias: 4", uma linha cada (o dia de hoje ainda não acabou: compare com calma).
 * Verde com ▼ quando hoje está melhor (menor), vermelho com ▲ quando está pior.
 */
function comparativo(c: Comparacao | undefined, campo: CampoDoQuadro, formatar: (v: number | null) => string, hoje: number | null): ReactNode {
  const linhas = [
    c?.anterior && { rotulo: diaCurto(c.anterior.dia), valor: c.anterior[campo] ?? null },
    c?.semana && { rotulo: '7 dias', valor: c.semana[campo] ?? null },
  ].filter((x): x is { rotulo: string; valor: number | null } => Boolean(x));
  if (!linhas.length) return undefined;
  return linhas.map(({ rotulo, valor }) => {
    const t = tendencia(hoje, valor);
    return (
      <span key={rotulo} className={clsx('flex items-center gap-1 truncate whitespace-nowrap', t && COR_DA_TENDENCIA[t])} title={t ? TEXTO_DA_TENDENCIA[t] : undefined}>
        {t && t !== 'igual' && <span aria-hidden>{SETA[t]}</span>}
        {rotulo}: {formatar(valor)}
      </span>
    );
  });
}

const ORDEM_STATUS: StatusDaUra[] = ['calma', 'normal', 'agressiva'];

/**
 * Quadrado do status da URA no relatório: fechado mostra o status de agora ("URA CALMA");
 * aberto, Automático e os três status com o tempo de cada um hoje. [NOVO] Clicar num deles
 * troca o status da URA (supervisor), como o seletor do topo da aba URA e robôs.
 */
function StatusDoDia({ r, atual }: { r: RelatorioDoDia; atual: EstadoTermometro | null | undefined }) {
  const [aberto, setAberto] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);
  const idMenu = useId();
  const { data: v } = useVisao();
  const s = v?.servicos.rodizio.dados?.statusUra;
  const mutacao = useStatusUra();
  const pode = usePode('supervisor');
  useEffect(() => {
    if (!aberto) return undefined;
    const fora = (e: MouseEvent) => { if (!raiz.current?.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc); };
  }, [aberto]);
  const status = atual ?? s?.status ?? 'medindo';
  const manual = s?.modo === 'manual';
  const ativa: 'automatico' | StatusDaUra = manual ? (s!.status as StatusDaUra) : 'automatico';
  const escolher = (id: 'automatico' | StatusDaUra) => {
    setAberto(false);
    if (!pode || id === ativa) return;
    mutacao.mutate(id === 'automatico' ? { modo: 'automatico' } : { modo: 'manual', status: id });
  };
  const item = 'flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left';
  return (
    <div ref={raiz} className="relative grid min-w-0 content-start gap-1 rounded-lg bg-azul-50 px-2.5 py-2 dark:bg-noite-800" title={DICAS.status}>
      <span className="truncate text-[11px] font-semibold tracking-wide text-slate-500 uppercase dark:text-slate-400">Status da URA</span>
      <button type="button" onClick={() => setAberto((a) => !a)} aria-haspopup="menu" aria-expanded={aberto} aria-controls={idMenu} disabled={mutacao.isPending}
        className={clsx('inline-flex w-fit cursor-pointer items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-bold tracking-wide uppercase disabled:cursor-progress', CORES_DA_URA[status])}>
        {manual && <Lock className="size-3.5" aria-label="manual" />}
        {NOMES_DA_URA[status]}
        <ChevronDown className={clsx('size-4 transition-transform', aberto && 'rotate-180')} aria-hidden />
      </button>
      {aberto && (
        <div id={idMenu} role="menu" className="absolute top-full right-0 z-40 mt-1 w-72 animate-entrar rounded-xl border border-slate-200 bg-white p-1.5 text-sm shadow-xl dark:border-noite-700 dark:bg-noite-900">
          <button type="button" role="menuitemradio" aria-checked={ativa === 'automatico'} disabled={!pode} onClick={() => escolher('automatico')}
            className={clsx(item, pode && 'cursor-pointer hover:bg-slate-100 dark:hover:bg-noite-800', ativa === 'automatico' && 'bg-azul-50 font-semibold dark:bg-noite-800')}>
            <Wand2 className="size-4 text-slate-400" aria-hidden />
            <span className="flex-1">Automático</span>
            {ativa === 'automatico' && <Check className="size-4 text-azul-600 dark:text-azul-300" aria-hidden />}
          </button>
          {ORDEM_STATUS.map((e) => (
            <button key={e} type="button" role="menuitemradio" aria-checked={ativa === e} disabled={!pode} onClick={() => escolher(e)}
              className={clsx(item, pode && 'cursor-pointer hover:bg-slate-100 dark:hover:bg-noite-800', ativa === e && 'bg-azul-50 font-semibold dark:bg-noite-800')}>
              <span className={clsx('size-2.5 rounded-full border', CORES_DA_URA[e])} aria-hidden />
              <span className="flex-1">{NOMES_DA_URA[e]}</span>
              <span className="text-slate-500 tabular-nums dark:text-slate-400">{minutos(r.termometroMin[e])}</span>
              {ativa === e && <Check className="size-4 text-azul-600 dark:text-azul-300" aria-hidden />}
            </button>
          ))}
          <p className="mt-1 border-t border-slate-100 px-3 pt-2 pb-1 text-xs text-slate-500 dark:border-noite-800 dark:text-slate-400">
            {pode ? 'Clique para trocar o status da URA. ' : `${semAcesso('supervisor')} troca o status. `}Ao lado, o tempo em cada status hoje.
          </p>
        </div>
      )}
    </div>
  );
}

/** [NOVO] O status da URA hora a hora: cada hora uma barra com o tempo calma, normal, agressiva e medindo. */
function BarraTermometro({ r }: { r: RelatorioDoDia }) {
  const ordem: EstadoTermometro[] = ['agressiva', 'normal', 'calma', 'medindo'];
  const horas = statusPorHora(r.horas);
  if (!horas.some((h) => h.total > 0)) return null;
  return (
    <div className="mb-4 grid gap-1.5">
      <div className="flex gap-1" role="img"
        aria-label={`Status da URA por hora: ${horas.map((h) => `${h.hora}h ${ordem.filter((e) => h[e] > 0).map((e) => `${e} ${minutos(h[e])}`).join(', ') || 'sem medida'}`).join('; ')}`}>
        {horas.map((h) => (
          <div key={h.hora} className="grid min-w-0 flex-1 gap-1" title={`${h.hora}h: ${ordem.filter((e) => h[e] > 0).map((e) => `${e} ${minutos(h[e])}`).join(' · ') || 'sem medida'}`}>
            <div className="flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-noite-800">
              {ordem.map((e) => h[e] > 0 && <span key={e} className={CORES_TERMOMETRO[e]} style={{ width: `${(h[e] / Math.max(60, h.total)) * 100}%` }} />)}
            </div>
            <span className="text-center text-[11px] text-slate-500 tabular-nums dark:text-slate-400">{h.hora}h</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
        {ordem.map((e) => (
          <span key={e} className="inline-flex items-center gap-1.5"><span className={clsx('size-2.5 rounded-sm', CORES_TERMOMETRO[e])} aria-hidden />{e} {minutos(r.termometroMin[e])}</span>
        ))}
      </div>
    </div>
  );
}

type AbaDoRelatorio = 'hoje' | '7' | '30';
const ABAS_DO_RELATORIO: { valor: AbaDoRelatorio; texto: string }[] = [{ valor: 'hoje', texto: 'Hoje' }, { valor: '7', texto: '7 dias' }, { valor: '30', texto: '30 dias' }];

/**
 * Relatório: [NOVO] abas Hoje | 7 dias | 30 dias. Hoje é o relatório do dia, hora a hora; as outras
 * mostram um dia por linha, comparam com o período anterior e trazem as sugestões de ajuste.
 */
export function Relatorio({ r, statusAtual }: { r: RelatorioDoDia | null | undefined; statusAtual?: EstadoTermometro | null }) {
  const [aba, setAba] = useState<AbaDoRelatorio>('hoje');
  const seletor = <Segmentado rotulo="Período do relatório" opcoes={ABAS_DO_RELATORIO} valor={aba} aoMudar={setAba} />;
  if (aba !== 'hoje') return <RelatorioDoPeriodoCartao dias={aba === '30' ? 30 : 7} statusAtual={statusAtual} seletor={seletor} />;
  return <RelatorioDeHoje r={r} statusAtual={statusAtual} seletor={seletor} />;
}

/** Relatório do dia: transbordos, TOR, TME, OPL, TPA e o status da URA, também por hora. */
function RelatorioDeHoje({ r, statusAtual, seletor }: { r: RelatorioDoDia | null | undefined; statusAtual?: EstadoTermometro | null; seletor: ReactNode }) {
  if (!r) {
    return <Cartao titulo="Relatório do dia" className="mb-5" extra={seletor}><Vazio>O relatório aparece quando o rodízio estiver rodando.</Vazio></Cartao>;
  }
  const horas = r.horas;
  // [NOVO] A hora mais ociosa é a de OPL mais alto (tempo livre por lead).
  const maisOciosaHora = horaMaisOciosa(horas);
  // [NOVO] Os quadros e o total somam as horas mostradas (só o expediente, 08h às 17h).
  const t = totaisDoRelatorio(r);
  const [panicoTotal, ociosoTotal, livresTotal, oplTotal, esperaQtdTotal, tmeTotal] = [t.tpa, t.tor, t.livres, t.opl, t.esperaQtd, t.tme];
  // [NOVO] A coluna de status da tabela segue o status da URA de agora (calma, normal, agressiva).
  const coluna = colunaDoStatus(horas, statusAtual);
  const c = r.comparacao;
  const numero = (v: number | null) => (v == null ? '–' : String(v));
  const vezes = r.panicoVezes.zero + r.panicoVezes.saindo + r.panicoVezes.fixo;
  const transbordos = r.transbordos ?? 0;
  const pior = [...horas].sort((a, b) => (b.transbordos ?? 0) - (a.transbordos ?? 0))[0];
  const motivo = Object.entries(r.transbordosPorMotivo ?? {}).sort((a, b) => b[1] - a[1])[0];
  const notaTransbordos = !transbordos ? 'nenhum hoje'
    : pior && (pior.transbordos ?? 0) > 1 ? `${pior.transbordos} às ${pior.hora}h${motivo ? ` · mais ${motivo[0]}` : ''}`
      : motivo ? `mais ${motivo[0]}` : undefined;

  return (
    <Cartao titulo="Relatório do dia" className="mb-5" extra={(
      <>
        {seletor}
        <span className="hidden sm:inline">no expediente, hora a hora</span>
        <Botao variante="secundario" className="min-h-8 px-3 py-1" icone={<Download className="size-4" aria-hidden />}
          title="Baixa o relatório de hoje (hora a hora, comparação e por atendente) para abrir no Excel"
          onClick={() => baixarXlsx(`relatorio-benura-${r.dia}.xlsx`, abasDoRelatorio(r))}>
          Planilha
        </Botao>
      </>
    )}>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Numero rotulo="Transbordos" dica={DICAS.transbordos} valor={r.transbordos ?? '–'} nivel={nivelDoIndicador('transbordos', transbordos)} nota={notaTransbordos}
          comparar={comparativo(c, 'transbordos', numero, transbordos)} />
        <Numero rotulo="TOR" dica={DICAS.tor} valor={minutos(ociosoTotal)} nivel={nivelDoIndicador('torMin', ociosoTotal)}
          nota="ocioso sem robô" comparar={comparativo(c, 'torMin', minutos, ociosoTotal)} />
        <Numero rotulo="TME" dica={DICAS.tme} valor={duracao(tmeTotal)} nivel={nivelDoIndicador('tmeSeg', tmeTotal)} nota={`${esperaQtdTotal} ligação(ões) medida(s)`}
          comparar={comparativo(c, 'tmeSeg', duracao, tmeTotal)} />
        <Numero rotulo="OPL" dica={DICAS.opl} valor={duracao(oplTotal)} nivel={nivelDoIndicador('oplSeg', oplTotal)} nota={`${minutos(livresTotal)} livres`}
          comparar={comparativo(c, 'oplSeg', duracao, oplTotal)} />
        <Numero rotulo="TPA" dica={DICAS.tpa} valor={minutos(panicoTotal)} nivel={nivelDoIndicador('tpaMin', panicoTotal)} nota={`pânico ativo · ${vezes} vez(es)`}
          comparar={comparativo(c, 'tpaMin', minutos, panicoTotal)} />
        <StatusDoDia r={r} atual={statusAtual} />
      </div>
      <BarraTermometro r={r} />
      {horas.length ? (
        <div className="overflow-x-auto">
          <table className="tabela tabela-cartoes">
            <thead><tr>
              <th>Hora</th>
              <th className="text-right"><abbr title={DICAS.leads} className="cursor-help no-underline">Leads derivados</abbr></th>
              <th className="text-right"><abbr title={DICAS.tme} className="cursor-help no-underline">TME</abbr></th>
              <th className="text-right"><abbr title={DICAS.opl} className="cursor-help no-underline">OPL</abbr></th>
              <th className="text-right"><abbr title={DICAS.tor} className="cursor-help no-underline">TOR</abbr></th>
              <th className="text-right"><abbr title={DICAS.tpa} className="cursor-help no-underline">TPA</abbr></th>
              <th className="text-right" title={`Minutos em ${coluna.titulo.toLowerCase()} em cada hora (segue o status da URA)`}>
                <span className="inline-flex items-center gap-1.5"><span className={clsx('size-2 rounded-full', CORES_TERMOMETRO[coluna.status])} aria-hidden />{coluna.titulo}</span>
              </th>
              <th className="text-right"><abbr title={DICAS.transbordos} className="cursor-help no-underline">Transbordos</abbr></th>
            </tr></thead>
            <tbody>{horas.map((x, i) => {
              const tb = x.transbordos ?? 0;
              const maisOciosa = x.hora === maisOciosaHora;
              return (
                <tr key={x.hora} className={clsx(maisOciosa && 'bg-amarelo-100/60 dark:bg-amber-950/30')}>
                  <td data-rotulo="Hora" className="numero whitespace-nowrap font-semibold">{x.hora}h{maisOciosa && <span title="A hora com mais tempo livre por lead (OPL mais alto)" className="ml-2 cursor-help rounded-md bg-amarelo-500 px-1.5 py-0.5 text-[11px] font-bold text-marinho-950">mais ociosa</span>}</td>
                  <td data-rotulo="Leads derivados" className="numero text-right">{x.leadsDerivados ?? 0}</td>
                  <td data-rotulo="TME" className="numero text-right">{duracao(x.tmeSeg ?? null)}</td>
                  <td data-rotulo="OPL" className="numero text-right">{duracao(x.esperaPorDerivacaoSeg)}</td>
                  <td data-rotulo="TOR" className="numero text-right">{minutos(x.ociosoSemRobosMin)}</td>
                  <td data-rotulo="TPA" className="numero text-right">{minutos(x.panicoMin)}</td>
                  <td data-rotulo={coluna.titulo} className="numero text-right">{minutos(coluna.porHora[i])}</td>
                  <td data-rotulo="Transbordos" className={clsx('numero text-right', tb && 'font-bold text-red-700 dark:text-red-400')}>{tb}</td>
                </tr>
              );
            })}</tbody>
            {/* [NOVO] Total do dia (00:00 até agora), com os mesmos números dos quadros de cima. */}
            <tfoot><tr className="border-t-2 border-slate-300 font-bold dark:border-noite-600">
              <td data-rotulo="Hora" className="numero whitespace-nowrap">Total</td>
              <td data-rotulo="Leads derivados" className="numero text-right">{r.leadsDerivados ?? 0}</td>
              <td data-rotulo="TME" className="numero text-right">{duracao(tmeTotal)}</td>
              <td data-rotulo="OPL" className="numero text-right">{duracao(oplTotal)}</td>
              <td data-rotulo="TOR" className="numero text-right">{minutos(ociosoTotal)}</td>
              <td data-rotulo="TPA" className="numero text-right">{minutos(panicoTotal)}</td>
              <td data-rotulo={coluna.titulo} className="numero text-right">{minutos(coluna.total)}</td>
              <td data-rotulo="Transbordos" className={clsx('numero text-right', transbordos && 'text-red-700 dark:text-red-400')}>{transbordos}</td>
            </tr></tfoot>
          </table>
        </div>
      ) : <Vazio>Nada medido ainda hoje.</Vazio>}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        <b>TOR</b>: Tempo Ocioso sem Robô · <b>TME</b>: Tempo Médio de Espera · <b>OPL</b>: Ociosidade Por Lead · <b>TPA</b>: Tempo de Pânico Ativo · <b>Transbordos</b>: os callbacks ("Gerou Callback" da Argus).
      </p>
    </Cartao>
  );
}

// ───────────── [NOVO] Relatório de 7 e 30 dias ─────────────

/** Na tabela do período, com mais que isso, só os mais recentes (e "Ver todos"). */
const LIMITE_DE_DIAS = 10;

const virgula = (v: number | null | undefined) => (v == null ? '–' : String(Math.round(v * 10) / 10).replace('.', ','));

/** "7 dias antes: 1,3/dia", verde com ▼ quando o período atual está melhor (menor), vermelho com ▲ quando pior. */
function comparativoDoPeriodo(rotulo: string, atual: number | null, antes: number | null | undefined, formatar: (v: number | null) => string): ReactNode {
  if (antes === undefined) return undefined;
  const t = tendencia(atual, antes);
  return (
    <span className={clsx('flex items-center gap-1 truncate whitespace-nowrap', t && COR_DA_TENDENCIA[t])} title={t ? { melhor: 'agora está melhor', pior: 'agora está pior', igual: 'igual' }[t] : undefined}>
      {t && t !== 'igual' && <span aria-hidden>{SETA[t]}</span>}
      {/* no celular, "antes" (o quadro é estreito e o número cortava) */}
      <span className="sm:hidden">antes:</span><span className="max-sm:hidden">{rotulo}:</span> {formatar(antes ?? null)}
    </span>
  );
}

/** O status da URA dia a dia: cada dia uma barra com a proporção de calma, normal, agressiva e medindo. */
function BarraPorDia({ p }: { p: RelatorioDoPeriodo }) {
  const ordem: EstadoTermometro[] = ['agressiva', 'normal', 'calma', 'medindo'];
  const dias = statusPorDia(p.dias);
  if (!dias.some((d) => d.total > 0)) return null;
  const rotulo = (dia: string) => (p.tamanho === 30 ? dia.slice(8) : diaCurto(dia).slice(0, 6));
  const t = p.totais;
  const totalDo: Record<EstadoTermometro, number> = { calma: t.calmaMin, normal: t.normalMin, agressiva: t.agressivaMin, medindo: t.medindoMin };
  const resumo = (d: (typeof dias)[number]) => ordem.filter((e) => d[e] > 0).map((e) => `${e} ${minutos(d[e])}`).join(' · ') || 'sem medida';
  return (
    <div className="mb-4 grid gap-1.5">
      <div className={clsx('flex', p.tamanho === 30 ? 'gap-0.5' : 'gap-1')} role="img"
        aria-label={`Status da URA por dia: ${dias.map((d) => `${diaCurto(d.dia)} ${resumo(d)}`).join('; ')}`}>
        {dias.map((d, i) => (
          <div key={d.dia} className="grid min-w-0 flex-1 gap-1" title={`${diaCurto(d.dia)}${p.dias[i]?.hoje ? ' (hoje)' : ''}: ${resumo(d)}`}>
            <div className="flex h-3 overflow-hidden rounded-full bg-slate-100 dark:bg-noite-800">
              {ordem.map((e) => d[e] > 0 && <span key={e} className={CORES_TERMOMETRO[e]} style={{ width: `${(d[e] / d.total) * 100}%` }} />)}
            </div>
            <span className={clsx('truncate text-center text-[11px] tabular-nums', p.dias[i]?.hoje ? 'font-bold text-azul-700 dark:text-azul-300' : 'text-slate-500 dark:text-slate-400',
              p.tamanho === 30 && i % 2 === 1 && 'max-sm:invisible')}>{rotulo(d.dia)}</span>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
        {ordem.map((e) => (
          <span key={e} className="inline-flex items-center gap-1.5"><span className={clsx('size-2.5 rounded-sm', CORES_TERMOMETRO[e])} aria-hidden />{e} {minutos(totalDo[e])}</span>
        ))}
      </div>
    </div>
  );
}

const ESTILO_DA_SUGESTAO: Record<Sugestao['tipo'], { icone: ReactNode; caixa: string }> = {
  comparacao: { icone: <Lightbulb className="size-4 text-emerald-600 dark:text-emerald-300" aria-hidden />, caixa: 'bg-emerald-50 dark:bg-emerald-950/40' },
  aviso: { icone: <TriangleAlert className="size-4 text-amber-600 dark:text-amber-300" aria-hidden />, caixa: 'bg-amarelo-100 dark:bg-amber-950/50' },
  semana: { icone: <CalendarDays className="size-4 text-azul-600 dark:text-azul-300" aria-hidden />, caixa: 'bg-azul-50 dark:bg-noite-800' },
  progresso: { icone: <Hourglass className="size-4 text-slate-400" aria-hidden />, caixa: 'bg-slate-50 dark:bg-noite-800/60' },
};

/** As sugestões de ajuste: tiradas do histórico, só sugerem (quem muda é o .env, à mão). */
function Sugestoes({ lista }: { lista: Sugestao[] }) {
  if (!lista.length) return null;
  return (
    <div className="mb-4 grid gap-2 rounded-xl border border-slate-200 p-3 dark:border-noite-700">
      <h3 className="flex items-center gap-2 text-sm font-semibold"><Lightbulb className="size-4 text-amarelo-500" aria-hidden />Sugestões</h3>
      <ul className="grid gap-1.5">
        {lista.map((s) => (
          <li key={s.texto} className={clsx('flex items-start gap-2 rounded-lg px-2.5 py-2 text-sm leading-snug', ESTILO_DA_SUGESTAO[s.tipo].caixa)}>
            <span className="mt-0.5 shrink-0">{ESTILO_DA_SUGESTAO[s.tipo].icone}</span>
            <span>{s.texto}</span>
          </li>
        ))}
      </ul>
      <p className="text-xs text-slate-500 dark:text-slate-400">
        Usam todo o histórico guardado, não só os dias da aba. Comparam só as horas de cada status (com os robôs no automático), em dias completos com 2 h ou mais nele,
        e só com 3 dias ou mais de cada configuração. O BenURA não muda nada sozinho.
      </p>
    </div>
  );
}

/** Relatório de 7 ou 30 dias: os mesmos quadros (em média por dia), a barra e a tabela dia a dia e as sugestões. */
function RelatorioDoPeriodoCartao({ dias, statusAtual, seletor }: { dias: 7 | 30; statusAtual?: EstadoTermometro | null; seletor: ReactNode }) {
  const { data: p, isPending, error } = useRelatorioPeriodo(dias);
  // [NOVO] a tendência só com um clique (fechada não ocupa a tela) e a tabela de 30 dias curta; o navegador lembra
  const [tendenciaAberta, setTendenciaAberta] = useAberto('relatorio-tendencia', false);
  const [campoTendencia, setCampoTendencia] = useState<CampoDaTendencia>('oplSeg');
  const [todosOsDias, setTodosOsDias] = useAberto(`relatorio-todos-${dias}`, false);
  // [NOVO] o mapa de risco dos robôs, também só com um clique
  const [mapaAberto, setMapaAberto] = useAberto('relatorio-mapa-risco', false);
  const titulo = dias === 30 ? 'Relatório do mês' : 'Relatório da semana';
  const extra = (
    <>
      {seletor}
      <span className="hidden sm:inline">últimos {dias} dias, um por linha</span>
      <Botao variante="secundario" className="min-h-8 px-3 py-1" icone={<Download className="size-4" aria-hidden />} disabled={!p}
        title={`Baixa os últimos ${dias} dias (por dia, totais com o período anterior e por atendente) para abrir no Excel`}
        onClick={() => p && baixarXlsx(`relatorio-benura-${dias}-dias-${p.dias.at(-1)?.dia ?? p.desde}.xlsx`, abasDoPeriodo(p))}>
        Planilha
      </Botao>
    </>
  );
  if (isPending) {
    return (
      <Cartao titulo={titulo} className="mb-5" extra={extra}>
        <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">{Array.from({ length: 6 }, (_, i) => <Esqueleto key={i} className="h-20" />)}</div>
        <Esqueleto className="h-40" />
      </Cartao>
    );
  }
  if (error || !p) {
    return <Cartao titulo={titulo} className="mb-5" extra={extra}><Vazio>Não foi possível carregar o relatório{error ? `: ${error.message}` : ''}.</Vazio></Cartao>;
  }
  const t = p.totais;
  const ind = indicadoresDoPeriodo(t)!;
  const ant = indicadoresDoPeriodo(p.anterior);
  const rotuloAntes = `${dias} dias antes`;
  const antes = (campo: CampoDoQuadro) => (ant ? ant[campo] : undefined);
  const porDia = (v: number | null) => (v == null ? '–' : `${virgula(v)}/dia`);
  const minPorDia = (v: number | null) => (v == null ? '–' : `${minutos(v)}/dia`);
  const coluna = colunaDoStatus(p.dias, statusAtual);
  // [NOVO] com mais de 10 dias, só os mais recentes (o total embaixo é sempre do período todo)
  const visiveis = diasVisiveis(p.dias.map((d, i) => ({ d, i })), todosOsDias, LIMITE_DE_DIAS);
  const maisOciosoDia = diaMaisOcioso(p.dias);
  const pior = [...p.dias].sort((a, b) => b.transbordos - a.transbordos)[0];
  return (
    <Cartao titulo={titulo} className="mb-5" extra={extra}>
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        <Numero rotulo="Transbordos" dica={DICAS.transbordos} valor={t.transbordos} nivel={nivelDoIndicador('transbordos', ind.transbordos)}
          nota={pior?.transbordos ? `${virgula(t.transbordosDia)}/dia · pior ${diaCurto(pior.dia)}` : 'nenhum no período'}
          comparar={comparativoDoPeriodo(rotuloAntes, ind.transbordos, antes('transbordos'), porDia)} />
        <Numero rotulo="TOR" dica={DICAS.tor} valor={minPorDia(ind.torMin)} nivel={nivelDoIndicador('torMin', ind.torMin)}
          nota={`${minutos(t.torMin)} no período`} comparar={comparativoDoPeriodo(rotuloAntes, ind.torMin, antes('torMin'), minPorDia)} />
        <Numero rotulo="TME" dica={DICAS.tme} valor={duracao(ind.tmeSeg)} nivel={nivelDoIndicador('tmeSeg', ind.tmeSeg)} nota={`${t.dias} dia(s) com dados`}
          comparar={comparativoDoPeriodo(rotuloAntes, ind.tmeSeg, antes('tmeSeg'), duracao)} />
        <Numero rotulo="OPL" dica={DICAS.opl} valor={duracao(ind.oplSeg)} nivel={nivelDoIndicador('oplSeg', ind.oplSeg)} nota={`${minutos(t.livresMin)} livres`}
          comparar={comparativoDoPeriodo(rotuloAntes, ind.oplSeg, antes('oplSeg'), duracao)} />
        <Numero rotulo="TPA" dica={DICAS.tpa} valor={minPorDia(ind.tpaMin)} nivel={nivelDoIndicador('tpaMin', ind.tpaMin)}
          nota={`${minutos(t.tpaMin)} no período`} comparar={comparativoDoPeriodo(rotuloAntes, ind.tpaMin, antes('tpaMin'), minPorDia)} />
        <Numero rotulo="Leads derivados" dica={DICAS.leads} valor={t.leadsDerivados} nota={`${virgula(t.leadsDia)}/dia`}
          comparar={p.anterior ? <span className="truncate whitespace-nowrap"><span className="sm:hidden">antes:</span> <span className="max-sm:hidden">{rotuloAntes}:</span> {virgula(p.anterior.leadsDia)}/dia</span> : undefined} />
      </div>
      {p.dias.length > 1 && (
        <div className="mb-4">
          <button type="button" onClick={() => setTendenciaAberta(!tendenciaAberta)} aria-expanded={tendenciaAberta}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-azul-700 hover:bg-azul-50 dark:text-azul-300 dark:hover:bg-noite-800">
            <ChartLine className="size-4" aria-hidden />
            {tendenciaAberta ? 'Esconder a tendência' : 'Ver tendência dia a dia'}
            <ChevronDown className={clsx('size-4 transition-transform', tendenciaAberta && 'rotate-180')} aria-hidden />
          </button>
          {tendenciaAberta && (
            <div className="mt-2 animate-entrar rounded-xl border border-slate-200 p-3 dark:border-noite-700">
              <GraficoTendencia dias={p.dias} campo={campoTendencia} aoMudar={setCampoTendencia} />
            </div>
          )}
        </div>
      )}
      {p.mapaRisco && (
        <div className="mb-4">
          <button type="button" onClick={() => setMapaAberto(!mapaAberto)} aria-expanded={mapaAberto}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2 py-1 text-sm font-medium text-azul-700 hover:bg-azul-50 dark:text-azul-300 dark:hover:bg-noite-800">
            <Grid3x3 className="size-4" aria-hidden />
            {mapaAberto ? 'Esconder o mapa de risco dos robôs' : 'Ver mapa de risco dos robôs'}
            <ChevronDown className={clsx('size-4 transition-transform', mapaAberto && 'rotate-180')} aria-hidden />
          </button>
          {mapaAberto && (
            <div className="mt-2 animate-entrar rounded-xl border border-slate-200 p-3 dark:border-noite-700">
              <MapaDeRisco mapa={p.mapaRisco} transbordos={t.transbordos} />
            </div>
          )}
        </div>
      )}
      <Sugestoes lista={p.sugestoes} />
      <BarraPorDia p={p} />
      {p.dias.length ? (
        <div className="overflow-x-auto">
          <table className="tabela tabela-cartoes sm:whitespace-nowrap">
            <thead><tr>
              <th>Dia</th>
              <th className="text-right"><abbr title={DICAS.leads} className="cursor-help no-underline">Leads derivados</abbr></th>
              <th className="text-right"><abbr title={DICAS.tme} className="cursor-help no-underline">TME</abbr></th>
              <th className="text-right"><abbr title={DICAS.opl} className="cursor-help no-underline">OPL</abbr></th>
              <th className="text-right"><abbr title={DICAS.tor} className="cursor-help no-underline">TOR</abbr></th>
              <th className="text-right"><abbr title={DICAS.tpa} className="cursor-help no-underline">TPA</abbr></th>
              <th className="text-right" title={`Minutos em ${coluna.titulo.toLowerCase()} em cada dia (segue o status da URA)`}>
                <span className="inline-flex items-center gap-1.5"><span className={clsx('size-2 rounded-full', CORES_TERMOMETRO[coluna.status])} aria-hidden />{coluna.titulo}</span>
              </th>
              <th className="text-right" title="Média de robôs ligados no expediente">Robôs</th>
              <th className="text-right"><abbr title={DICAS.transbordos} className="cursor-help no-underline">Transbordos</abbr></th>
            </tr></thead>
            <tbody>{visiveis.map(({ d, i }) => {
              const maisOcioso = d.dia === maisOciosoDia;
              return (
                <tr key={d.dia} className={clsx(maisOcioso && 'bg-amarelo-100/60 dark:bg-amber-950/30')}>
                  <td data-rotulo="Dia" className="numero whitespace-nowrap font-semibold">
                    {diaCurto(d.dia)}
                    {d.hoje && <span className="ml-2 rounded-md bg-azul-100 px-1.5 py-0.5 text-[11px] font-bold text-azul-800 dark:bg-noite-700 dark:text-azul-300" title="Hoje ainda não acabou">hoje</span>}
                    {maisOcioso && <span title="O dia com mais tempo livre por lead (OPL mais alto)" className="ml-2 cursor-help rounded-md bg-amarelo-500 px-1.5 py-0.5 text-[11px] font-bold text-marinho-950">mais ocioso</span>}
                  </td>
                  <td data-rotulo="Leads derivados" className="numero text-right">{d.leadsDerivados}</td>
                  <td data-rotulo="TME" className="numero text-right">{duracao(d.tmeSeg)}</td>
                  <td data-rotulo="OPL" className="numero text-right">{duracao(d.oplSeg)}</td>
                  <td data-rotulo="TOR" className="numero text-right">{minutos(d.torMin)}</td>
                  <td data-rotulo="TPA" className="numero text-right">{minutos(d.tpaMin)}</td>
                  <td data-rotulo={coluna.titulo} className="numero text-right">{minutos(coluna.porHora[i])}</td>
                  <td data-rotulo="Robôs" className="numero text-right">{virgula(d.robosLigadosMedia)}</td>
                  <td data-rotulo="Transbordos" className={clsx('numero text-right', d.transbordos > 0 && 'font-bold text-red-700 dark:text-red-400')}>{d.transbordos}</td>
                </tr>
              );
            })}</tbody>
            <tfoot><tr className="border-t-2 border-slate-300 font-bold dark:border-noite-600">
              <td data-rotulo="Dia" className="numero whitespace-nowrap">Total</td>
              <td data-rotulo="Leads derivados" className="numero text-right">{t.leadsDerivados}</td>
              <td data-rotulo="TME" className="numero text-right">{duracao(t.tmeSeg)}</td>
              <td data-rotulo="OPL" className="numero text-right">{duracao(t.oplSeg)}</td>
              <td data-rotulo="TOR" className="numero text-right">{minutos(t.torMin)}</td>
              <td data-rotulo="TPA" className="numero text-right">{minutos(t.tpaMin)}</td>
              <td data-rotulo={coluna.titulo} className="numero text-right">{minutos(coluna.total)}</td>
              <td data-rotulo="Robôs" className="numero text-right" />
              <td data-rotulo="Transbordos" className={clsx('numero text-right', t.transbordos > 0 && 'text-red-700 dark:text-red-400')}>{t.transbordos}</td>
            </tr></tfoot>
          </table>
        </div>
      ) : <Vazio>Ainda não há dias guardados neste período.</Vazio>}
      {p.dias.length > LIMITE_DE_DIAS && (
        <button type="button" onClick={() => setTodosOsDias(!todosOsDias)}
          className="mt-2 w-full cursor-pointer rounded-lg py-1.5 text-sm font-medium text-azul-600 hover:bg-azul-50 dark:text-azul-300 dark:hover:bg-noite-800">
          {todosOsDias ? `Mostrar só os ${LIMITE_DE_DIAS} mais recentes` : `Ver todos os ${p.dias.length} dias`}
        </button>
      )}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Desde {diaCurto(p.desde)}. TOR, TPA e transbordos dos quadros em média por dia completo (a mesma régua de cores do dia); TME e OPL somando o período.
        Hoje entra nas somas, ainda parcial, mas não nas médias por dia. A comparação é com os {dias} dias anteriores.
      </p>
    </Cartao>
  );
}
