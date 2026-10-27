import { clsx } from 'clsx';
import { Activity, ChevronDown, Headset, KeyRound, LayoutDashboard, LifeBuoy, LogOut, Monitor, Moon, Pause, Play, Server, Sun, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ComponentType } from 'react';
import { useVisao } from '../dados';
import { NOMES_PAPEIS, usePode, useSessao } from '../sessao';
import type { Tema } from '../tema';
import { Marca } from './Marca';
import { BotaoDesligarAutomacao } from './DesligarAutomacao';
import { TrocarSenha } from './Usuarios';

export type Aba = 'visao' | 'receptivo' | 'ura' | 'esteira' | 'servicos' | 'ajuda';
/** `curto`: o rótulo nas telas até 1536 px (com 6 abas, o completo quebraria o topo em duas linhas). */
export const ABAS: { id: Aba; texto: string; curto: string; Icone: ComponentType<{ className?: string }> }[] = [
  { id: 'visao', texto: 'Visão geral', curto: 'Visão geral', Icone: LayoutDashboard },
  { id: 'receptivo', texto: 'Receptivo URA', curto: 'Receptivo', Icone: Headset },
  { id: 'ura', texto: 'URA e robôs', curto: 'Robôs', Icone: Activity },
  { id: 'esteira', texto: 'Esteira manual', curto: 'Esteira', Icone: Upload },
  { id: 'servicos', texto: 'Serviços', curto: 'Serviços', Icone: Server },
  { id: 'ajuda', texto: 'Ajuda', curto: 'Ajuda', Icone: LifeBuoy },
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

const iniciais = (nome: string) => nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

/** [NOVO] Quem entrou, o papel e o menu: trocar a senha e sair. Senha provisória: pede para trocar ao entrar. */
function MenuUsuario({ sair }: { sair: () => void }) {
  const sessao = useSessao();
  const [aberto, setAberto] = useState(false);
  const [trocar, setTrocar] = useState<'nao' | 'pedida' | 'provisoria'>('nao');
  const raiz = useRef<HTMLDivElement>(null);
  const idMenu = useId();
  const provisoria = sessao.estado === 'dentro' && sessao.usuario.senhaProvisoria;
  useEffect(() => { if (provisoria) setTrocar('provisoria'); }, [provisoria]);
  useEffect(() => {
    if (!aberto) return undefined;
    const fora = (e: MouseEvent) => { if (!raiz.current?.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setAberto(false); };
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc); };
  }, [aberto]);
  if (sessao.estado !== 'dentro') return null;
  const { usuario, emergencia } = sessao;

  return (
    <div ref={raiz} className="relative">
      <button type="button" onClick={() => setAberto((a) => !a)} aria-haspopup="menu" aria-expanded={aberto} aria-controls={idMenu}
        title={`${usuario.nome} · ${NOMES_PAPEIS[usuario.papel]}`}
        className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-white/30 py-1 pr-2 pl-1 text-sm font-semibold hover:bg-white/10">
        <span className={clsx('grid size-7 place-items-center rounded-md text-xs font-bold', emergencia ? 'bg-amarelo-500 text-marinho-950' : 'bg-white/15')}>{emergencia ? '!' : iniciais(usuario.nome)}</span>
        <span className="hidden text-left leading-tight xl:block">
          <span className="block max-w-32 truncate">{usuario.nome.split(' ')[0]}</span>
          <span className="block text-[11px] font-normal text-azul-100/80">{NOMES_PAPEIS[usuario.papel]}</span>
        </span>
        <ChevronDown className={clsx('size-4 transition-transform', aberto && 'rotate-180')} aria-hidden />
      </button>
      {aberto && (
        <div id={idMenu} role="menu" className="absolute right-0 z-40 mt-2 w-64 animate-entrar rounded-xl border border-slate-200 bg-white p-1.5 text-sm text-slate-800 shadow-xl dark:border-noite-700 dark:bg-noite-900 dark:text-slate-100">
          <div className="border-b border-slate-100 px-3 pt-1.5 pb-2.5 dark:border-noite-800">
            <p className="truncate font-semibold">{usuario.nome}</p>
            {usuario.email && <p className="truncate text-xs text-slate-500 dark:text-slate-400">{usuario.email}</p>}
            <p className="mt-1.5 inline-block rounded-full bg-azul-50 px-2 py-0.5 text-xs font-semibold text-azul-700 dark:bg-noite-800 dark:text-azul-300">{NOMES_PAPEIS[usuario.papel]}</p>
            {emergencia && <p className="mt-1.5 text-xs text-amber-700 dark:text-amber-300">Acesso de emergência: crie os usuários em Serviços.</p>}
          </div>
          {!emergencia && (
            <button type="button" role="menuitem" onClick={() => { setAberto(false); setTrocar('pedida'); }}
              className="mt-1 flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-noite-800">
              <KeyRound className="size-4 text-slate-400" aria-hidden />Trocar minha senha
            </button>
          )}
          <button type="button" role="menuitem" onClick={sair}
            className="flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-noite-800">
            <LogOut className="size-4 text-slate-400" aria-hidden />Sair
          </button>
        </div>
      )}
      {trocar !== 'nao' && <TrocarSenha provisoria={trocar === 'provisoria'} fechar={() => setTrocar('nao')} />}
    </div>
  );
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
  const admin = usePode('administrador');
  const dryRun = Boolean(visao?.servicos.rodizio.dados?.dryRun);
  const proximoTema = TEMAS[(TEMAS.findIndex((t) => t.id === tema) + 1) % TEMAS.length]!;
  const TemaAtual = TEMAS.find((t) => t.id === tema)!.Icone;

  return (
    <header className="sticky top-0 z-30 border-b-[3px] border-amarelo-500 bg-gradient-to-b from-marinho-900 to-marinho-800 text-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 px-4 sm:px-6">
        <a href="#visao" className="py-3.5" aria-label="BenURA, visão geral"><Marca /></a>
        <nav aria-label="Seções" className="order-3 -mb-[3px] flex basis-full gap-1 overflow-x-auto [scrollbar-width:none] lg:order-none lg:basis-auto lg:flex-1">
          {ABAS.map(({ id, texto, curto, Icone }) => (
            <a
              key={id}
              href={`#${id}`}
              aria-current={aba === id ? 'page' : undefined}
              className={clsx('flex items-center gap-2 whitespace-nowrap border-b-[3px] px-3 pt-3 pb-2.5 text-sm font-semibold transition-colors lg:py-5',
                aba === id ? 'border-white text-white' : 'border-transparent text-azul-100/80 hover:text-white')}
            >
              <Icone className="size-4" aria-hidden /><span className="2xl:hidden">{curto}</span><span className="hidden 2xl:inline">{texto}</span>
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
          {admin && <BotaoDesligarAutomacao />}
          <button type="button" onClick={() => trocarTema(proximoTema.id)} title={`Tema: ${TEMAS.find((t) => t.id === tema)!.texto} (trocar para ${proximoTema.texto.toLowerCase()})`}
            className="hidden size-9 cursor-pointer place-items-center rounded-lg hover:bg-white/10 sm:grid" aria-label="Trocar o tema">
            <TemaAtual className="size-4" aria-hidden />
          </button>
          <MenuUsuario sair={sair} />
        </div>
      </div>
    </header>
  );
}
