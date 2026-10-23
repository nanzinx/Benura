import { clsx } from 'clsx';
import { ChevronDown } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { duracao, minutos } from '../formatos';
import type { EstadoTermometro, RelatorioDoDia } from '../tipos';
import { Cartao, Vazio } from '../ui/base';
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
  tme: 'TME — Tempo Médio de Espera: quanto, em média, o operador livre espera por uma ligação.',
  tpa: 'TPA — Tempo de Pânico Ativo: tempo em que o BenURA estava desligando ou reduzindo os robôs (0 livre, último livre saindo ou 1 fixo livre).',
  leads: 'Leads atendidos por operador: ligações da URA que chegaram aos humanos (derivações) na hora.',
  status: 'Status da URA ao longo do dia: clique para ver quanto tempo ela passou em cada um.',
};

function Numero({ rotulo, valor, nota, destaque, dica }: { rotulo: string; valor: ReactNode; nota?: ReactNode; destaque?: 'perigo' | 'alerta'; dica?: string }) {
  return (
    <div title={dica} className={clsx(dica && 'cursor-help', 'grid content-start rounded-lg px-3 py-2.5', destaque === 'perigo' ? 'bg-red-50 dark:bg-red-950/50' : destaque === 'alerta' ? 'bg-amarelo-100 dark:bg-amber-950/50' : 'bg-azul-50 dark:bg-noite-800')}>
      <span className="rotulo">{rotulo}</span>
      <b className={clsx('text-xl tabular-nums', destaque === 'perigo' && 'text-red-700 dark:text-red-300', destaque === 'alerta' && 'text-amber-900 dark:text-amber-100')}>{valor}</b>
      {nota && <span className="text-xs text-slate-500 dark:text-slate-400">{nota}</span>}
    </div>
  );
}

const ORDEM_STATUS: EstadoTermometro[] = ['calma', 'normal', 'agressiva'];

/**
 * Quadrado do status da URA no relatório: fechado mostra só o status de agora
 * ("URA CALMA"); aberto, as três opções com o tempo de cada uma hoje (só leitura).
 */
function StatusDoDia({ r, atual }: { r: RelatorioDoDia; atual: EstadoTermometro | null | undefined }) {
  const [aberto, setAberto] = useState(false);
  const raiz = useRef<HTMLDivElement>(null);
  const idMenu = useId();
  useEffect(() => {
    if (!aberto) return undefined;
    const fora = (e: MouseEvent) => { if (!raiz.current?.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc); };
  }, [aberto]);
  const status = atual ?? 'medindo';
  return (
    <div ref={raiz} className="relative grid content-start rounded-lg bg-azul-50 px-3 py-2.5 dark:bg-noite-800" title={DICAS.status}>
      <span className="rotulo">Status da URA</span>
      <button type="button" onClick={() => setAberto((a) => !a)} aria-haspopup="menu" aria-expanded={aberto} aria-controls={idMenu}
        className={clsx('mt-1 inline-flex w-fit cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-sm font-bold tracking-wide uppercase', CORES_DA_URA[status])}>
        {NOMES_DA_URA[status]}
        <ChevronDown className={clsx('size-4 transition-transform', aberto && 'rotate-180')} aria-hidden />
      </button>
      {aberto && (
        <div id={idMenu} role="menu" className="absolute top-full right-0 z-40 mt-1 w-64 animate-entrar rounded-xl border border-slate-200 bg-white p-1.5 text-sm shadow-xl dark:border-noite-700 dark:bg-noite-900">
          {ORDEM_STATUS.map((e) => (
            <div key={e} role="menuitem" className={clsx('flex items-center gap-2 rounded-lg px-3 py-2', e === status && 'bg-azul-50 font-semibold dark:bg-noite-800')}>
              <span className={clsx('size-2.5 rounded-full border', CORES_DA_URA[e])} aria-hidden />
              <span className="flex-1">{NOMES_DA_URA[e]}</span>
              <span className="text-slate-500 tabular-nums dark:text-slate-400">{minutos(r.termometroMin[e])}</span>
            </div>
          ))}
          <p className="mt-1 border-t border-slate-100 px-3 pt-2 pb-1 text-xs text-slate-500 dark:border-noite-800 dark:text-slate-400">Tempo em cada status hoje (00:00 até agora).</p>
        </div>
      )}
    </div>
  );
}

/** Quanto do dia a URA passou calma, normal ou agressiva (os tempos ficam no quadrado do status). */
function BarraTermometro({ r }: { r: RelatorioDoDia }) {
  const ordem: EstadoTermometro[] = ['agressiva', 'normal', 'calma', 'medindo'];
  const total = ordem.reduce((s, e) => s + (r.termometroMin[e] ?? 0), 0);
  if (!total) return null;
  return (
    <div className="mb-4 grid gap-1.5">
      <div className="flex h-3 overflow-hidden rounded-full" role="img"
        aria-label={`Status da URA no dia: ${ordem.map((e) => `${e} ${minutos(r.termometroMin[e])}`).join(', ')}`}>
        {ordem.map((e) => r.termometroMin[e] > 0 && <span key={e} className={CORES_TERMOMETRO[e]} style={{ width: `${(r.termometroMin[e] / total) * 100}%` }} />)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
        {ordem.map((e) => (
          <span key={e} className="inline-flex items-center gap-1.5"><span className={clsx('size-2.5 rounded-sm', CORES_TERMOMETRO[e])} aria-hidden />{e}</span>
        ))}
      </div>
    </div>
  );
}

/** Relatório do dia: transbordos, TOR, TME, TPA e o status da URA, também por hora. */
export function Relatorio({ r, statusAtual }: { r: RelatorioDoDia | null | undefined; statusAtual?: EstadoTermometro | null }) {
  if (!r) {
    return <Cartao titulo="Relatório do dia" className="mb-5"><Vazio>O relatório aparece quando o rodízio estiver rodando.</Vazio></Cartao>;
  }
  const horas = r.horas;
  const piorOcioso = Math.max(0, ...horas.map((h) => h.ociosoSemRobosMin));
  const panicoTotal = r.panicoMin.zero + r.panicoMin.saindo + r.panicoMin.fixo;
  const vezes = r.panicoVezes.zero + r.panicoVezes.saindo + r.panicoVezes.fixo;
  const transbordos = r.transbordos ?? 0;
  const pior = [...horas].sort((a, b) => (b.transbordos ?? 0) - (a.transbordos ?? 0))[0];
  const motivo = Object.entries(r.transbordosPorMotivo ?? {}).sort((a, b) => b[1] - a[1])[0];
  const notaTransbordos = !transbordos ? 'nenhum hoje'
    : pior && (pior.transbordos ?? 0) > 1 ? `${pior.transbordos} às ${pior.hora}h${motivo ? ` · mais ${motivo[0]}` : ''}`
      : motivo ? `mais ${motivo[0]}` : undefined;

  return (
    <Cartao titulo="Relatório do dia" extra={<span>hoje, hora a hora</span>} className="mb-5">
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Numero rotulo="Transbordos" dica={DICAS.transbordos} valor={r.transbordos ?? '–'} destaque={transbordos ? 'perigo' : undefined} nota={notaTransbordos} />
        <Numero rotulo="TOR" dica={DICAS.tor} valor={minutos(r.ociosoSemRobosMin)} destaque={r.ociosoSemRobosMin >= 15 ? 'alerta' : undefined}
          nota="ocioso sem robô" />
        <Numero rotulo="TME" dica={DICAS.tme} valor={duracao(r.esperaPorDerivacaoSeg)} nota={`${r.derivacoes} lead(s) atendido(s) · ${minutos(r.livresMin)} livres`} />
        <Numero rotulo="TPA" dica={DICAS.tpa} valor={minutos(panicoTotal)} nota={`pânico ativo · ${vezes} vez(es)`} />
        <div className="col-span-2 md:col-span-1"><StatusDoDia r={r} atual={statusAtual} /></div>
      </div>
      <BarraTermometro r={r} />
      {horas.length ? (
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead><tr>
              <th>Hora</th>
              <th className="text-right"><abbr title={DICAS.leads} className="cursor-help no-underline">Leads Atend.</abbr></th>
              <th className="text-right"><abbr title={DICAS.tme} className="cursor-help no-underline">TME</abbr></th>
              <th className="text-right"><abbr title={DICAS.tor} className="cursor-help no-underline">TOR</abbr></th>
              <th className="text-right"><abbr title={DICAS.tpa} className="cursor-help no-underline">TPA</abbr></th>
              <th className="text-right">Calma</th>
              <th className="text-right"><abbr title={DICAS.transbordos} className="cursor-help no-underline">Transbordos</abbr></th>
            </tr></thead>
            <tbody>{horas.map((x) => {
              const tb = x.transbordos ?? 0;
              const maisOciosa = piorOcioso >= 5 && x.ociosoSemRobosMin === piorOcioso;
              return (
                <tr key={x.hora} className={clsx(maisOciosa && 'bg-amarelo-100/60 dark:bg-amber-950/30')}>
                  <td className="numero whitespace-nowrap font-semibold">{x.hora}h{maisOciosa && <span className="ml-2 rounded-md bg-amarelo-500 px-1.5 py-0.5 text-[11px] font-bold text-marinho-950">mais ociosa</span>}</td>
                  <td className="numero text-right">{x.derivacoes}</td>
                  <td className="numero text-right">{duracao(x.esperaPorDerivacaoSeg)}</td>
                  <td className="numero text-right">{minutos(x.ociosoSemRobosMin)}</td>
                  <td className="numero text-right">{minutos(x.panicoMin)}</td>
                  <td className="numero text-right">{minutos(x.calmaMin)}</td>
                  <td className={clsx('numero text-right', tb && 'font-bold text-red-700 dark:text-red-400')}>{tb}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : <Vazio>Nada medido ainda hoje.</Vazio>}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        <b>TOR</b>: Tempo Ocioso sem Robô · <b>TME</b>: Tempo Médio de Espera · <b>TPA</b>: Tempo de Pânico Ativo · <b>Transbordos</b>: os callbacks ("Gerou Callback" da Argus).
      </p>
    </Cartao>
  );
}
