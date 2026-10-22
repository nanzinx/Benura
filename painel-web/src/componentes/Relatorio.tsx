import { clsx } from 'clsx';
import type { ReactNode } from 'react';
import { duracao, minutos } from '../formatos';
import type { Callback, EstadoTermometro, RelatorioDoDia } from '../tipos';
import { Cartao, Vazio } from '../ui/base';

const CORES_TERMOMETRO: Record<EstadoTermometro, string> = {
  agressiva: 'bg-red-600 dark:bg-red-700',
  normal: 'bg-azul-600 dark:bg-azul-500',
  calma: 'bg-emerald-600 dark:bg-emerald-700',
  medindo: 'bg-slate-300 dark:bg-noite-600',
};

function Numero({ rotulo, valor, nota, destaque }: { rotulo: string; valor: ReactNode; nota?: ReactNode; destaque?: 'perigo' | 'alerta' }) {
  return (
    <div className={clsx('grid content-start rounded-lg px-3 py-2.5', destaque === 'perigo' ? 'bg-red-50 dark:bg-red-950/50' : destaque === 'alerta' ? 'bg-amarelo-100 dark:bg-amber-950/50' : 'bg-azul-50 dark:bg-noite-800')}>
      <span className="rotulo">{rotulo}</span>
      <b className={clsx('text-xl tabular-nums', destaque === 'perigo' && 'text-red-700 dark:text-red-300', destaque === 'alerta' && 'text-amber-900 dark:text-amber-100')}>{valor}</b>
      {nota && <span className="text-xs text-slate-500 dark:text-slate-400">{nota}</span>}
    </div>
  );
}

/** Quanto do dia (com robô ligado) a URA passou calma, normal ou agressiva. */
function BarraTermometro({ r }: { r: RelatorioDoDia }) {
  const ordem: EstadoTermometro[] = ['agressiva', 'normal', 'calma', 'medindo'];
  const total = ordem.reduce((s, e) => s + (r.termometroMin[e] ?? 0), 0);
  if (!total) return null;
  return (
    <div className="mb-4 grid gap-1.5">
      <div className="flex h-3 overflow-hidden rounded-full" role="img"
        aria-label={`Termômetro no dia: ${ordem.map((e) => `${e} ${minutos(r.termometroMin[e])}`).join(', ')}`}>
        {ordem.map((e) => r.termometroMin[e] > 0 && <span key={e} className={CORES_TERMOMETRO[e]} style={{ width: `${(r.termometroMin[e] / total) * 100}%` }} />)}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-600 dark:text-slate-300">
        {ordem.map((e) => (
          <span key={e} className="inline-flex items-center gap-1.5"><span className={clsx('size-2.5 rounded-sm', CORES_TERMOMETRO[e])} aria-hidden />{e} {minutos(r.termometroMin[e])}</span>
        ))}
      </div>
    </div>
  );
}

/** Relatório do dia: callbacks, ociosidade com os robôs desligados, pânico e termômetro, por hora. */
export function Relatorio({ r, callbacks }: { r: RelatorioDoDia | null | undefined; callbacks: Callback[] | undefined }) {
  if (!r) {
    return <Cartao titulo="Relatório do dia" className="mb-5"><Vazio>O relatório aparece quando o rodízio estiver rodando.</Vazio></Cartao>;
  }
  const porHora = new Map<string, number>();
  for (const c of callbacks ?? []) porHora.set(c.hora.slice(0, 2), (porHora.get(c.hora.slice(0, 2)) ?? 0) + 1);
  const horas = [...new Set([...r.horas.map((h) => h.hora), ...porHora.keys()])].sort();
  const linha = (h: string) => r.horas.find((x) => x.hora === h);
  const piorOcioso = Math.max(0, ...r.horas.map((h) => h.ociosoSemRobosMin));
  const panicoTotal = r.panicoMin.zero + r.panicoMin.saindo + r.panicoMin.fixo;
  const vezes = r.panicoVezes.zero + r.panicoVezes.saindo + r.panicoVezes.fixo;
  const nCallbacks = callbacks?.length ?? 0;
  const [horaPior, nPior] = [...porHora.entries()].sort((a, b) => b[1] - a[1])[0] ?? ['', 0];
  const notaCallbacks = !nCallbacks ? 'nenhum hoje' : nPior > 1 ? `${nPior} às ${horaPior}h` : `último às ${callbacks![nCallbacks - 1]!.hora.slice(0, 5)}`;

  return (
    <Cartao titulo="Relatório do dia" extra={<span>hoje, hora a hora</span>} className="mb-5">
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Numero rotulo="Callbacks" valor={callbacks ? nCallbacks : '–'} destaque={nCallbacks ? 'perigo' : undefined}
          nota={notaCallbacks} />
        <Numero rotulo="Ocioso sem robô" valor={minutos(r.ociosoSemRobosMin)} destaque={r.ociosoSemRobosMin >= 15 ? 'alerta' : undefined}
          nota="gente livre e nenhum robô ligado" />
        <Numero rotulo="Livre por atendimento" valor={duracao(r.esperaPorDerivacaoSeg)} nota={`${r.derivacoes} derivação(ões) · ${minutos(r.livresMin)} livres`} />
        <Numero rotulo="Tempo em pânico" valor={minutos(panicoTotal)} nota={`${vezes} vez(es) · fixo ${minutos(r.panicoMin.fixo)} · 0 livre ${minutos(r.panicoMin.zero)}`} />
        <div className="col-span-2 md:col-span-1">
          <Numero rotulo="URA calma" valor={minutos(r.termometroMin.calma)} nota={`agressiva ${minutos(r.termometroMin.agressiva)} · normal ${minutos(r.termometroMin.normal)}`} />
        </div>
      </div>
      <BarraTermometro r={r} />
      {horas.length ? (
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead><tr>
              <th>Hora</th><th className="text-right">Derivações</th><th className="text-right">Livre por atendimento</th>
              <th className="text-right">Ocioso sem robô</th><th className="text-right">Pânico</th><th className="text-right">Calma</th><th className="text-right">Callbacks</th>
            </tr></thead>
            <tbody>{horas.map((h) => {
              const x = linha(h);
              const cb = porHora.get(h) ?? 0;
              const pior = x && piorOcioso >= 5 && x.ociosoSemRobosMin === piorOcioso;
              return (
                <tr key={h} className={clsx(pior && 'bg-amarelo-100/60 dark:bg-amber-950/30')}>
                  <td className="numero whitespace-nowrap font-semibold">{h}h{pior && <span className="ml-2 rounded-md bg-amarelo-500 px-1.5 py-0.5 text-[11px] font-bold text-marinho-950">mais ociosa</span>}</td>
                  <td className="numero text-right">{x?.derivacoes ?? '–'}</td>
                  <td className="numero text-right">{duracao(x?.esperaPorDerivacaoSeg)}</td>
                  <td className="numero text-right">{x ? minutos(x.ociosoSemRobosMin) : '–'}</td>
                  <td className="numero text-right">{x ? minutos(x.panicoMin) : '–'}</td>
                  <td className="numero text-right">{x ? minutos(x.calmaMin) : '–'}</td>
                  <td className={clsx('numero text-right', cb && 'font-bold text-red-700 dark:text-red-400')}>{cb}</td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : <Vazio>Nada medido ainda hoje.</Vazio>}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        "Livre por atendimento": minutos de gente livre na URA para cada derivação. "Ocioso sem robô": tempo com alguém livre e todos os robôs desligados (o que o pânico custa).
      </p>
    </Cartao>
  );
}
