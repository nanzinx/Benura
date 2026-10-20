/** Tema claro, escuro ou o do sistema; a escolha fica no navegador. */

import { useEffect, useState } from 'react';

export type Tema = 'sistema' | 'claro' | 'escuro';
const CHAVE = 'benura-tema';

function lerTema(): Tema {
  try {
    const t = localStorage.getItem(CHAVE);
    return t === 'claro' || t === 'escuro' ? t : 'sistema';
  } catch {
    return 'sistema';
  }
}

const sistemaEscuro = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

/** @returns [tema escolhido, se está escuro agora, trocar] */
export function useTema(): [Tema, boolean, (t: Tema) => void] {
  const [tema, setTema] = useState<Tema>(lerTema);
  const [escuroDoSistema, setEscuroDoSistema] = useState(sistemaEscuro);

  useEffect(() => {
    const m = window.matchMedia('(prefers-color-scheme: dark)');
    const ouvir = () => setEscuroDoSistema(m.matches);
    m.addEventListener('change', ouvir);
    return () => m.removeEventListener('change', ouvir);
  }, []);

  const escuro = tema === 'escuro' || (tema === 'sistema' && escuroDoSistema);
  useEffect(() => {
    document.documentElement.classList.toggle('dark', escuro);
    document.documentElement.style.colorScheme = escuro ? 'dark' : 'light';
  }, [escuro]);

  const trocar = (t: Tema) => {
    setTema(t);
    try {
      localStorage.setItem(CHAVE, t);
    } catch {
      /* navegador sem armazenamento: vale só nesta aba */
    }
  };
  return [tema, escuro, trocar];
}

/** Cores dos gráficos (o SVG do Recharts recebe a cor pronta). */
export const coresDoGrafico = (escuro: boolean) => (escuro
  ? { serie: '#6b9af3', area: 'rgba(107,154,243,0.16)', grade: '#1c2a46', eixo: '#8592a9', callback: '#ff6b61', cursor: '#8592a9' }
  : { serie: '#1a4fb8', area: 'rgba(26,79,184,0.10)', grade: '#e8edf4', eixo: '#6b778a', callback: '#c62828', cursor: '#94a3b8' });
