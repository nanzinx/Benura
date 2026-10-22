/**
 * [NOVO] Animação FLIP: quando a ordem de uma lista muda, cada item desliza da posição
 * antiga para a nova em vez de "pular". Os itens levam `data-flip="<id único>"`.
 * Mede pelo offsetTop (rolar a página não conta como mudança) e respeita o
 * "reduzir movimento" do sistema.
 */

import { useLayoutEffect, useRef } from 'react';

export function useFlip<T extends HTMLElement>(ordem: string[]) {
  const container = useRef<T>(null);
  const anteriores = useRef(new Map<string, number>());
  const chave = ordem.join('|');

  useLayoutEffect(() => {
    const el = container.current;
    if (!el) return;
    const reduzir = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const novas = new Map<string, number>();
    el.querySelectorAll<HTMLElement>('[data-flip]').forEach((item) => {
      const id = item.dataset.flip!;
      const topo = item.offsetTop;
      novas.set(id, topo);
      const antes = anteriores.current.get(id);
      const delta = antes == null ? 0 : antes - topo;
      if (!reduzir && Math.abs(delta) > 1 && typeof item.animate === 'function') {
        item.animate([{ transform: `translateY(${delta}px)` }, { transform: 'translateY(0)' }], { duration: 350, easing: 'cubic-bezier(.2,.8,.2,1)' });
      }
    });
    anteriores.current = novas;
  }, [chave]);

  return container;
}
