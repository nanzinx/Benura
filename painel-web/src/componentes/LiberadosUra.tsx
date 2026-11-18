/**
 * [NOVO] Liberados da URA (aba Relatórios): quem pode iniciar na URA hoje (os fixos e quem bateu a
 * meta no último dia com operação) e o comunicado do grupo, gerado sozinho no horário (08:30).
 * As vendas vêm do Carrossel, como no roteador. Gerar, configurar e enviar: supervisor ou administrador.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Copy, Crown, RefreshCw, Send, Settings2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';
import { useLiberadosUra } from '../dados';
import { agoraEmSegundos, dataBr, reais } from '../formatos';
import {
  contagem, contarPorStatus, corDoAvatar, diasDeOperacao, faltaAte, filtrarRanking, iniciais, larguraBarra, pctInteiro, reaisInteiros, textoDiferenca, type FiltroRanking,
} from '../liberados-ura';
import { semAcesso, usePode } from '../sessao';
import type { RegistroLiberados, ResumoLiberados, VendedorLiberados } from '../tipos';
import { Botao, Esqueleto, Segmentado, Vazio } from '../ui/base';
import { useRetorno } from '../ui/retorno';

const AVATARES = [
  'bg-azul-100 text-azul-700 dark:bg-noite-700 dark:text-azul-300',
  'bg-rose-100 text-rose-700 dark:bg-rose-950 dark:text-rose-300',
  'bg-violet-100 text-violet-700 dark:bg-violet-950 dark:text-violet-300',
  'bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300',
];
const HORA_DO_COMUNICADO = '09:00';

export function LiberadosUra() {
  const [data, setData] = useState<string | null>(null);
  const { data: r, isLoading, error } = useLiberadosUra(data);
  if (isLoading) return <section className="cartao mb-5"><Esqueleto className="h-40 w-full" /></section>;
  if (error || !r) return <section className="cartao mb-5"><Vazio>Liberados da URA indisponível: {error?.message ?? 'sem resposta'}.</Vazio></section>;
  return <Conteudo r={r} aoEscolher={(d) => setData(d === r.hoje ? null : d)} />;
}

function Conteudo({ r, aoEscolher }: { r: ResumoLiberados; aoEscolher: (dia: string) => void }) {
  const reg = r.registro;
  return (
    <section id="liberados-ura" className="mb-5 overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm dark:border-noite-700 dark:bg-noite-900">
      <Cabecalho r={r} reg={reg} />
      <Ferramentas r={r} aoEscolher={aoEscolher} />
      {!reg ? (
        <div className="p-4"><Vazio>Ainda não gerado para {dataBr(r.dia)}. Sai sozinho às {r.config.horario} ({diasDeOperacao(r.config.diasOperacao)}).</Vazio></div>
      ) : !reg.ok ? (
        <div className="p-4">
          <p className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">
            <b>Sem comunicado para {dataBr(reg.diaUra)}.</b> {reg.motivo}
            <span className="mt-1 block text-xs opacity-80">Tentativa de {new Date(reg.geradoEm).toLocaleString('pt-BR')} ({reg.por}). A agenda tenta de novo a cada 10 min até o meio-dia.</span>
          </p>
        </div>
      ) : (
        <div className="grid items-start gap-5 p-4 lg:grid-cols-[minmax(0,1.35fr)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-5">
            <Liberados reg={reg} />
            <Ranking reg={reg} />
          </div>
          <Comunicado r={r} reg={reg} />
        </div>
      )}
    </section>
  );
}

function Cabecalho({ r, reg }: { r: ResumoLiberados; reg: RegistroLiberados | null }) {
  const meta = reg?.meta ?? r.config.meta;
  const ok = reg?.ok ? reg : null;
  return (
    <div className="relative bg-gradient-to-br from-azul-600 to-azul-700 px-5 pt-5 pb-6 text-white after:absolute after:inset-x-0 after:bottom-0 after:h-1 after:bg-amarelo-500 dark:from-marinho-800 dark:to-marinho-900">
      <p className="flex items-center gap-2 text-xs font-semibold tracking-wider uppercase opacity-85">
        <span className="size-2 rounded-full bg-amarelo-500 shadow-[0_0_0_4px_rgba(245,184,0,.25)]" aria-hidden />
        URA de {dataBr(r.dia)}{reg ? ` · vendas de ${dataBr(reg.diaVendas)}` : ''}
      </p>
      <h2 className="mt-2 text-2xl font-bold tracking-tight sm:text-3xl">Liberados da <span className="text-amarelo-500">URA</span></h2>
      <p className="mt-1 max-w-[62ch] text-sm opacity-90">
        Iniciam na URA os fixos e quem fez <b className="rounded bg-white/15 px-1.5">{reaisInteiros(meta)}</b> ou mais em ANDAMENTO no último dia com operação.
      </p>
      <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
        <Kpi rotulo="Na URA hoje" valor={ok ? String(ok.liberados?.length ?? 0) : '–'} detalhe={ok ? `${ok.fixosNaUra} fixo(s) + ${ok.pelaMeta} pela meta` : 'sem dados'} />
        <Kpi rotulo="Bateram a meta" valor={ok ? `${ok.bateram?.length ?? 0}` : '–'} detalhe={ok ? `de ${ok.ranking?.length ?? 0} no ranking` : '–'} />
        <Kpi rotulo="Total vendido" valor={ok ? reais(ok.total ?? 0) : '–'} detalhe={ok ? `em ${dataBr(ok.diaVendas)}` : '–'} className="col-span-2 sm:col-span-1" />
      </div>
    </div>
  );
}

function Kpi({ rotulo, valor, detalhe, className }: { rotulo: string; valor: string; detalhe: string; className?: string }) {
  return (
    <div className={clsx('min-w-0 rounded-xl border border-white/15 bg-white/10 px-3 py-2.5', className)}>
      <small className="block truncate text-[11px] tracking-wide uppercase opacity-80">{rotulo}</small>
      <strong className="block truncate text-lg font-bold tabular-nums sm:text-2xl">{valor}</strong>
      <span className="block text-xs opacity-80">{detalhe}</span>
    </div>
  );
}

function Ferramentas({ r, aoEscolher }: { r: ResumoLiberados; aoEscolher: (dia: string) => void }) {
  const pode = usePode('supervisor');
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  const [diaGerar, setDiaGerar] = useState(r.dia);
  const [configurando, setConfigurando] = useState(false);
  useEffect(() => setDiaGerar(r.dia), [r.dia]);
  const atualizar = (novo: ResumoLiberados) => {
    cliente.setQueryData(['liberados-ura', novo.dia === novo.hoje ? null : novo.dia], novo);
    cliente.invalidateQueries({ queryKey: ['liberados-ura'] });
  };
  const gerar = useMutation({
    mutationFn: () => api.gerarLiberados(diaGerar),
    onSuccess: (novo) => {
      atualizar(novo);
      aoEscolher(novo.dia);
      avisar(novo.registro?.ok ? 'ok' : 'erro', novo.registro?.ok ? `Gerado para ${dataBr(novo.dia)}.` : `Sem comunicado: ${novo.registro?.motivo ?? 'sem dados'}`);
    },
    onError: (e: Error) => avisar('erro', e.message),
  });
  const datas = r.datas.includes(r.hoje) ? r.datas : [r.hoje, ...r.datas];
  return (
    <div className="border-b border-slate-200 px-4 py-3 dark:border-noite-700">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="flex items-center gap-2">
          <span className="text-slate-500 dark:text-slate-400">Histórico</span>
          <select value={r.dia} onChange={(e) => aoEscolher(e.target.value)}
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 dark:border-noite-600 dark:bg-noite-900">
            {datas.map((d) => <option key={d} value={d}>{dataBr(d)}{d === r.hoje ? ' (hoje)' : ''}</option>)}
          </select>
        </label>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <input type="date" value={diaGerar} max={r.hoje} onChange={(e) => setDiaGerar(e.target.value)} aria-label="Dia da URA para gerar"
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 dark:border-noite-600 dark:bg-noite-900" />
          <Botao variante="secundario" icone={<RefreshCw className="size-4" aria-hidden />} carregando={gerar.isPending} semAcesso={pode ? null : semAcesso('supervisor')}
            disabled={!diaGerar} onClick={() => gerar.mutate()}>Gerar agora</Botao>
          <Botao variante="fantasma" icone={<Settings2 className="size-4" aria-hidden />} semAcesso={pode ? null : semAcesso('supervisor')}
            aria-expanded={configurando} onClick={() => setConfigurando(!configurando)}>Configurar</Botao>
        </span>
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Sai sozinho às {r.config.horario} ({diasDeOperacao(r.config.diasOperacao)}); o dia anterior é o último dia com operação (na segunda, o sábado).
        Meta {reaisInteiros(r.config.meta)} · fixos: {r.config.fixos}.
      </p>
      {configurando && pode && <Configurar r={r} aoSalvar={(novo) => { atualizar(novo); setConfigurando(false); }} />}
    </div>
  );
}

function Configurar({ r, aoSalvar }: { r: ResumoLiberados; aoSalvar: (novo: ResumoLiberados) => void }) {
  const { avisar } = useRetorno();
  const [meta, setMeta] = useState(String(r.config.meta));
  const [fixos, setFixos] = useState(r.config.fixos);
  const [horario, setHorario] = useState(r.config.horario);
  const salvar = useMutation({
    mutationFn: () => api.configLiberados({ meta: Number(meta), fixos, horario, data: r.dia }),
    onSuccess: (novo) => { avisar('ok', 'Configuração salva. Vale a partir da próxima geração.'); aoSalvar(novo); },
    onError: (e: Error) => avisar('erro', e.message),
  });
  const campo = 'rounded-lg border border-slate-300 bg-white px-2 py-1.5 dark:border-noite-600 dark:bg-noite-900';
  return (
    <form className="mt-3 grid gap-3 rounded-xl bg-slate-50 p-3 text-sm sm:grid-cols-[10rem_minmax(0,1fr)_7rem_auto] sm:items-end dark:bg-noite-800"
      onSubmit={(e) => { e.preventDefault(); salvar.mutate(); }}>
      <label className="grid gap-1"><span className="text-xs font-semibold">Meta (R$)</span>
        <input className={campo} inputMode="numeric" value={meta} onChange={(e) => setMeta(e.target.value.replace(/[^\d]/g, ''))} /></label>
      <label className="grid gap-1"><span className="text-xs font-semibold">Fixos (vírgula; observação entre parênteses)</span>
        <input className={campo} value={fixos} onChange={(e) => setFixos(e.target.value)} /></label>
      <label className="grid gap-1"><span className="text-xs font-semibold">Horário</span>
        <input className={campo} type="time" value={horario} onChange={(e) => setHorario(e.target.value)} /></label>
      <Botao type="submit" carregando={salvar.isPending} disabled={!(Number(meta) > 0)}>Salvar</Botao>
    </form>
  );
}

function Painel({ titulo, contador, descricao, extra, children }: { titulo: string; contador?: number; descricao?: ReactNode; extra?: ReactNode; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl border border-slate-200 bg-white dark:border-noite-700 dark:bg-noite-900">
      <header className="flex flex-wrap items-center justify-between gap-3 px-4 pt-4 pb-2">
        <h3 className="flex items-center gap-2 text-base font-semibold">
          {titulo}
          {contador != null && <span className="grid h-6 min-w-6 place-items-center rounded-full bg-azul-600 px-2 text-xs font-bold text-white dark:bg-azul-500">{contador}</span>}
        </h3>
        {extra}
        {descricao && <p className="w-full text-xs text-slate-500 dark:text-slate-400">{descricao}</p>}
      </header>
      {children}
    </div>
  );
}

function Liberados({ reg }: { reg: RegistroLiberados }) {
  const lista = reg.liberados ?? [];
  return (
    <Painel titulo="Na URA hoje" contador={lista.length} descricao={`Fixos e quem bateu ${reaisInteiros(reg.meta)} em ${dataBr(reg.diaVendas)}. Fonte: ${reg.origem ?? 'Carrossel'}.`}>
      <ul className="flex flex-col gap-2.5 px-3.5 pb-4">
        {lista.map((p) => <CardPessoa key={p.nome} p={p} coroa={p.nome === reg.coroa && p.valor > 0} />)}
      </ul>
    </Painel>
  );
}

function CardPessoa({ p, coroa }: { p: VendedorLiberados; coroa: boolean }) {
  return (
    <li className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3.5 gap-y-1 overflow-hidden rounded-xl border border-slate-200 px-3.5 pt-3 pb-3.5 transition hover:-translate-y-px hover:border-azul-500 dark:border-noite-700">
      <span className={clsx('relative row-span-2 grid size-11 place-items-center rounded-full text-sm font-bold', AVATARES[corDoAvatar(p.nome)])}>
        {iniciais(p.nome)}
        {coroa && (
          <span className="absolute -top-1.5 -right-1.5 grid size-5.5 place-items-center rounded-full border-2 border-white bg-amarelo-500 dark:border-noite-900" title="Maior venda do dia">
            <Crown className="size-3 fill-amber-900 text-amber-900" aria-label="Maior venda" />
          </span>
        )}
      </span>
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 font-bold">
        <span className="min-w-0 break-words">{p.nome}</span>
        {p.fixo && <Etiqueta tom="azul">fixo{p.fixo.obs ? ` · ${p.fixo.obs}` : ''}</Etiqueta>}
        {p.bateu && <Etiqueta tom="verde">bateu</Etiqueta>}
      </span>
      <span className={clsx('text-right font-bold whitespace-nowrap tabular-nums', p.valor > 0 ? 'text-emerald-700 dark:text-emerald-400' : 'text-slate-400')}>{p.semVenda ? 'sem venda' : reais(p.valor)}</span>
      <span className="col-span-2 col-start-2 flex flex-wrap justify-between gap-x-3 text-xs text-slate-500 dark:text-slate-400">
        <span>{p.bateu ? 'Bateu a meta' : p.fixo ? 'Fixo: entra mesmo sem bater' : ''}</span>
        <span className="whitespace-nowrap">
          {pctInteiro(p.pct)} · <b className={p.diferenca >= 0 ? 'font-semibold text-emerald-700 dark:text-emerald-400' : 'font-semibold text-amber-700 dark:text-amber-400'}>{textoDiferenca(p.diferenca)}</b>
        </span>
      </span>
      <span className="col-span-3 mt-1.5 h-1.5 overflow-hidden rounded-full bg-slate-100 dark:bg-noite-800">
        <span className={clsx('block h-full rounded-full', p.bateu ? 'bg-emerald-600 dark:bg-emerald-400' : 'bg-amber-500')} style={{ width: `${larguraBarra(p.pct)}%` }} />
      </span>
    </li>
  );
}

function Etiqueta({ tom, children }: { tom: 'azul' | 'verde'; children: ReactNode }) {
  return (
    <span className={clsx('shrink-0 rounded-md px-1.5 py-0.5 text-[11px] font-semibold',
      tom === 'azul' ? 'bg-azul-50 text-azul-700 dark:bg-noite-800 dark:text-azul-300' : 'bg-emerald-50 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300')}>
      {children}
    </span>
  );
}

function Ranking({ reg }: { reg: RegistroLiberados }) {
  const [filtro, setFiltro] = useState<FiltroRanking>('todos');
  const ranking = reg.ranking ?? [];
  const n = contarPorStatus(ranking);
  const lista = filtrarRanking(ranking, filtro);
  // A escala vai até o maior % (no mínimo a meta): a linha da meta fica onde 100% cai.
  const escala = Math.max(100, ...ranking.map((r) => r.pct));
  const linhaMeta = (100 / escala) * 100;
  return (
    <Painel titulo="Ranking completo" contador={ranking.length} descricao={`Total ${reais(reg.total ?? 0)} · quase lá = 80% da meta ou mais.`}
      extra={<Segmentado rotulo="Filtrar o ranking" valor={filtro} aoMudar={setFiltro} opcoes={[
        { valor: 'todos', texto: `Todos ${n.todos}` }, { valor: 'bateu', texto: `Bateram ${n.bateu}` },
        { valor: 'quase', texto: `Quase lá ${n.quase}` }, { valor: 'abaixo', texto: `Abaixo ${n.abaixo}` },
      ]} />}>
      {lista.length === 0 ? <div className="px-4 pb-4"><Vazio>Ninguém neste filtro.</Vazio></div> : (
        <ol className="px-4 pb-4">
          {lista.map((p) => (
            <li key={p.nome} className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-3 border-t border-slate-100 py-2 first:border-t-0 dark:border-noite-800">
              <span className="text-xs font-semibold text-slate-400 tabular-nums">{ranking.indexOf(p) + 1}º</span>
              <span className="min-w-0">
                <span className="flex flex-wrap items-center gap-x-2 text-sm font-semibold">
                  <span className="min-w-0 break-words">{p.nome}</span>
                  {p.fixo && <Etiqueta tom="azul">fixo</Etiqueta>}
                </span>
                <span className="relative mt-1 block h-1.5 rounded-full bg-slate-100 dark:bg-noite-800">
                  <span className={clsx('block h-full rounded-full', p.status === 'bateu' ? 'bg-emerald-600 dark:bg-emerald-400' : p.status === 'quase' ? 'bg-amber-500' : 'bg-slate-400 dark:bg-slate-500')}
                    style={{ width: `${(Math.max(0, p.pct) / escala) * 100}%` }} />
                  <span className="absolute -top-1 -bottom-1 w-0.5 rounded bg-amarelo-500" style={{ left: `${linhaMeta}%` }} title={`Meta ${reaisInteiros(reg.meta)}`} />
                </span>
              </span>
              <span className="text-right text-sm whitespace-nowrap tabular-nums">
                <b>{reais(p.valor)}</b>
                <span className="block text-xs text-slate-500 dark:text-slate-400">{pctInteiro(p.pct)}{p.status === 'quase' ? ` · ${textoDiferenca(p.diferenca)}` : ''}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
    </Painel>
  );
}

/** "*negrito*" do WhatsApp vira <strong>. */
function textoWhatsapp(texto: string) {
  return texto.split(/(\*[^*\n]+\*)/g).map((parte, i) => (parte.startsWith('*') && parte.endsWith('*') && parte.length > 2 ? <strong key={i}>{parte.slice(1, -1)}</strong> : parte));
}

function useContagem(ativo: boolean) {
  const [seg, setSeg] = useState(() => faltaAte(agoraEmSegundos(), HORA_DO_COMUNICADO));
  useEffect(() => {
    if (!ativo) return undefined;
    const t = setInterval(() => setSeg(faltaAte(agoraEmSegundos(), HORA_DO_COMUNICADO)), 1000);
    return () => clearInterval(t);
  }, [ativo]);
  return seg;
}

function Comunicado({ r, reg }: { r: ResumoLiberados; reg: RegistroLiberados }) {
  const { avisar, confirmar } = useRetorno();
  const pode = usePode('supervisor');
  const [copiado, setCopiado] = useState(false);
  const deHoje = reg.diaUra === r.hoje;
  const falta = useContagem(deHoje);
  const enviar = useMutation({
    mutationFn: () => api.enviarLiberados(reg.diaUra),
    onSuccess: (e) => avisar(e.ok ? 'ok' : 'erro', e.ok ? 'Comunicado enviado ao grupo do BenHub.' : `Não chegou ao BenHub (${e.erro}).`),
    onError: (e: Error) => avisar('erro', e.message),
  });
  const copiar = async () => {
    try {
      await navigator.clipboard.writeText(reg.texto ?? '');
      setCopiado(true);
      setTimeout(() => setCopiado(false), 2000);
    } catch {
      avisar('erro', 'Não deu para copiar: selecione o texto e copie à mão.');
    }
  };
  const ultimoEnvio = reg.envios?.at(-1);
  return (
    <div className="min-w-0 lg:sticky lg:top-4">
      <Painel titulo="Comunicado do grupo"
        descricao={deHoje ? (falta > 0 ? <>Mandar até {HORA_DO_COMUNICADO}: faltam <b className="tabular-nums">{contagem(falta)}</b>.</> : <>Já passou das {HORA_DO_COMUNICADO}.</>) : `Comunicado de ${dataBr(reg.diaUra)}.`}>
        <div className="mx-4 rounded-xl bg-[#e5ddd5] p-3 dark:bg-[#0b141a]">
          <div className="ml-auto max-w-[95%] rounded-lg rounded-tr-none bg-[#d9fdd3] px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap text-slate-900 shadow-sm dark:bg-[#005c4b] dark:text-slate-50">
            {textoWhatsapp(reg.texto ?? '')}
            <span className="mt-1 block text-right text-[11px] opacity-60">{new Date(reg.geradoEm).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })} ✓✓</span>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 p-4">
          <Botao icone={copiado ? <Check className="size-4" aria-hidden /> : <Copy className="size-4" aria-hidden />} onClick={copiar}>{copiado ? 'Copiado' : 'Copiar'}</Botao>
          {r.envioAoGrupo && (
            <Botao variante="secundario" icone={<Send className="size-4" aria-hidden />} carregando={enviar.isPending} semAcesso={pode ? null : semAcesso('supervisor')}
              onClick={async () => {
                if (await confirmar({ titulo: 'Enviar no BenHub?', texto: `O comunicado de ${dataBr(reg.diaUra)} vai para o grupo da URA no BenHub.`, confirmar: 'Enviar' })) enviar.mutate();
              }}>Enviar no BenHub</Botao>
          )}
        </div>
        <p className="px-4 pb-4 text-xs text-slate-500 dark:text-slate-400">
          Gerado em {new Date(reg.geradoEm).toLocaleString('pt-BR')} por {reg.por}.
          {ultimoEnvio && ` Último envio ao BenHub: ${new Date(ultimoEnvio.em).toLocaleTimeString('pt-BR')} (${ultimoEnvio.ok ? 'ok' : `falhou: ${ultimoEnvio.erro}`}).`}
          {reg.ultimaFalha && ` Última tentativa sem dados: ${new Date(reg.ultimaFalha.em).toLocaleTimeString('pt-BR')}.`}
        </p>
      </Painel>
    </div>
  );
}
