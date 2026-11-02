/**
 * [NOVO] Tendência do relatório de 7 e 30 dias: um indicador por vez (OPL, transbordos, TME ou leads),
 * dia a dia, atrás de um botão (fechado não ocupa a tela). Uma série só: sem legenda, sem dois eixos;
 * a linha verde marca o fim da faixa verde do indicador. Os números também estão na tabela logo abaixo.
 */

import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { useSyncExternalStore } from 'react';
import { duracao } from '../formatos';
import { limiteVerde, serieDaTendencia, type CampoDaTendencia } from '../relatorio';
import { coresDaTendencia } from '../tema';
import type { DiaDoPeriodo } from '../tipos';
import { Segmentado } from '../ui/base';

/** O tema escuro é a classe "dark" no <html> (tema.ts): acompanha a troca sem precisar da prop. */
function useEscuro() {
  return useSyncExternalStore((avisar) => {
    const o = new MutationObserver(avisar);
    o.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => o.disconnect();
  }, () => document.documentElement.classList.contains('dark'));
}

/** No eixo, curto (não quebra a linha): 45 s, 4,5 min. */
const eixoDeSegundos = (v: number) => (v < 60 ? `${Math.round(v)} s` : `${String(Math.round((v / 60) * 10) / 10).replace('.', ',')} min`);

const INDICADORES: { valor: CampoDaTendencia; texto: string; formatar: (v: number) => string; eixo: (v: number) => string }[] = [
  { valor: 'oplSeg', texto: 'OPL', formatar: (v) => duracao(v), eixo: eixoDeSegundos },
  { valor: 'transbordos', texto: 'Transbordos', formatar: (v) => String(v), eixo: (v) => String(v) },
  { valor: 'tmeSeg', texto: 'TME', formatar: (v) => duracao(v), eixo: eixoDeSegundos },
  { valor: 'leadsDerivados', texto: 'Leads', formatar: (v) => String(v), eixo: (v) => String(v) },
];

export function GraficoTendencia({ dias, campo, aoMudar }: { dias: DiaDoPeriodo[]; campo: CampoDaTendencia; aoMudar: (c: CampoDaTendencia) => void }) {
  const escuro = useEscuro();
  const cores = coresDaTendencia(escuro);
  const indicador = INDICADORES.find((i) => i.valor === campo) ?? INDICADORES[0]!;
  const serie = serieDaTendencia(dias, campo);
  const verde = limiteVerde(campo);
  const comValor = serie.filter((p) => p.valor != null);
  const ultimo = comValor.at(-1);
  const resumo = comValor.length
    ? `${indicador.texto} por dia: de ${indicador.formatar(Math.min(...comValor.map((p) => p.valor!)))} a ${indicador.formatar(Math.max(...comValor.map((p) => p.valor!)))}`
      + `${ultimo ? `; ${ultimo.rotulo}${ultimo.hoje ? ' (hoje, parcial)' : ''}: ${indicador.formatar(ultimo.valor!)}` : ''}`
    : `${indicador.texto}: sem dados no período`;

  const Dica = ({ active, payload }: { active?: boolean; payload?: { payload: (typeof serie)[number] }[] }) => {
    const p = active ? payload?.[0]?.payload : null;
    if (!p) return null;
    return (
      <div className="rounded-lg bg-marinho-950 px-3 py-2 text-sm text-white shadow-xl">
        <p><b className="tabular-nums">{p.valor == null ? '–' : indicador.formatar(p.valor)}</b> {indicador.texto}</p>
        <p className="text-xs text-slate-300">{p.rotulo}{p.hoje ? ' · hoje, ainda parcial' : ''}</p>
      </div>
    );
  };

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Segmentado rotulo="Indicador da tendência" opcoes={INDICADORES.map(({ valor, texto }) => ({ valor, texto }))} valor={campo} aoMudar={aoMudar} />
        {verde != null && (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
            <span className="h-0.5 w-4 rounded-full" style={{ background: cores.referencia }} aria-hidden />
            verde até {indicador.formatar(verde)}
          </span>
        )}
      </div>
      <div role="img" aria-label={resumo}>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={serie} margin={{ top: 10, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid vertical={false} stroke={cores.grade} />
            <XAxis dataKey="rotulo" tick={{ fontSize: 11, fill: cores.eixo }} tickLine={false} axisLine={false} interval="preserveStartEnd" minTickGap={16} />
            <YAxis tick={{ fontSize: 11, fill: cores.eixo }} tickLine={false} axisLine={false} width={campo.endsWith('Seg') ? 56 : 36}
              allowDecimals={false} tickFormatter={(v: number) => indicador.eixo(v)} domain={[0, 'auto']} />
            <Tooltip content={(p) => <Dica active={p.active} payload={p.payload as never} />} cursor={{ stroke: cores.cursor, strokeWidth: 1 }} isAnimationActive={false} />
            {verde != null && verde > 0 && <ReferenceLine y={verde} stroke={cores.referencia} strokeWidth={1.5} />}
            <Line type="monotone" dataKey="valor" stroke={cores.serie} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" connectNulls isAnimationActive={false}
              dot={{ r: 4, strokeWidth: 2, stroke: cores.anel, fill: cores.serie }} activeDot={{ r: 5, strokeWidth: 2, stroke: cores.anel, fill: cores.serie }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <p className="text-xs text-slate-500 dark:text-slate-400">{resumo}. Passe o mouse (ou toque) num dia para ver o número.</p>
    </div>
  );
}
