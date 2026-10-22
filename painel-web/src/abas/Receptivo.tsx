/**
 * [NOVO] Painel do Receptivo URA: resumo, operadores humanos (tempo no status, selo de
 * fixo e de travado, e o menu de ações de cada um: pausar, sair da pausa, ficar
 * disponível, mandar para o Ativo, deslogar), gestão de pausas (limite, excedido, total do
 * dia por tipo), quem está no Ativo (trazer para a URA), o relatório do dia por atendente
 * e "Alocar Todos no Ativo". Tudo vem do backend (o rodízio filtra e executa).
 */

import { clsx } from 'clsx';
import { ArrowRightLeft, Coffee, Hourglass, Lock, PhoneForwarded, PhoneIncoming, RotateCcw, UserCheck, Users } from 'lucide-react';
import { useEffect, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { AcoesAtendente } from '../componentes/AcoesAtendente';
import { NoAtivo } from '../componentes/NoAtivo';
import { RelatorioPessoal } from '../componentes/RelatorioPessoal';
import { StatusUra } from '../componentes/StatusUra';
import { useMetricasHoje, useRetomarRodizio, useTransferirUraAtivo, useVisao } from '../dados';
import { cronometro, horaCurta, limiteDaPausa, minutos, ordenarOperadores } from '../formatos';
import type { OperadorNaUra, SaudeRodizio } from '../tipos';
import { Botao, Cartao, Esqueleto, Selo, Vazio } from '../ui/base';
import { useFlip } from '../ui/flip';
import { useRetorno } from '../ui/retorno';
import { CLASSES, DEFINICOES } from './Visao';

/** Relógio da tela: o tempo no status e o da pausa correm a cada segundo. */
function useAgora(intervaloMs = 1000) {
  const [agora, setAgora] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setAgora(Date.now()), intervaloMs);
    return () => clearInterval(t);
  }, [intervaloMs]);
  return agora;
}

const segundosDesde = (iso: string | null | undefined, agora: number) => (iso ? Math.max(0, (agora - new Date(iso).getTime()) / 1000) : null);

function Resumo({ rotulo, valor, Icone, nota, dica }: { rotulo: string; valor: ReactNode; Icone: ComponentType<{ className?: string }>; nota?: ReactNode; dica?: string }) {
  return (
    <div title={dica} className={clsx('cartao p-4', dica && 'cursor-help')}>
      <div className="flex items-center justify-between"><span className="rotulo">{rotulo}</span><Icone className="size-4 text-slate-400 dark:text-slate-500" aria-hidden /></div>
      <div className="mt-1 text-3xl font-bold tabular-nums">{valor}</div>
      <div className="min-h-5 text-sm text-slate-500 dark:text-slate-400">{nota}</div>
    </div>
  );
}

/**
 * Botão "Alocar Todos no Ativo": confirma com os números do backend e mostra o resultado.
 * Depois, todos ficam no Ativo até "Retomar rodízio da URA" (o mesmo lugar vira esse botão).
 */
function AlocarTodosNoAtivo({ r }: { r: SaudeRodizio }) {
  const alocar = useTransferirUraAtivo();
  const retomar = useRetomarRodizio();
  const { confirmar } = useRetorno();
  const t = r.transferenciaUraAtivo;
  const ret = r.retencaoAtivo;
  const elegiveis = t?.elegiveis ?? 0;

  if (ret?.ativa) {
    const voltam = ret.elegiveisParaVoltar;
    const clicarRetomar = async () => {
      const ok = await confirmar({
        titulo: 'Retomar o rodízio da URA?',
        texto: voltam == null
          ? <p>O rodízio volta ao normal: quem atender no Ativo sobe para a URA (sem a lista do dia do roteador, ninguém é movido agora).</p>
          : <p><b>{voltam} operador(es)</b> que venderam hoje ou bateram a meta ontem voltam para a URA agora. Os outros ficam no Ativo e o rodízio segue normal.</p>,
        confirmar: 'Retomar rodízio',
      });
      if (ok) retomar.mutate();
    };
    return (
      <Botao variante="primario" icone={<RotateCcw className="size-4" />} carregando={retomar.isPending} disabled={retomar.isPending} onClick={clicarRetomar}>
        Retomar rodízio da URA{voltam ? ` (${voltam})` : ''}
      </Botao>
    );
  }

  const clicar = async () => {
    const ok = await confirmar({
      titulo: `Mover ${elegiveis} operador(es) da URA para o Ativo?`,
      texto: (
        <>
          <p>{t?.fixos ?? 0} fixo(s) serão mantidos na URA. Cada um volta ao seu grupo do Ativo.</p>
          <p className="mt-2 font-semibold">Eles ficam no Ativo até alguém clicar em "Retomar rodízio da URA" (inclusive amanhã): nem o rodízio nem venda nova sobem ninguém.</p>
          {t?.uraCheiaLigada && <p className="mt-2 font-semibold">A URA cheia está ligada e será desligada junto.</p>}
        </>
      ),
      confirmar: 'Alocar no Ativo',
      perigo: true,
    });
    if (ok) alocar.mutate();
  };
  return (
    <Botao variante="perigo" icone={<ArrowRightLeft className="size-4" />} carregando={alocar.isPending} disabled={!elegiveis || alocar.isPending}
      title={elegiveis ? undefined : 'Ninguém elegível: só fixos (ou ninguém) na URA.'} onClick={clicar}>
      Alocar Todos no Ativo{elegiveis ? ` (${elegiveis})` : ''}
    </Botao>
  );
}

function Operadores({ ura, agora }: { ura: OperadorNaUra[]; agora: number }) {
  const lista = useMemo(() => ordenarOperadores(ura), [ura]);
  const corpo = useFlip<HTMLTableSectionElement>(lista.map((u) => u.ramal));
  return (
    <Cartao titulo="Operadores do receptivo" extra={<span>{lista.length} humano(s)</span>}>
      {lista.length ? (
        <div className="overflow-x-auto">
          <table className="tabela [&_td]:px-2 sm:[&_td]:px-3 [&_th]:px-2 sm:[&_th]:px-3">
            <thead><tr><th>Operador</th><th>Status</th><th className="hidden text-right sm:table-cell">No status há</th><th className="w-10"><span className="sr-only">Ações</span></th></tr></thead>
            <tbody ref={corpo}>{lista.map((u) => {
              const c = CLASSES[u.classe ?? 'erro'];
              const seg = segundosDesde(u.statusDesde, agora);
              return (
                <tr key={u.ramal} data-flip={u.ramal}>
                  <td>
                    <span className="font-medium">{u.nome ?? '—'}</span>
                    {u.fixo && <span className="ml-2 rounded-md bg-amarelo-100 px-1.5 py-0.5 text-[11px] font-bold text-amber-900 dark:bg-amber-950 dark:text-amber-200">Fixo</span>}
                    {u.travado === 'ura' && (
                      <span title="Travado na URA à mão: o rodízio não devolve ao Ativo até liberar"
                        className="ml-2 inline-flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-bold text-slate-700 dark:bg-noite-800 dark:text-slate-200">
                        <Lock className="size-3" aria-hidden />Travado
                      </span>
                    )}
                    <span className="block text-xs text-slate-500 tabular-nums dark:text-slate-400">{u.ramal}</span>
                  </td>
                  <td>
                    <Selo tom={c.tom}>{u.classe === 'outro' && u.pausa ? `Pausa · ${u.pausa}` : c.texto}</Selo>
                    <span className="mt-0.5 block text-xs text-slate-500 tabular-nums sm:hidden dark:text-slate-400">há {seg != null ? cronometro(seg) : '–'}</span>
                  </td>
                  <td className="numero hidden text-right sm:table-cell">{seg != null ? cronometro(seg) : '–'}</td>
                  <td className="w-10 py-1 pr-0! text-right sm:pr-3!">
                    <AcoesAtendente a={{ ramal: u.ramal, nome: u.nome, onde: 'ura', classe: u.classe, pausa: u.pausa, travado: u.travado }} />
                  </td>
                </tr>
              );
            })}</tbody>
          </table>
        </div>
      ) : <Vazio>Ninguém no receptivo agora.</Vazio>}
    </Cartao>
  );
}

function Pausas({ r, agora }: { r: SaudeRodizio; agora: number }) {
  const limites = r.pausasLimitesMin ?? {};
  const emPausa = (r.uraAgora ?? []).filter((u) => !u.virtual && u.classe === 'outro' && u.pausa).map((u) => {
    const seg = segundosDesde(u.statusDesde, agora) ?? 0;
    const limite = limiteDaPausa(u.pausa, limites);
    return { ...u, seg, limite, excedido: limite != null ? seg - limite * 60 : null };
  }).sort((a, b) => (b.excedido ?? -Infinity) - (a.excedido ?? -Infinity) || b.seg - a.seg);
  const total = Object.entries(r.relatorio?.pausasMin ?? {}).sort((a, b) => b[1] - a[1]);

  return (
    <Cartao titulo="Pausas" extra={<span>{emPausa.length} em pausa agora</span>}>
      {emPausa.length ? (
        <ul className="mb-4 grid gap-2">
          {emPausa.map((p) => {
            const passou = p.excedido != null && p.excedido > 0;
            return (
              <li key={p.ramal} className={clsx('flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-2',
                passou ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/50 dark:text-red-200' : 'border-slate-200 dark:border-noite-700')}>
                <span className="font-semibold">{p.nome ?? p.ramal}</span>
                <span className="text-sm">{p.pausa}</span>
                <span className="ml-auto text-sm tabular-nums">
                  {cronometro(p.seg)}{p.limite != null && <span className="text-slate-500 dark:text-slate-400"> / {p.limite} min</span>}
                </span>
                {passou && <span className="w-full text-sm font-bold tabular-nums sm:w-auto">+{cronometro(p.excedido!)} acima do limite</span>}
              </li>
            );
          })}
        </ul>
      ) : <div className="mb-4"><Vazio>Ninguém em pausa agora.</Vazio></div>}
      <h3 className="mb-2 text-sm font-semibold">Hoje, por tipo</h3>
      {total.length ? (
        <dl className="grid grid-cols-[1fr_auto_auto] gap-x-4 gap-y-1 text-sm">
          {total.map(([tipo, min]) => {
            const limite = limiteDaPausa(tipo, limites);
            return [
              <dt key={`${tipo}-t`}>{tipo}</dt>,
              <dd key={`${tipo}-l`} className="text-right text-slate-500 dark:text-slate-400">{limite != null ? `limite ${limite} min` : 'sem limite'}</dd>,
              <dd key={`${tipo}-v`} className="text-right font-semibold tabular-nums">{minutos(min)}</dd>,
            ];
          })}
        </dl>
      ) : <p className="text-sm text-slate-500 dark:text-slate-400">Nenhuma pausa registrada hoje.</p>}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Limites: {Object.entries(limites).map(([k, v]) => `${k} ${v} min`).join(', ') || 'nenhum'} (src/config/pausas.js). O total conta enquanto o BenURA está rodando.
      </p>
    </Cartao>
  );
}

export function Receptivo() {
  const { data: v } = useVisao();
  const { data: m } = useMetricasHoje();
  const agora = useAgora();
  const r = v?.servicos.rodizio.dados;
  if (!v) return <Esqueleto className="h-96 w-full" />;
  if (!r) return <Cartao titulo="Receptivo URA"><Vazio>O rodízio não está respondendo (ou a automação está desligada). Veja a aba Serviços.</Vazio></Cartao>;

  const humanos = (r.uraAgora ?? []).filter((u) => !u.virtual);
  const naUra = humanos.filter((u) => u.classe && u.classe !== 'offline').length;
  const livres = humanos.filter((u) => u.classe === 'livre').length;
  const pausa = humanos.filter((u) => u.classe === 'outro').length;
  const espera = r.termometro?.esperaSeg ?? m?.esperaLivresSeg ?? null;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Receptivo URA</h1>
          <StatusUra />
          {r.retencaoAtivo?.ativa && (
            <Selo tom="alerta">Todos no Ativo desde {horaCurta(r.retencaoAtivo.desde)}{r.retencaoAtivo.por ? ` · ${r.retencaoAtivo.por}` : ''}</Selo>
          )}
        </div>
        <AlocarTodosNoAtivo r={r} />
      </div>
      <div className="mb-5 grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
        <Resumo rotulo="Humanos na URA" valor={naUra} Icone={Users} nota={`${humanos.filter((u) => u.fixo).length} fixo(s)`} />
        <Resumo rotulo="Livres" valor={livres} Icone={UserCheck} />
        <Resumo rotulo="Em pausa" valor={pausa} Icone={Coffee} />
        <Resumo rotulo="Em fila agora" valor={m?.emFilaAgora ?? '–'} Icone={PhoneIncoming}
          dica="A API da Argus não informa quantas ligações estão na fila em tempo real (só o painel deles). Aparece quando houver essa fonte."
          nota={m?.filaClienteMediaSeg != null ? `cliente esperou ${m.filaClienteMediaSeg} s em média hoje` : 'sem dado da Argus'} />
        <Resumo rotulo="Tempo de espera atual" valor={espera != null ? `${espera} s` : '–'} Icone={Hourglass}
          dica="Quanto tempo, em média, os humanos livres esperam por uma ligação (últimos 5 min). É o que move o status automático da URA."
          nota={r.termometro ? `${r.termometro.atendimentos} atendimento(s) em ${r.termometro.janelaMin} min` : undefined} />
        <Resumo rotulo="Leads Derivados Hoje" valor={<span className="text-emerald-700 dark:text-emerald-400">{m?.leadsDerivadosHoje ?? '–'}</span>} Icone={PhoneForwarded}
          dica={DEFINICOES.leads} nota={`${m?.transbordosHoje ?? '–'} transbordo(s) hoje`} />
      </div>
      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <Operadores ura={r.uraAgora ?? []} agora={agora} />
        <Pausas r={r} agora={agora} />
      </div>
      <div className="mt-5 grid gap-5">
        <NoAtivo lista={r.noAtivo ?? []} />
        <RelatorioPessoal lista={r.relatorio?.porAtendente} limites={r.pausasLimitesMin} />
      </div>
    </>
  );
}
