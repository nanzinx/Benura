import { useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { useEffect, useState } from 'react';
import { api } from './api';
import { AoVivo } from './dados';
import { Entrada } from './componentes/Entrada';
import { Faixas } from './componentes/Faixas';
import { Topo, type Aba, ABAS } from './componentes/Topo';
import { Visao } from './abas/Visao';
import { Relatorios } from './abas/Relatorios';
import { Ura } from './abas/Ura';
import { Receptivo } from './abas/Receptivo';
import { Esteira } from './abas/Esteira';
import { Servicos } from './abas/Servicos';
import { Ajuda } from './abas/Ajuda';
import { useTema } from './tema';
import { conferirSessao, definirSessao, useSessao } from './sessao';
import { BoasVindas } from './componentes/BoasVindas';
import { abaDoEndereco, CAMINHOS, definirTitulo, irPara, ouvirTrocaDeAba } from './rotas';
import { deveMostrarEntrada, diaDe, lerVistoEm, marcarVisto } from './boas-vindas';

const abaAtual = (): Aba => abaDoEndereco(location.pathname, location.hash);

export function App() {
  const { estado } = useSessao();
  const cliente = useQueryClient();
  const [tema, escuro, trocarTema] = useTema();
  const [aba, setAba] = useState<Aba>(abaAtual);
  const [aoVivo, setAoVivo] = useState(true);
  // [NOVO] Entrada de boas-vindas: uma vez por dia e sempre logo depois do login; depois, os cartões em cascata.
  const [acabouDeEntrar, setAcabouDeEntrar] = useState(false);
  const [entrada, setEntrada] = useState<'mostrar' | 'cascata' | 'pronto' | null>(null);
  const [entradaNaTela, setEntradaNaTela] = useState(false);
  useEffect(() => {
    if (estado !== 'dentro' || entrada) return;
    const hoje = diaDe(new Date());
    if (deveMostrarEntrada({ vistoEm: lerVistoEm(), hoje, acabouDeEntrar })) {
      marcarVisto(hoje);
      setEntrada('mostrar');
      setEntradaNaTela(true);
    } else setEntrada('pronto');
  }, [estado, entrada, acabouDeEntrar]);
  useEffect(() => {
    if (entrada !== 'cascata') return undefined;
    const id = setTimeout(() => setEntrada('pronto'), 1200);
    return () => clearTimeout(id);
  }, [entrada]);

  useEffect(() => {
    void conferirSessao();
  }, []);

  // [NOVO] Endereço sem #: um link antigo (…/#servicos) vira …/servicos, sem entrar no histórico.
  useEffect(() => {
    const inicial = abaAtual();
    definirTitulo({ aba: inicial });
    if (location.hash || location.pathname !== CAMINHOS[inicial]) history.replaceState(null, '', CAMINHOS[inicial] + location.search);
    return ouvirTrocaDeAba(() => setAba(abaAtual()));
  }, []);

  useEffect(() => {
    definirTitulo({ aba });
  }, [aba]);

  // Atalhos: 1–6 trocam de aba; P pausa ou retoma as atualizações.
  useEffect(() => {
    const ouvir = (e: KeyboardEvent) => {
      const alvo = e.target as HTMLElement;
      if (estado !== 'dentro' || e.ctrlKey || e.metaKey || e.altKey || /INPUT|TEXTAREA|SELECT/.test(alvo.tagName) || document.querySelector('dialog[open]')) return;
      const n = Number(e.key);
      if (n >= 1 && n <= ABAS.length) irPara(ABAS[n - 1]!.id);
      if (e.key.toLowerCase() === 'p') setAoVivo((v) => !v);
    };
    window.addEventListener('keydown', ouvir);
    return () => window.removeEventListener('keydown', ouvir);
  }, [estado]);

  if (estado === 'verificando') return <div className="grid min-h-screen place-items-center text-slate-500">Carregando…</div>;
  if (estado === 'fora') return <Entrada aoEntrar={() => { cliente.clear(); setAcabouDeEntrar(true); setEntrada(null); void conferirSessao(); }} />;

  const sair = async () => {
    await api.sair().catch(() => undefined);
    cliente.clear();
    setAcabouDeEntrar(false);
    definirSessao({ estado: 'fora' });
  };

  return (
    <AoVivo.Provider value={aoVivo}>
      <div className="min-h-screen">
        <Topo aba={aba} tema={tema} escuro={escuro} trocarTema={trocarTema} aoVivo={aoVivo} alternarAoVivo={() => setAoVivo((v) => !v)} sair={sair} />
        <Faixas />
        {/* A cascata começa quando o círculo abre (aoSair); a entrada sai da tela no fim (aoTerminar). */}
        {entradaNaTela && <BoasVindas aoSair={() => setEntrada('cascata')} aoTerminar={() => setEntradaNaTela(false)} />}
        <main className={clsx('mx-auto max-w-7xl px-4 pt-6 pb-10 sm:px-6', entrada === 'cascata' && 'cascata')}>
          {aba === 'visao' && <Visao escuro={escuro} />}
          {aba === 'relatorios' && <Relatorios escuro={escuro} />}
          {aba === 'receptivo' && <Receptivo />}
          {aba === 'ura' && <Ura />}
          {aba === 'esteira' && <Esteira />}
          {aba === 'servicos' && <Servicos />}
          {aba === 'ajuda' && <Ajuda />}
        </main>
        <footer className="pb-8 text-center text-xs text-slate-500 dark:text-slate-400">
          BenURA · Benconsig · atalhos: <kbd className="font-sans">1</kbd>–<kbd className="font-sans">{ABAS.length}</kbd> trocam de aba, <kbd className="font-sans">P</kbd> pausa
        </footer>
      </div>
    </AoVivo.Provider>
  );
}
