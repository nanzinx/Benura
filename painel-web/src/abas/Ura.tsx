/**
 * Aba "URA e robôs": no topo, o rodízio dos robôs ([NOVO] automático, só pânico ou
 * desligados); embaixo, os interruptores (pânico, URA cheia, cliente de risco) em linhas
 * compactas, com a explicação longa em "Como funciona", e os clientes de risco recolhidos.
 */

import { clsx } from 'clsx';
import { Bell, BellRing, Bot, PowerOff, Search, ShieldAlert } from 'lucide-react';
import { useState, type ComponentType, type ReactNode } from 'react';
import type { ComandoUra } from '../api';
import { useComandoUra, useModoRobos, useRisco, useVisao } from '../dados';
import { dataBr, horaCurta, motivoLegivel } from '../formatos';
import { StatusUra } from '../componentes/StatusUra';
import { ativarAvisos, avisosAtivos } from '../notificacoes';
import type { ModoRobos, SaudeRodizio } from '../tipos';
import { Botao, Cartao, ComoFunciona, Esqueleto, Recolhivel, Selo, Vazio, VerMais, type Tom } from '../ui/base';
import { useRetorno } from '../ui/retorno';

interface Confirmar { titulo: string; texto: ReactNode; perigo?: boolean }

interface PropsInterruptor {
  comando: ComandoUra;
  titulo: string;
  estado: { texto: string; tom: Tom; pulsar?: boolean };
  /** uma linha: o que ele faz */
  resumo: ReactNode;
  /** a explicação longa (em "Como funciona") */
  children?: ReactNode;
  ligar: { texto: string; perigo?: boolean; confirmar?: Confirmar };
  desligar: { texto: string; confirmar?: Confirmar };
  rodape?: ReactNode;
}

/** Um interruptor em cartão compacto: estado, uma linha, os dois botões e o "Como funciona". */
function Interruptor({ comando, titulo, estado, resumo, children, ligar, desligar, rodape }: PropsInterruptor) {
  const mutacao = useComandoUra(comando);
  const { confirmar } = useRetorno();
  const executar = async (ligado: boolean) => {
    const c = ligado ? ligar.confirmar : desligar.confirmar;
    if (c && !(await confirmar({ ...c, confirmar: ligado ? ligar.texto : desligar.texto }))) return;
    mutacao.mutate(ligado);
  };
  const alvo = mutacao.isPending ? mutacao.variables : null;
  return (
    <Cartao titulo={titulo} extra={<Selo tom={estado.tom} pulsar={estado.pulsar}>{estado.texto}</Selo>}>
      <div className="grid content-start gap-3 text-sm leading-relaxed">
        <p className="text-slate-600 dark:text-slate-300">{resumo}</p>
        {children && <ComoFunciona>{children}</ComoFunciona>}
      </div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Botao variante={ligar.perigo ? 'perigo' : 'primario'} carregando={alvo === true} disabled={mutacao.isPending} onClick={() => executar(true)}>{ligar.texto}</Botao>
        <Botao variante="secundario" carregando={alvo === false} disabled={mutacao.isPending} onClick={() => executar(false)}>{desligar.texto}</Botao>
      </div>
      {rodape}
    </Cartao>
  );
}

const MODOS: { id: ModoRobos; titulo: string; linha: string; Icone: ComponentType<{ className?: string }>; cor: string }[] = [
  {
    id: 'automatico', titulo: 'Automático', Icone: Bot, cor: 'border-azul-500 bg-azul-50 text-azul-800 dark:border-azul-400 dark:bg-noite-800 dark:text-azul-100',
    linha: 'O BenURA liga e desliga sozinho, na ordem, conforme os livres e o status da URA.',
  },
  {
    id: 'panico', titulo: 'Só pânico', Icone: ShieldAlert, cor: 'border-amarelo-500 bg-amarelo-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100',
    linha: 'A supervisão liga pela Argus; o BenURA só desliga quando falta gente livre.',
  },
  {
    id: 'desligados', titulo: 'Desligados', Icone: PowerOff, cor: 'border-red-500 bg-red-50 text-red-800 dark:border-red-700 dark:bg-red-950/60 dark:text-red-200',
    linha: 'Todos os robôs desligados e mantidos assim. O resto da automação segue.',
  },
];

/** [NOVO] "Rodízio dos robôs": escolhe o modo; desligar e voltar ao automático pedem confirmação. */
function RodizioRobos({ r }: { r: SaudeRodizio }) {
  const mutacao = useModoRobos();
  const { confirmar } = useRetorno();
  const robos = r.robos;
  const modo: ModoRobos = robos?.modo ?? 'panico';
  const atual = MODOS.find((m) => m.id === modo)!;

  const escolher = async (novo: ModoRobos) => {
    if (novo === modo || mutacao.isPending) return;
    if (novo === 'desligados' && !(await confirmar({
      titulo: 'Desligar todos os robôs?',
      texto: <p>Os robôs parados desligam <b>agora</b>; os que estão em ligação terminam a chamada e desligam em seguida (nenhum cliente é cortado). Eles ficam desligados até alguém escolher outro modo. O rodízio dos humanos, o roteador e as rotinas seguem normais.</p>,
      confirmar: 'Desligar robôs', perigo: true,
    }))) return;
    if (novo === 'automatico' && modo === 'desligados' && !(await confirmar({
      titulo: 'Voltar os robôs ao automático?',
      texto: <p>O BenURA volta a ligar robôs na ordem (OPER VIRTUAL 1, 2… e os DTMF no fim), conforme os humanos livres na URA e o status da URA.</p>,
      confirmar: 'Voltar ao automático',
    }))) return;
    mutacao.mutate(novo);
  };

  return (
    <section className="cartao mb-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Rodízio dos robôs</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">
            {atual.linha}{robos?.modoDesde ? ` · desde ${horaCurta(robos.modoDesde)}${robos.modoPor ? ` (${robos.modoPor})` : ''}` : ''}
          </p>
        </div>
        <div className="flex gap-6 text-right">
          <div><span className="rotulo block">Ligados agora</span><b className="text-2xl tabular-nums">{robos?.ligados ?? '–'}</b><span className="text-sm text-slate-500"> / {robos?.total ?? '–'}</span></div>
          {modo === 'automatico' && (
            <div title="Robôs por humano livre: o ajuste do dia vezes o peso do status da URA">
              <span className="rotulo block">Por livre</span>
              <b className="text-2xl tabular-nums">{robos?.porLivreComStatus ?? robos?.porLivre ?? '–'}</b>
            </div>
          )}
        </div>
      </header>
      <div role="radiogroup" aria-label="Modo dos robôs" className="grid gap-3 sm:grid-cols-3">
        {MODOS.map((m) => {
          const ativo = m.id === modo;
          return (
            <button key={m.id} type="button" role="radio" aria-checked={ativo} disabled={mutacao.isPending} onClick={() => escolher(m.id)}
              className={clsx('flex cursor-pointer items-start gap-3 rounded-xl border-2 p-3.5 text-left transition-all motion-reduce:transition-none disabled:cursor-progress',
                ativo ? clsx(m.cor, 'shadow-sm') : 'border-slate-200 hover:border-slate-300 hover:bg-slate-50 dark:border-noite-700 dark:hover:border-noite-600 dark:hover:bg-noite-800/50')}>
              <m.Icone className={clsx('mt-0.5 size-5 shrink-0', !ativo && 'text-slate-400')} />
              <span>
                <span className="flex items-center gap-2 font-semibold">{m.titulo}{ativo && <span className="rounded-full bg-current/10 px-2 py-0.5 text-[11px] font-bold uppercase">agora</span>}</span>
                <span className={clsx('mt-0.5 block text-xs', ativo ? 'opacity-85' : 'text-slate-500 dark:text-slate-400')}>{m.linha}</span>
              </span>
            </button>
          );
        })}
      </div>
      <div className="mt-3">
        <ComoFunciona>
          <p><b>Automático:</b> liga em ordem crescente (OPER VIRTUAL 0/1, 2, 3… e os DTMF no fim) e reduz do último para o primeiro, pulando quem está em ligação. Ficam ligados os robôs por livre × humanos livres na URA; o status da URA pesa (calma liga mais, agressiva menos). Ninguém livre: desliga todos na hora.</p>
          <p><b>Só pânico:</b> como antes — quem liga é a supervisão, pela Argus; o BenURA só desliga nas regras do pânico (cartão abaixo).</p>
          <p><b>Desligados:</b> para quando os callbacks não param. Os parados desligam na hora, os em ligação ao terminar; se alguém ligar um robô pela Argus, o BenURA desliga de novo. O rodízio dos humanos, o roteador e as rotinas continuam.</p>
        </ComoFunciona>
      </div>
    </section>
  );
}

function ClientesDeRisco() {
  const { data, isLoading } = useRisco();
  const [busca, setBusca] = useState('');
  const todos = data?.clientes ?? [];
  const lista = todos.filter((c) => !busca || c.mascara.replace(/\D/g, '').includes(busca.replace(/\D/g, '')));
  const pior = todos[0];
  return (
    <Recolhivel chave="clientes-risco" titulo="Os 20 clientes de maior risco"
      resumo={<p className="text-sm text-slate-500 dark:text-slate-400">{pior ? `${todos.length} cliente(s) · o de mais risco: ${pior.mascara} (${pior.callbacks} callback(s))` : 'Nenhum cliente de risco ainda.'}</p>}
      extra={(
        <label className="relative">
          <span className="sr-only">Buscar por DDD ou final</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="DDD ou final" inputMode="numeric"
            className="w-36 rounded-lg border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-sm dark:border-noite-600 dark:bg-noite-950" />
        </label>
      )}>
      {isLoading ? <Esqueleto className="h-24 w-full" /> : lista.length ? (
        <VerMais itens={lista} limite={8} chave="clientes-risco" render={(itens) => (
          <div className="overflow-x-auto">
            <table className="tabela">
              <thead><tr><th>Telefone</th><th className="text-right">Callbacks</th><th className="text-right">Atendeu</th><th>Último dia</th><th className="hidden sm:table-cell">Motivo</th></tr></thead>
              <tbody>{itens.map((c) => (
                <tr key={c.mascara + c.ultimoDia}>
                  <td className="numero">{c.mascara}</td>
                  <td className="numero text-right font-semibold">{c.callbacks}</td>
                  <td className="numero text-right">{c.atendeu}</td>
                  <td className="numero">{dataBr(c.ultimoDia)}</td>
                  <td className="hidden sm:table-cell">{c.motivos.join(', ')}</td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )} />
      ) : <Vazio>{busca ? 'Nenhum cliente com esse número.' : 'Nenhum cliente de risco ainda.'}</Vazio>}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Só o telefone mascarado: o BenURA não guarda o número.</p>
    </Recolhivel>
  );
}

function BotaoAvisos() {
  const [estado, setEstado] = useState(avisosAtivos() ? 'Som ligado' : '');
  return (
    <div className="mt-3 flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-noite-800">
      <Botao variante="fantasma" icone={estado ? <BellRing className="size-4" /> : <Bell className="size-4" />} onClick={async () => {
        const r = await ativarAvisos();
        setEstado(`Som ligado · notificações ${r.notificacoes === 'granted' ? 'ligadas' : r.notificacoes === 'sem suporte' ? 'sem suporte neste navegador' : 'bloqueadas no navegador'}`);
      }}>Ativar som e notificações</Botao>
      <span className="text-sm text-slate-500 dark:text-slate-400">{estado}</span>
    </div>
  );
}

const SUBTITULO: Record<ModoRobos, string> = {
  automatico: 'O BenURA liga e desliga os robôs sozinho.',
  panico: 'Quem liga os robôs é a supervisão, pela Argus. O BenURA só desliga.',
  desligados: 'Robôs desligados pelo painel. O resto da automação segue.',
};

export function Ura() {
  const { data: v } = useVisao();
  const r = v?.servicos.rodizio.dados;
  if (!v) return <Esqueleto className="h-96 w-full" />;
  if (!r) {
    return (
      <Cartao titulo="URA e robôs">
        <Vazio>{v.automacao?.estado === 'desligada'
          ? 'A automação está desligada: os controles da URA voltam quando ela for religada (botão no topo da página).'
          : 'O rodízio não está respondendo. Veja a aba Serviços.'}</Vazio>
      </Cartao>
    );
  }
  const modo: ModoRobos = r.robos?.modo ?? 'panico';
  const p = r.panico;
  const cheia = r.uraCheia;
  const risco = v?.alertas;
  const antesDeSair = Math.round((p?.antesDeSairMs ?? 60_000) / 1000);
  const passoFixo = Math.round((p?.fixoReduzirMs ?? 60_000) / 1000);
  const fixoOcioso = Math.round((p?.fixoOciosoMs ?? 180_000) / 60_000);

  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">URA e robôs</h1>
          <StatusUra />
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">{SUBTITULO[modo]}</p>
      </div>
      <RodizioRobos r={r} />
      <div className="mb-5 grid items-start gap-5 lg:grid-cols-3">
        {modo === 'panico' && p ? (
          <Interruptor comando="panico" titulo="Pânico dos robôs"
            estado={p.ativoAgora ? { texto: p.tipo === 'fixo' ? 'reduzindo robôs' : 'desligando robôs', tom: 'perigo', pulsar: true } : p.ligado ? { texto: 'ligado', tom: 'ok' } : { texto: 'desligado', tom: 'neutro' }}
            resumo="Desliga os robôs quando falta humano livre na URA."
            ligar={{ texto: 'Ligar pânico', perigo: true }}
            desligar={{ texto: 'Desligar', confirmar: { titulo: 'Desligar o pânico?', texto: 'O BenURA deixa de desligar os robôs quando a URA fica com poucos livres.' } }}
            rodape={p.motivo ? <p className="mt-3 rounded-lg bg-red-50 px-3 py-2 text-sm font-semibold text-red-700 dark:bg-red-950/60 dark:text-red-300">Agora: {motivoLegivel(p.motivo)}</p> : undefined}>
            <ul className="grid list-disc gap-1.5 pl-5">
              <li><b>Nenhum livre:</b> desliga todos os robôs na hora, inclusive os em ligação.</li>
              <li><b>1 livre:</b> os robôs seguem até <b>{antesDeSair} s</b> antes de ele sair por ociosidade; aí os parados desligam e os em ligação terminam a chamada.</li>
              <li><b>1 livre fixo</b>: desliga <b>metade</b> dos robôs ligados e de novo a cada <b>{passoFixo} s</b> (fica pelo menos 1). Livre há <b>{fixoOcioso} min</b>, ou com a URA em <b>CALMA</b>, os robôs seguem até ele atender.</li>
            </ul>
          </Interruptor>
        ) : (
          <Cartao titulo="Pânico dos robôs" extra={<Selo tom="neutro">{modo === 'automatico' ? 'embutido no automático' : 'robôs desligados'}</Selo>}>
            <p className="text-sm text-slate-600 dark:text-slate-300">
              {modo === 'automatico'
                ? 'No automático, a proteção já vem junto: ninguém livre desliga todos na hora; com 1 livre, no máximo o teto de robôs.'
                : 'Com os robôs desligados pelo painel, o pânico não tem o que fazer.'}
            </p>
          </Cartao>
        )}
        <Interruptor comando="ura/cheia" titulo="URA cheia"
          estado={cheia?.ligada ? { texto: `ligada desde ${horaCurta(cheia.desde)}`, tom: 'alerta' } : { texto: 'rodízio normal', tom: 'neutro' }}
          resumo="Leva todos os operadores do Ativo para a URA."
          ligar={{ texto: 'Colocar todos na URA', confirmar: { titulo: 'Colocar todos na URA?', texto: 'Todos os operadores do Ativo vão para a URA em até 5 s, atendendo ou não.' } }}
          desligar={{ texto: 'Voltar ao normal' }}>
          <p>A regra do ocioso continua valendo: quem fica livre o tempo todo volta ao Ativo e sobe de novo ao atender lá.</p>
          <p>Voltar ao normal: só sobe quem é elegível (meta de ontem, venda hoje ou fixo). Vale até desligar ou virar o dia.</p>
        </Interruptor>
        {risco?.ativo && (
          <Interruptor comando="risco/desligar" titulo="Clientes de risco"
            estado={risco.desligaRobos?.ligado ? { texto: 'desliga os robôs', tom: 'perigo' } : { texto: 'só avisa', tom: 'ok' }}
            resumo={`${risco.perfis?.risco ?? 0} cliente(s) de risco entre ${risco.perfis?.clientes ?? 0} com perfil.`}
            ligar={{ texto: 'Desligar robôs com cliente de risco', perigo: true }} desligar={{ texto: 'Só avisar' }}
            rodape={<BotaoAvisos />}>
            <p>Cliente que gerou callback ou atende muito o robô nos últimos dias. Quando um robô fala com ele, o aviso aparece no topo, com som e notificação.</p>
            {risco.perfis?.historicoAte && <p>Histórico até {dataBr(risco.perfis.historicoAte)}.</p>}
          </Interruptor>
        )}
      </div>
      {risco?.ativo && <ClientesDeRisco />}
    </>
  );
}
