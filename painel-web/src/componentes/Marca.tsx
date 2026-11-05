import { clsx } from 'clsx';
import { useCallback, useEffect, useRef, useState } from 'react';

/** [NOVO] De quanto em quanto tempo a logo do topo faz o equalizador (e quanto dura cada vez). */
const A_CADA_MS = 45_000;
const PRIMEIRA_MS = 6_000;
const DURA_MS = 1_600;

const semAnimacao = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

/**
 * [NOVO] O equalizador da logo de tempos em tempos (e ao passar o mouse), como na entrada depois do
 * login. Só com a guia visível; com "reduzir movimento" no sistema, não anima.
 */
function useEqualizador(ligado: boolean) {
  const [tocando, setTocando] = useState(false);
  const fim = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const tocar = useCallback(() => {
    if (!ligado || semAnimacao() || document.visibilityState !== 'visible') return;
    setTocando(false);
    requestAnimationFrame(() => setTocando(true)); // recomeça se já estava tocando
    clearTimeout(fim.current);
    fim.current = setTimeout(() => setTocando(false), DURA_MS);
  }, [ligado]);
  useEffect(() => {
    if (!ligado) return undefined;
    const primeira = setTimeout(tocar, PRIMEIRA_MS);
    const vez = setInterval(tocar, A_CADA_MS);
    return () => { clearTimeout(primeira); clearInterval(vez); clearTimeout(fim.current); };
  }, [ligado, tocar]);
  return { tocando, tocar };
}

export function Marca({ tamanho = 'normal', animada = false }: { tamanho?: 'normal' | 'grande'; animada?: boolean }) {
  const grande = tamanho === 'grande';
  const { tocando, tocar } = useEqualizador(animada);
  return (
    <span onMouseEnter={animada ? tocar : undefined} className={clsx('inline-flex items-center font-bold tracking-tight text-white', grande ? 'gap-3.5 text-4xl' : 'gap-2.5 text-xl')}>
      <svg viewBox="0 0 64 64" aria-hidden className={clsx('flex-none', grande ? 'size-14 rounded-2xl' : 'size-8 rounded-lg', tocando && 'logo-eq')}>
        <rect width="64" height="64" rx="14" fill="#0A2350" />
        <rect className="logo-barra" x="12" y="26" width="6" height="12" rx="3" fill="#FFFFFF" />
        <rect className="logo-barra" x="22" y="16" width="6" height="32" rx="3" fill="#F5B800" />
        <rect className="logo-barra" x="32" y="21" width="6" height="22" rx="3" fill="#FFFFFF" />
        <rect className="logo-barra" x="42" y="12" width="6" height="40" rx="3" fill="#F5B800" />
        <rect className="logo-barra" x="52" y="27" width="4" height="10" rx="2" fill="#FFFFFF" opacity=".6" />
      </svg>
      <span>Ben<span className="font-extrabold text-amarelo-500">URA</span></span>
    </span>
  );
}
