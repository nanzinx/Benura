/**
 * [NOVO] Menu de ações de um atendente (aba Receptivo), como no painel do receptivo da
 * Argus: pausar (tipos da própria Argus), sair da pausa, ficar disponível, mandar para o
 * Ativo / trazer para a URA (fica travado lá até liberar) e deslogar.
 * No computador abre ao lado do botão; no celular, como uma folha no rodapé.
 * Fecha ao escolher, ao clicar fora, com Esc ou ao rolar a página.
 */

import { clsx } from 'clsx';
import { ArrowLeft, ArrowRightLeft, ChevronRight, Coffee, LoaderCircle, LogOut, MoreVertical, Play, Unlock, UserCheck } from 'lucide-react';
import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useAcaoOperador, usePausasDisponiveis } from '../dados';
import type { Classe, OndeTravado } from '../tipos';
import { useRetorno } from '../ui/retorno';

export interface Atendente {
  ramal: string;
  nome: string | null;
  /** onde ele está agora */
  onde: OndeTravado;
  classe?: Classe | null;
  pausa?: string | null;
  travado?: OndeTravado | null;
}

const LARGURA = 264;

function Item({ icone, children, onClick, perigo, nota }: { icone: ReactNode; children: ReactNode; onClick: () => void; perigo?: boolean; nota?: string }) {
  return (
    <button type="button" role="menuitem" onClick={onClick}
      className={clsx('flex w-full cursor-pointer items-start gap-2.5 rounded-lg px-3 py-2 text-left hover:bg-slate-100 dark:hover:bg-noite-800',
        perigo && 'text-red-700 dark:text-red-300')}>
      <span className="mt-0.5 shrink-0" aria-hidden>{icone}</span>
      <span className="flex-1">
        {children}
        {nota && <span className="block text-xs font-normal text-slate-500 dark:text-slate-400">{nota}</span>}
      </span>
    </button>
  );
}

export function AcoesAtendente({ a }: { a: Atendente }) {
  const [aberto, setAberto] = useState(false);
  const [tela, setTela] = useState<'acoes' | 'pausas'>('acoes');
  const [pos, setPos] = useState<{ top: number; left: number; folha: boolean } | null>(null);
  const botao = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const idMenu = useId();
  const acao = useAcaoOperador();
  const { confirmar } = useRetorno();
  const pausas = usePausasDisponiveis(aberto && tela === 'pausas' ? a.ramal : null);
  const quem = a.nome ?? `ramal ${a.ramal}`;

  const fechar = () => { setAberto(false); setTela('acoes'); };

  // Posição: abaixo (ou acima, se não couber) do botão, alinhado à direita; no celular, folha no rodapé.
  useLayoutEffect(() => {
    if (!aberto || !botao.current) return;
    const r = botao.current.getBoundingClientRect();
    const folha = window.innerWidth < 640;
    const altura = menu.current?.offsetHeight ?? 280;
    const abaixo = r.bottom + 6 + altura <= window.innerHeight;
    setPos({ folha, top: abaixo ? r.bottom + 6 : Math.max(8, r.top - 6 - altura), left: Math.max(8, Math.min(r.right - LARGURA, window.innerWidth - LARGURA - 8)) });
  }, [aberto, tela, pausas.data]);

  useEffect(() => {
    if (!aberto) return undefined;
    const fora = (e: MouseEvent | TouchEvent) => {
      const alvo = e.target as Node;
      if (!menu.current?.contains(alvo) && !botao.current?.contains(alvo)) fechar();
    };
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') fechar(); };
    const rolou = () => { if (window.innerWidth >= 640) fechar(); };
    document.addEventListener('mousedown', fora);
    document.addEventListener('touchstart', fora);
    document.addEventListener('keydown', esc);
    window.addEventListener('scroll', rolou, true);
    window.addEventListener('resize', fechar);
    return () => {
      document.removeEventListener('mousedown', fora);
      document.removeEventListener('touchstart', fora);
      document.removeEventListener('keydown', esc);
      window.removeEventListener('scroll', rolou, true);
      window.removeEventListener('resize', fechar);
    };
  }, [aberto]);

  const executar = async (pedido: Parameters<typeof acao.mutate>[0], pergunta?: { titulo: string; texto: ReactNode; confirmar: string; perigo?: boolean }) => {
    fechar();
    if (pergunta && !(await confirmar(pergunta))) return;
    acao.mutate({ ...pedido, nome: a.nome });
  };

  const emPausa = a.classe === 'outro' && Boolean(a.pausa);
  const naUra = a.onde === 'ura';
  const offline = a.classe === 'offline';

  const acoes = (
    <>
      <p className="px-3 pt-1.5 pb-1 text-xs font-semibold text-slate-500 dark:text-slate-400">{quem} · {a.ramal}</p>
      {emPausa ? (
        <Item icone={<Play className="size-4" />} onClick={() => executar({ acao: 'sair-pausa', ramal: a.ramal })} nota={`Em pausa: ${a.pausa}`}>Sair da pausa</Item>
      ) : !offline && (
        <Item icone={<Coffee className="size-4" />} onClick={() => setTela('pausas')} nota={a.classe === 'atendimento' ? 'Em ligação: pausa quando ficar livre' : undefined}>
          <span className="flex items-center justify-between">Pausar<ChevronRight className="size-4 text-slate-400" aria-hidden /></span>
        </Item>
      )}
      {!offline && !emPausa && a.classe !== 'livre' && (
        <Item icone={<UserCheck className="size-4" />} onClick={() => executar({ acao: 'ficar-disponivel', ramal: a.ramal })} nota="Mesmo com lead ou pesquisa aberta">
          Ficar disponível
        </Item>
      )}
      <Item icone={<ArrowRightLeft className="size-4" />}
        nota="Fica lá até liberar (ou virar o dia): o rodízio não mexe"
        onClick={() => executar({ acao: 'mover', ramal: a.ramal, para: naUra ? 'ativo' : 'ura' }, naUra ? {
          titulo: `Mandar ${quem} para o Ativo?`,
          texto: <p>Volta ao grupo do Ativo dele e <b>fica lá até alguém clicar em "Liberar para o rodízio"</b> (ou virar o dia): nem o rodízio nem venda nova sobem ele.</p>,
          confirmar: 'Mandar para o Ativo',
          perigo: true,
        } : undefined)}>
        {naUra ? 'Mandar para o Ativo' : 'Trazer para a URA'}
      </Item>
      {a.travado && (
        <Item icone={<Unlock className="size-4" />} onClick={() => executar({ acao: 'liberar', ramal: a.ramal })} nota={`Travado ${a.travado === 'ura' ? 'na URA' : 'no Ativo'} à mão`}>
          Liberar para o rodízio
        </Item>
      )}
      {!offline && (
        <Item icone={<LogOut className="size-4" />} perigo onClick={() => executar({ acao: 'deslogar', ramal: a.ramal }, {
          titulo: `Deslogar ${quem}?`,
          texto: <p>Desconecta {quem} da telefonia agora{a.classe === 'atendimento' ? ' (está em ligação)' : ''}. Para voltar, ele loga de novo no Argus.</p>,
          confirmar: 'Deslogar',
          perigo: true,
        })}>
          Deslogar
        </Item>
      )}
    </>
  );

  const listaDePausas = (
    <>
      <button type="button" onClick={() => setTela('acoes')} className="flex w-full cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-left text-xs font-semibold text-slate-500 hover:bg-slate-100 dark:text-slate-400 dark:hover:bg-noite-800">
        <ArrowLeft className="size-4" aria-hidden /> Pausar {quem}
      </button>
      {pausas.isLoading && <p className="flex items-center gap-2 px-3 py-2 text-slate-500"><LoaderCircle className="size-4 animate-spin" aria-hidden /> Buscando as pausas na Argus…</p>}
      {pausas.isError && <p className="px-3 py-2 text-red-700 dark:text-red-300">Não foi possível buscar as pausas: {pausas.error.message}</p>}
      {pausas.data?.pausas.length === 0 && <p className="px-3 py-2 text-slate-500">A Argus não tem pausas cadastradas para ele.</p>}
      {pausas.data?.pausas.map((p) => (
        <Item key={p.idPausa} icone={<Coffee className="size-4 text-slate-400" />} onClick={() => executar({ acao: 'pausar', ramal: a.ramal, idPausa: p.idPausa })}>{p.pausaDesc}</Item>
      ))}
    </>
  );

  return (
    <>
      <button ref={botao} type="button" onClick={() => (aberto ? fechar() : setAberto(true))} aria-haspopup="menu" aria-expanded={aberto} aria-controls={idMenu}
        aria-label={`Ações de ${quem}`} title="Ações" disabled={acao.isPending}
        className="inline-flex size-9 cursor-pointer items-center justify-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-800 disabled:opacity-60 dark:text-slate-400 dark:hover:bg-noite-800 dark:hover:text-slate-100">
        {acao.isPending ? <LoaderCircle className="size-4 animate-spin" aria-hidden /> : <MoreVertical className="size-4" aria-hidden />}
      </button>
      {aberto && createPortal(
        <>
          {pos?.folha && <div className="fixed inset-0 z-40 bg-slate-900/40" aria-hidden />}
          <div ref={menu} id={idMenu} role="menu"
            style={pos && !pos.folha ? { top: pos.top, left: pos.left, width: LARGURA } : undefined}
            className={clsx('fixed z-50 animate-entrar border border-slate-200 bg-white p-1.5 text-sm shadow-xl dark:border-noite-700 dark:bg-noite-900',
              pos?.folha ? 'inset-x-0 bottom-0 max-h-[75vh] overflow-y-auto rounded-t-2xl pb-[max(0.5rem,env(safe-area-inset-bottom))]' : 'max-h-[70vh] overflow-y-auto rounded-xl',
              !pos && 'invisible')}>
            {tela === 'acoes' ? acoes : listaDePausas}
          </div>
        </>,
        document.body,
      )}
    </>
  );
}
