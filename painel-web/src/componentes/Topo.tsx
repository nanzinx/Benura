import { clsx } from 'clsx';
import { Activity, ChartColumn, ChevronDown, Headset, KeyRound, LayoutDashboard, LifeBuoy, LogOut, Monitor, Moon, Pause, Play, Server, Sun, Upload } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ComponentType, type KeyboardEvent as EventoDeTecla } from 'react';
import { useVisao } from '../dados';
import { falhasDaArgus, saudeDaArgus } from '../saude-argus';
import { NOMES_PAPEIS, usePode, useSessao } from '../sessao';
import type { Tema } from '../tema';
import { Marca } from './Marca';
import { BotaoDesligarAutomacao } from './DesligarAutomacao';
import { TrocarSenha } from './Usuarios';

import { aoClicarNaAba, CAMINHOS, NOMES_DAS_ABAS, type Aba } from '../rotas';

export type { Aba };
/** A ordem é a dos atalhos (1 a 7) e a do menu de abas. */
export const ABAS: { id: Aba; texto: string; curto: string; Icone: ComponentType<{ className?: string }> }[] = [
  { id: 'visao', texto: NOMES_DAS_ABAS.visao, curto: 'Visão geral', Icone: LayoutDashboard },
  { id: 'relatorios', texto: NOMES_DAS_ABAS.relatorios, curto: 'Relatórios', Icone: ChartColumn },
  { id: 'receptivo', texto: NOMES_DAS_ABAS.receptivo, curto: 'Receptivo', Icone: Headset },
  { id: 'ura', texto: NOMES_DAS_ABAS.ura, curto: 'Robôs', Icone: Activity },
  { id: 'esteira', texto: NOMES_DAS_ABAS.esteira, curto: 'Esteira', Icone: Upload },
  { id: 'servicos', texto: NOMES_DAS_ABAS.servicos, curto: 'Serviços', Icone: Server },
  { id: 'ajuda', texto: NOMES_DAS_ABAS.ajuda, curto: 'Ajuda', Icone: LifeBuoy },
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

/**
 * [NOVO] As abas numa lista que expande: o botão mostra a aba atual; a lista tem todas, com o atalho.
 * Fecha com clique fora, Esc ou ao escolher; as setas andam pela lista. Cada item é um link de verdade
 * (Ctrl+clique abre em outra guia).
 */
function MenuDeAbas({ aba, argusFalhando }: { aba: Aba; argusFalhando: { pct: number } | null }) {
  const [aberto, setAberto] = useState(false);
  const raiz = useRef<HTMLElement>(null);
  const botao = useRef<HTMLButtonElement>(null);
  const idMenu = useId();
  const atual = ABAS.find((a) => a.id === aba) ?? ABAS[0]!;
  const itens = () => [...(raiz.current?.querySelectorAll<HTMLAnchorElement>('[role="menuitem"]') ?? [])];
  useEffect(() => {
    if (!aberto) return undefined;
    itens().find((el) => el.getAttribute('aria-current') === 'page')?.focus();
    const fora = (e: MouseEvent) => { if (!raiz.current?.contains(e.target as Node)) setAberto(false); };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setAberto(false); botao.current?.focus(); } };
    document.addEventListener('mousedown', fora);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', fora); document.removeEventListener('keydown', esc); };
  }, [aberto]);
  const andar = (e: EventoDeTecla) => {
    if (!aberto || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const lista = itens();
    const i = lista.indexOf(document.activeElement as HTMLAnchorElement);
    const proximo = e.key === 'Home' ? 0 : e.key === 'End' ? lista.length - 1 : (i + (e.key === 'ArrowDown' ? 1 : -1) + lista.length) % lista.length;
    lista[proximo]?.focus();
  };
  const ponto = (titulo: string) => (
    <span className="size-2 flex-none rounded-full bg-amarelo-400" title={titulo}><span className="sr-only">(a Argus está falhando)</span></span>
  );
  const avisoArgus = argusFalhando ? `A Argus está falhando: ${argusFalhando.pct}% de erro nos últimos 15 min` : '';

  return (
    <nav ref={raiz} aria-label="Seções" className="relative" onKeyDown={andar}>
      <button ref={botao} type="button" onClick={() => setAberto((a) => !a)} aria-haspopup="menu" aria-expanded={aberto} aria-controls={idMenu}
        className={clsx('inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold transition-colors hover:bg-white/10', aberto && 'bg-white/10')}>
        <atual.Icone className="size-4" aria-hidden />
        <span>{atual.texto}</span>
        {argusFalhando && aba !== 'servicos' && ponto(avisoArgus)}
        <ChevronDown className={clsx('size-4 transition-transform', aberto && 'rotate-180')} aria-hidden />
      </button>
      {aberto && (
        <div id={idMenu} role="menu" aria-label="Abas"
          className="absolute left-0 z-40 mt-2 w-72 animate-entrar rounded-xl border border-slate-200 bg-white p-1.5 text-sm text-slate-800 shadow-xl max-sm:fixed max-sm:inset-x-4 max-sm:top-16 max-sm:w-auto dark:border-noite-700 dark:bg-noite-900 dark:text-slate-100">
          {ABAS.map(({ id, texto, Icone }, i) => (
            <a key={id} role="menuitem" href={CAMINHOS[id]} aria-current={aba === id ? 'page' : undefined}
              onClick={(e) => { aoClicarNaAba(id)(e); setAberto(false); }}
              className={clsx('flex items-center gap-3 rounded-lg px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-azul-500',
                aba === id ? 'bg-azul-50 font-semibold text-azul-800 dark:bg-noite-800 dark:text-azul-200' : 'hover:bg-slate-100 focus:bg-slate-100 dark:hover:bg-noite-800 dark:focus:bg-noite-800')}>
              <Icone className={clsx('size-4 flex-none', aba === id ? 'text-azul-600 dark:text-azul-300' : 'text-slate-400')} aria-hidden />
              <span className="flex-1">{texto}</span>
              {id === 'servicos' && argusFalhando && ponto(avisoArgus)}
              <kbd className="rounded border border-slate-200 px-1.5 font-sans text-[11px] text-slate-400 dark:border-noite-700">{i + 1}</kbd>
            </a>
          ))}
        </div>
      )}
    </nav>
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
  // [NOVO] a Argus falhando muito: só um pontinho na aba Serviços (o detalhe fica lá)
  const argusFalhando = visao ? falhasDaArgus(saudeDaArgus(visao)) : null;
  const proximoTema = TEMAS[(TEMAS.findIndex((t) => t.id === tema) + 1) % TEMAS.length]!;
  const TemaAtual = TEMAS.find((t) => t.id === tema)!.Icone;

  return (
    <header className="sticky top-0 z-30 border-b-[3px] border-amarelo-500 bg-gradient-to-b from-marinho-900 to-marinho-800 text-white">
      <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-5 px-4 sm:px-6">
        <a href={CAMINHOS.visao} onClick={aoClicarNaAba('visao')} className="py-3.5" aria-label="BenURA, visão geral"><Marca animada /></a>
        <MenuDeAbas aba={aba} argusFalhando={argusFalhando} />
        <div className="ml-auto flex items-center gap-1.5 py-3 sm:gap-2">
          {dryRun && <a href={CAMINHOS.servicos} onClick={aoClicarNaAba('servicos')} title="Modo simulação (DRY_RUN): o BenURA só mostra o que faria. Clique para ver ou desligar." className="rounded-full bg-amarelo-500 px-2 py-0.5 text-xs font-bold text-marinho-950 hover:bg-amarelo-400 sm:px-2.5">Simulação</a>}
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
