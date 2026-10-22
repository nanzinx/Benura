import { clsx } from 'clsx';
import type { EstadoTermometro, Termometro } from '../tipos';
import type { Tom } from '../ui/base';

export const ESTADOS_TERMOMETRO: Record<EstadoTermometro, { texto: string; tom: Tom; explicacao: string }> = {
  medindo: { texto: 'medindo', tom: 'neutro', explicacao: 'Ainda sem tempo suficiente com robô ligado para dizer como a URA está.' },
  agressiva: { texto: 'agressiva', tom: 'perigo', explicacao: 'Derivação chegando rápido (ou callback há pouco): a regra do fixo vale inteira.' },
  normal: { texto: 'normal', tom: 'info', explicacao: 'Ritmo normal: com 1 fixo livre, o BenURA reduz os robôs à metade, aos poucos.' },
  calma: { texto: 'calma', tom: 'ok', explicacao: 'Pouca derivação para quem está livre: com a passiva automática, os robôs seguem com 1 fixo livre.' },
};

const decimal = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 1 });

/** Texto da medida: "4,2 min livres por derivação". */
export function medidaDoTermometro(t: Termometro): string {
  if (t.callbacks) return `callback nos últimos ${t.janelaMin} min`;
  if (t.minutosPorDerivacao === -1) return `nenhuma derivação em ${t.janelaMin} min com gente livre`;
  if (t.minutosPorDerivacao == null) return 'sem medida ainda';
  return `${decimal(t.minutosPorDerivacao)} min livres por derivação`;
}

/** Larguras fixas das faixas na barra (a escala é linear dentro de cada uma). */
const LARGURA = { agressiva: 25, normal: 35, calma: 40 };

/**
 * Barra em três faixas (agressiva | normal | calma) com o ponteiro na medida
 * atual. A faixa da calma vai até o dobro do limite dela.
 */
export function MedidorTermometro({ t }: { t: Termometro }) {
  const maximo = t.calmaMin * 2;
  const limiteAgressiva = t.agressivaSeg / 60;
  const agressiva = LARGURA.agressiva;
  const calma = LARGURA.agressiva + LARGURA.normal;
  const valor = t.callbacks ? 0 : t.minutosPorDerivacao === -1 ? maximo : t.minutosPorDerivacao;
  const escala = (v: number) => (v <= limiteAgressiva ? (v / limiteAgressiva) * agressiva
    : v <= t.calmaMin ? agressiva + ((v - limiteAgressiva) / (t.calmaMin - limiteAgressiva)) * LARGURA.normal
      : calma + ((Math.min(v, maximo) - t.calmaMin) / (maximo - t.calmaMin)) * LARGURA.calma);
  const posicao = valor == null || t.estado === 'medindo' ? null : Math.min(98.5, Math.max(1.5, escala(valor)));
  const faixa = (de: number, ate: number, cor: string, ativo: boolean, texto: string) => (
    <div className={clsx('relative flex items-end justify-start overflow-hidden whitespace-nowrap px-2 pb-1 text-[11px] font-semibold transition-opacity', cor, !ativo && 'opacity-45')}
      style={{ width: `${ate - de}%` }}>{texto}</div>
  );
  return (
    <div className="grid gap-1.5" role="img" aria-label={`Termômetro da URA: ${ESTADOS_TERMOMETRO[t.estado].texto}, ${medidaDoTermometro(t)}`}>
      <div className="relative">
        <div className="flex h-9 overflow-hidden rounded-lg text-white">
          {faixa(0, agressiva, 'bg-red-600 dark:bg-red-700', t.estado === 'agressiva', 'agressiva')}
          {faixa(agressiva, calma, 'bg-azul-600 dark:bg-azul-500', t.estado === 'normal', 'normal')}
          {faixa(calma, 100, 'bg-emerald-600 dark:bg-emerald-700', t.estado === 'calma', 'calma')}
        </div>
        {posicao != null && (
          <span className="absolute -top-1.5 -bottom-1.5 w-1 -translate-x-1/2 rounded-full bg-marinho-950 ring-2 ring-white dark:bg-white dark:ring-noite-900"
            style={{ left: `${posicao}%` }} aria-hidden />
        )}
      </div>
      <div className="relative h-4 text-[11px] text-slate-500 tabular-nums dark:text-slate-400">
        <span className="absolute left-0">0</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${agressiva}%` }}>{t.agressivaSeg} s</span>
        <span className="absolute -translate-x-1/2" style={{ left: `${calma}%` }}>{decimal(t.calmaMin)} min</span>
        <span className="absolute right-0">{decimal(maximo)}+ min</span>
      </div>
    </div>
  );
}
