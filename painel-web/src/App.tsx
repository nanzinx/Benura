import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState, useSyncExternalStore } from 'react';
import { api } from './api';
import { AoVivo } from './dados';
import { Entrada } from './componentes/Entrada';
import { Faixas } from './componentes/Faixas';
import { Topo, type Aba, ABAS } from './componentes/Topo';
import { Visao } from './abas/Visao';
import { Ura } from './abas/Ura';
import { Receptivo } from './abas/Receptivo';
import { Esteira } from './abas/Esteira';
import { Servicos } from './abas/Servicos';
import { useTema } from './tema';

// Estado da sessão fora do React: o QueryCache avisa quando um pedido volta 401.
type Sessao = 'verificando' | 'fora' | 'dentro';
let sessao: Sessao = 'verificando';
const ouvintes = new Set<() => void>();
const definirSessao = (s: Sessao) => { sessao = s; ouvintes.forEach((o) => o()); };
export const sessaoAcabou = () => definirSessao('fora');
const useSessao = () => useSyncExternalStore((o) => { ouvintes.add(o); return () => ouvintes.delete(o); }, () => sessao);

const abaDoEndereco = (): Aba => {
  const a = location.hash.slice(1) as Aba;
  return ABAS.some((x) => x.id === a) ? a : 'visao';
};

export function App() {
  const estado = useSessao();
  const cliente = useQueryClient();
  const [tema, escuro, trocarTema] = useTema();
  const [aba, setAba] = useState<Aba>(abaDoEndereco);
  const [aoVivo, setAoVivo] = useState(true);

  useEffect(() => {
    api.sessao().then(() => definirSessao('dentro'), () => definirSessao('fora'));
  }, []);

  useEffect(() => {
    const ouvir = () => setAba(abaDoEndereco());
    window.addEventListener('hashchange', ouvir);
    return () => window.removeEventListener('hashchange', ouvir);
  }, []);

  // Atalhos: 1–5 trocam de aba; P pausa ou retoma as atualizações.
  useEffect(() => {
    const ouvir = (e: KeyboardEvent) => {
      const alvo = e.target as HTMLElement;
      if (estado !== 'dentro' || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(alvo.tagName) || document.querySelector('dialog[open]')) return;
      const n = Number(e.key);
      if (n >= 1 && n <= ABAS.length) location.hash = ABAS[n - 1]!.id;
      if (e.key.toLowerCase() === 'p') setAoVivo((v) => !v);
    };
    window.addEventListener('keydown', ouvir);
    return () => window.removeEventListener('keydown', ouvir);
  }, [estado]);

  if (estado === 'verificando') return <div className="grid min-h-screen place-items-center text-slate-500">Carregando…</div>;
  if (estado === 'fora') return <Entrada aoEntrar={() => { cliente.clear(); definirSessao('dentro'); }} />;

  const sair = async () => {
    await api.sair().catch(() => undefined);
    cliente.clear();
    definirSessao('fora');
  };

  return (
    <AoVivo.Provider value={aoVivo}>
      <div className="min-h-screen">
        <Topo aba={aba} tema={tema} escuro={escuro} trocarTema={trocarTema} aoVivo={aoVivo} alternarAoVivo={() => setAoVivo((v) => !v)} sair={sair} />
        <Faixas />
        <main className="mx-auto max-w-7xl px-4 pt-6 pb-10 sm:px-6">
          {aba === 'visao' && <Visao escuro={escuro} />}
          {aba === 'receptivo' && <Receptivo />}
          {aba === 'ura' && <Ura />}
          {aba === 'esteira' && <Esteira />}
          {aba === 'servicos' && <Servicos />}
        </main>
        <footer className="pb-8 text-center text-xs text-slate-500 dark:text-slate-400">
          BenURA · Benconsig · atalhos: <kbd className="font-sans">1</kbd>–<kbd className="font-sans">5</kbd> trocam de aba, <kbd className="font-sans">P</kbd> pausa
        </footer>
      </div>
    </AoVivo.Provider>
  );
}
