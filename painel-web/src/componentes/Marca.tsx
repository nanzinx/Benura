import { clsx } from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';

/** De quanto em quanto tempo a logo do topo faz o equalizador sozinha. */
const A_CADA_MS = 45_000;
const PRIMEIRA_MS = 6_000;
/** Quantos ciclos na vez periódica (com o mouse em cima, segue sem parar). */
const CICLOS_DA_VEZ = 2;

/**
 * [NOVO] O movimento de cada barra: sobe e desce em torno do tamanho normal e volta exatamente a ele,
 * então um ciclo emenda no outro sem costura. Cada barra tem o seu ritmo (duração e atraso
 * diferentes), para parecer um equalizador de verdade e não barras em sincronia.
 */
const BARRAS = [
  { quadros: [1, 0.45, 1.15, 0.7, 1], ms: 620, atraso: 0 },
  { quadros: [1, 1.12, 0.5, 0.95, 1], ms: 710, atraso: 60 },
  { quadros: [1, 0.55, 1.1, 0.6, 1], ms: 550, atraso: 120 },
  { quadros: [1, 1.1, 0.42, 0.85, 1], ms: 800, atraso: 30 },
  { quadros: [1, 0.5, 1.2, 0.75, 1], ms: 660, atraso: 90 },
] as const;

const semAnimacao = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * [NOVO] O equalizador da logo, pela Web Animations API (dá para terminar cada barra no fim do ciclo,
 * sem pulo): com o mouse em cima, em loop; ao sair, cada barra termina o ciclo em que está e para no
 * tamanho normal. De tempos em tempos (guia visível), dois ciclos sozinha. Com "reduzir movimento"
 * no sistema, não anima.
 */
function useEqualizador(ligado: boolean) {
  const barras = useRef<(SVGRectElement | null)[]>([]);
  const animacoes = useRef<Animation[]>([]);
  const [emCima, setEmCima] = useState(false);

  const tocando = () => animacoes.current.some((a) => a.playState === 'running');

  /** Começa (ou continua, se já está tocando) com `ciclos` ciclos; Infinity = enquanto o mouse estiver em cima. */
  const tocar = useCallback((ciclos: number) => {
    if (!ligado || semAnimacao()) return;
    if (tocando()) {
      for (const a of animacoes.current) a.effect?.updateTiming({ iterations: ciclos === Infinity ? Infinity : cicloAtual(a) + ciclos });
      return;
    }
    animacoes.current = barras.current.flatMap((el, i) => {
      const b = BARRAS[i];
      if (!el || !b || typeof el.animate !== 'function') return [];
      return [el.animate(b.quadros.map((s) => ({ transform: `scaleY(${s})` })), {
        duration: b.ms, delay: b.atraso, iterations: ciclos, easing: 'ease-in-out',
      })];
    });
  }, [ligado]);

  /** O mouse saiu: cada barra termina o ciclo em que está e para no tamanho normal. */
  const assentar = useCallback(() => {
    for (const a of animacoes.current) {
      if (a.playState === 'running') a.effect?.updateTiming({ iterations: cicloAtual(a) + 1 });
    }
  }, []);

  useEffect(() => {
    if (!ligado) return undefined;
    const vez = () => { if (document.visibilityState === 'visible' && !tocando()) tocar(CICLOS_DA_VEZ); };
    const primeira = setTimeout(vez, PRIMEIRA_MS);
    const repetir = setInterval(vez, A_CADA_MS);
    return () => { clearTimeout(primeira); clearInterval(repetir); for (const a of animacoes.current) a.cancel(); };
  }, [ligado, tocar]);

  return {
    barras,
    emCima,
    entrar: () => { setEmCima(true); tocar(Infinity); },
    sair: () => { setEmCima(false); assentar(); },
  };
}

/** O ciclo em que a animação está agora (0, 1, 2…), contando o atraso inicial como o ciclo 0. */
function cicloAtual(a: Animation): number {
  return Math.max(0, Math.floor(a.effect?.getComputedTiming().currentIteration ?? 0));
}

export function Marca({ tamanho = 'normal', animada = false }: { tamanho?: 'normal' | 'grande'; animada?: boolean }) {
  const grande = tamanho === 'grande';
  const { barras, emCima, entrar, sair } = useEqualizador(animada);
  const barra = (i: number) => (el: SVGRectElement | null) => { barras.current[i] = el; };
  const estilo = { transformBox: 'fill-box', transformOrigin: 'center' } as const;
  return (
    <span onMouseEnter={animada ? entrar : undefined} onMouseLeave={animada ? sair : undefined}
      className={clsx('inline-flex items-center font-bold tracking-tight text-white', grande ? 'gap-3.5 text-4xl' : 'gap-2.5 text-xl')}>
      <svg viewBox="0 0 64 64" aria-hidden
        className={clsx('flex-none transition-[filter,transform] duration-300', grande ? 'size-14 rounded-2xl' : 'size-8 rounded-lg',
          emCima && 'scale-105 drop-shadow-[0_0_6px_rgba(245,184,0,0.55)]')}>
        <rect width="64" height="64" rx="14" fill="#0A2350" />
        <rect ref={barra(0)} style={estilo} x="12" y="26" width="6" height="12" rx="3" fill="#FFFFFF" />
        <rect ref={barra(1)} style={estilo} x="22" y="16" width="6" height="32" rx="3" fill="#F5B800" />
        <rect ref={barra(2)} style={estilo} x="32" y="21" width="6" height="22" rx="3" fill="#FFFFFF" />
        <rect ref={barra(3)} style={estilo} x="42" y="12" width="6" height="40" rx="3" fill="#F5B800" />
        <rect ref={barra(4)} style={estilo} x="52" y="27" width="4" height="10" rx="2" fill="#FFFFFF" opacity=".6" />
      </svg>
      <span>Ben<span className="font-extrabold text-amarelo-500">URA</span></span>
    </span>
  );
}
