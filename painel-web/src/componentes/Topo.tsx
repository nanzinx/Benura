import { clsx } from 'clsx';
import { Activity, LayoutDashboard, LogOut, Monitor, Moon, Pause, Play, Server, Sun, Upload } from 'lucide-react';
import { useEffect, useState, type ComponentType } from 'react';
import { useVisao } from '../dados';
import type { Tema } from '../tema';
import { Marca } from './Marca';
import { BotaoDesligarAutomacao } from './DesligarAutomacao';

export type Aba = 'visao' | 'ura' | 'esteira' | 'servicos';
export const ABAS: { id: Aba; texto: string; Icone: ComponentType<{ className?: string }> }[] = [
  { id: 'visao', texto: 'Visão geral', Icone: LayoutDashboard },
  { id: 'ura', texto: 'URA e robôs', Icone: Activity },
  { id: 'esteira', texto: 'Esteira manual', Icone: Upload },
  { id: 'servicos', texto: 'Serviços', Icone: Server },
];

const TEMAS: { id: Tema; texto: string; Icone: ComponentType<{ className?: string }> }[] = [
  { id: 'claro', texto: 'Claro', Icone: Sun },
  { id: 'escuro', texto: 'Escuro', Icone: Moon },
  { id: 'sistema', texto: 'Do sistema', Icone: Monitor },
];

function Relogio() {
  const [agora, setAgora] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setAgora(new Date()), 1000);
    return () => clearInterval(t);
  }, []);
  return <span className="hidden font-semibold text-azul-100 tabular-nums 2xl:inline">{agora.toLocaleTimeString('pt-BR')}</span>;
}

interface Props {
  aba: Aba;
  tema: Tema;
  escuro: boolean;
  trocarTema: (t: Tema) => void;
  aoVivo: boolean;
  alternarAoVivo: () => void;
  sair: () => void;
}

export function Topo({ aba, tema, trocarTema, aoVivo, alternarAoVivo, sair }: Props) {
  const { data: visao } = useVisao();
  const dryRun = Boolean(visao?.servicos.rodizio.dados?.dryRun);
  const proximoTema = TEMAS[(TEMAS.findIndex((t) => t.id === tema) + 1) % TEMAS.length]!;
  const TemaAtual = TEMAS.find((t) => t.id === tema)!.Icone;

  return (
    <header className="sticky top-0 z-30 border-b-[3px] border-amarelo-500 bg-gradient-to-b from-marinho-900 to-marinho-800 text-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 px-4 sm:px-6">
        <a href="#visao" className="py-3.5" aria-label="BenURA, visão geral"><Marca /></a>
        <nav aria-label="Seções" className="order-3 -mb-[3px] flex basis-full gap-1 overflow-x-auto [scrollbar-width:none] lg:order-none lg:basis-auto lg:flex-1">
          {ABAS.map(({ id, texto, Icone }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={aba === id ? 'page' : undefined}
              className={clsx('flex items-center gap-2 whitespace-nowrap border-b-[3px] px-3 pt-3 pb-2.5 text-sm font-semibold transition-colors lg:py-5',
                aba === id ? 'border-white text-white' : 'border-transparent text-azul-100/80 hover:text-white')}
            >
              <Icone className="size-4" aria-hidden />{texto}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1.5 py-3 sm:gap-2">
          {dryRun && <a href="#servicos" title="Modo simulação (DRY_RUN): o BenURA só mostra o que faria. Clique para ver ou desligar." className="rounded-full bg-amarelo-500 px-2 py-0.5 text-xs font-bold text-marinho-950 hover:bg-amarelo-400 sm:px-2.5">Simulação</a>}
          <button
            type="button"
            onClick={alternarAoVivo}
            title={aoVivo ? 'Pausar as atualizações (P)' : 'Retomar as atualizações (P)'}
            aria-label={aoVivo ? 'Ao vivo: pausar as atualizações' : 'Pausado: retomar as atualizações'}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-full border border-white/25 px-2.5 py-1 text-xs font-semibold hover:bg-white/10"
          >
            {aoVivo
              ? <><span className="relative flex size-2"><span className="absolute size-full animate-ping rounded-full bg-emerald-400 opacity-70" /><span className="relative size-2 rounded-full bg-emerald-400" /></span><span className="hidden sm:inline lg:hidden xl:inline">Ao vivo</span><Pause className="size-3.5" aria-hidden /></>
              : <><span className="size-2 rounded-full bg-slate-400" /><span className="hidden sm:inline lg:hidden xl:inline">Pausado</span><Play className="size-3.5" aria-hidden /></>}
          </button>
          <Relogio />
          <BotaoDesligarAutomacao />
          <button type="button" onClick={() => trocarTema(proximoTema.id)} title={`Tema: ${TEMAS.find((t) => t.id === tema)!.texto} (trocar para ${proximoTema.texto.toLowerCase()})`}
            className="hidden size-9 cursor-pointer place-items-center rounded-lg hover:bg-white/10 sm:grid" aria-label="Trocar o tema">
            <TemaAtual className="size-4" aria-hidden />
          </button>
          <button type="button" onClick={sair} aria-label="Sair" className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/30 px-2.5 py-1.5 text-sm font-semibold hover:bg-white/10 sm:px-3">
            <LogOut className="size-4" aria-hidden /><span className="hidden sm:inline lg:hidden xl:inline">Sair</span>
          </button>
        </div>
      </div>
    </header>
  );
}
