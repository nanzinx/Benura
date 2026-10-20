import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { horaDeSegundos } from '../formatos';
import { coresDoGrafico } from '../tema';
import { Vazio } from '../ui/base';

export interface Marca { t: number; texto: string }

interface Props {
  serie: { t: number; y: number }[];
  rotulo: string;
  marcas?: Marca[];
  altura?: number;
  escuro: boolean;
}

/** Callbacks a até 2 minutos do ponto apontado aparecem na dica. */
const PERTO_SEG = 120;

/** Linha em degraus (o valor vale até a próxima mudança), com dica ao passar o mouse. */
export function GraficoDegraus({ serie, rotulo, marcas = [], altura = 240, escuro }: Props) {
  const cores = coresDoGrafico(escuro);
  if (!serie.length) return <div style={{ height: altura }} className="grid"><Vazio>Sem dados neste período.</Vazio></div>;
  const inicio = serie[0]!.t;
  const fim = serie[serie.length - 1]!.t;
  const visiveis = marcas.filter((m) => m.t >= inicio && m.t <= fim);
  const maximo = Math.max(2, ...serie.map((p) => p.y));
  // Marcas do eixo em horas cheias (de 1 em 1 h até 6 h de janela; depois, de 2 em 2 h).
  const passo = fim - inicio > 6 * 3600 ? 7200 : fim - inicio > 2 * 3600 ? 3600 : 1800;
  const marcasDoEixo: number[] = [];
  for (let t = Math.ceil(inicio / passo) * passo; t <= fim; t += passo) marcasDoEixo.push(t);

  const Dica = ({ active, label }: { active?: boolean; label?: string | number }) => {
    if (!active || label == null) return null;
    const t = Number(label);
    const ponto = serie.filter((p) => p.t <= t).pop() ?? serie[0]!;
    const perto = visiveis.filter((m) => Math.abs(m.t - t) <= PERTO_SEG);
    return (
      <div className="max-w-72 rounded-lg bg-marinho-950 px-3 py-2 text-sm text-white shadow-xl">
        <p><b className="text-amarelo-400 tabular-nums">{horaDeSegundos(t)}</b> · {ponto.y} {rotulo}</p>
        {perto.map((m) => <p key={m.t + m.texto} className="text-red-200">Callback {m.texto}</p>)}
      </div>
    );
  };

  return (
    <div role="img" aria-label={`${rotulo}: agora ${serie[serie.length - 1]!.y}, máximo ${maximo} no período`}>
      <ResponsiveContainer width="100%" height={altura}>
        <AreaChart data={serie} margin={{ top: 8, right: 8, bottom: 0, left: -8 }}>
          <CartesianGrid vertical={false} stroke={cores.grade} />
          <XAxis dataKey="t" type="number" domain={[inicio, fim]} tickFormatter={horaDeSegundos} tick={{ fontSize: 11, fill: cores.eixo }}
            tickLine={false} axisLine={false} ticks={marcasDoEixo} interval="preserveStartEnd" scale="linear" />
          <YAxis allowDecimals={false} domain={[0, maximo]} tick={{ fontSize: 11, fill: cores.eixo }} tickLine={false} axisLine={false} width={36} />
          <Tooltip content={(p) => <Dica active={p.active} label={p.label} />} cursor={{ stroke: cores.cursor, strokeDasharray: '3 3' }} isAnimationActive={false} />
          {visiveis.map((m) => <ReferenceLine key={`${m.t}-${m.texto}`} x={m.t} stroke={cores.callback} strokeWidth={1.5} strokeOpacity={0.75} />)}
          <Area type="stepAfter" dataKey="y" stroke={cores.serie} strokeWidth={2} fill={cores.area} isAnimationActive={false}
            dot={false} activeDot={{ r: 4, strokeWidth: 2, stroke: escuro ? '#111c33' : '#ffffff', fill: cores.serie }} />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
