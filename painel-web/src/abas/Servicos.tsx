import { clsx } from 'clsx';
import { Power, PowerOff, Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { EFEITO_DESLIGADO, NOMES_DOS_COMPONENTES, useComponente, useDia, useSimulacao, useVisao } from '../dados';
import { FlaskConical } from 'lucide-react';
import { Botao } from '../ui/base';
import { useRetorno } from '../ui/retorno';
import { duracao, horaCurta } from '../formatos';
import type { Componente, Servico, Visao } from '../tipos';
import { Cartao, Esqueleto, Segmentado, Selo, Vazio } from '../ui/base';
import { GerenciarUsuarios } from '../componentes/Usuarios';
import { ConfiguracaoEmUso } from '../componentes/ConfiguracaoEmUso';
import { AvisosBenhub } from '../componentes/AvisosBenhub';
import { ClientesWebhook } from '../componentes/ClientesWebhook';
import { CartaoDoisPcs } from '../componentes/DoisPcs';
import { semAcesso, usePode } from '../sessao';

/** [NOVO] Ligar ou desligar só este componente (administrador), com o efeito na confirmação. */
function LigaDesliga({ v, app }: { v: Visao; app: Componente }) {
  const mutacao = useComponente();
  const admin = usePode('administrador');
  const { confirmar } = useRetorno();
  const a = v.automacao;
  const desligado = Boolean(a?.componentes?.[app]);
  const nome = NOMES_DOS_COMPONENTES[app];
  const ocupado = mutacao.isPending || !['ligada', 'desligada'].includes(a?.estado ?? 'ligada');
  const trocar = async () => {
    const ok = await confirmar(desligado
      ? { titulo: `Ligar o ${nome}?`, texto: a?.estado === 'desligada' ? `A automação está desligada: o ${nome} sobe quando ela for religada.` : `O ${nome} volta a funcionar em alguns segundos.`, confirmar: `Ligar o ${nome}` }
      : { titulo: `Desligar só o ${nome}?`, texto: `${EFEITO_DESLIGADO[app]} Fica desligado (mesmo se o PC reiniciar ou a agenda religar) até alguém clicar em "Ligar".`, confirmar: `Desligar o ${nome}`, perigo: true });
    if (ok) mutacao.mutate({ app, ligar: desligado });
  };
  return (
    <Botao variante={desligado ? 'primario' : 'secundario'} className="min-h-8 justify-self-start px-3 py-1" carregando={mutacao.isPending} disabled={ocupado}
      semAcesso={admin ? null : semAcesso('administrador')} icone={desligado ? <Power className="size-4" aria-hidden /> : <PowerOff className="size-4" aria-hidden />} onClick={trocar}>
      {desligado ? `Ligar o ${nome}` : 'Desligar'}
    </Botao>
  );
}

function CartaoServico({ s, linhas, opcional, parado, desligadoAMao, acao }: {
  s: Servico<{ uptime?: number }>; linhas: [string, string][]; opcional?: boolean; parado?: boolean;
  desligadoAMao?: { desde: string | null; por: string | null }; acao?: ReactNode;
}) {
  const todas: [string, string][] = [['Resposta', s.online ? `${s.ms} ms` : '–'], ['No ar há', s.dados?.uptime != null ? duracao(s.dados.uptime) : '–'], ...(s.online ? linhas : [])];
  return (
    <div className="cartao grid content-start gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold">{s.nome}</h2>
        {(parado || desligadoAMao) && !s.online
          ? <Selo tom={desligadoAMao ? 'alerta' : 'neutro'}>desligado pelo painel</Selo>
          : <Selo tom={s.online ? 'ok' : opcional ? 'neutro' : 'perigo'} pulsar={!s.online && !opcional}>{s.online ? 'no ar' : 'fora do ar'}</Selo>}
      </div>
      {desligadoAMao && (
        <p className="text-xs text-amber-800 dark:text-amber-200">
          Desligado sozinho{desligadoAMao.desde ? ` às ${horaCurta(desligadoAMao.desde)}` : ''}{desligadoAMao.por ? ` por ${desligadoAMao.por}` : ''}.
        </p>
      )}
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {todas.map(([k, v]) => [<dt key={`${k}-t`} className="text-slate-500 dark:text-slate-400">{k}</dt>, <dd key={`${k}-d`} className="text-right tabular-nums">{v}</dd>])}
      </dl>
      {acao}
    </div>
  );
}

function Cartoes({ v }: { v: Visao }) {
  const { roteador, rodizio, rotinas, atualizador } = v.servicos;
  const r = rodizio.dados;
  const argusOk = v.argus.respondendo && !v.argus.tokenRecusado;
  const ultimoCiclo = v.argus.cicloUraHaSeg == null ? '–' : `${duracao(v.argus.cicloUraHaSeg)} atrás`;
  const parado = v.automacao?.estado === 'desligada';
  const comp = v.automacao?.componentes ?? {};
  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <CartaoServico parado={parado} desligadoAMao={comp['benura-roteador']} acao={<LigaDesliga v={v} app="benura-roteador" />} s={roteador}
        linhas={[['Carga do dia', roteador.dados?.cargaInicialFeita ? 'feita' : 'pendente'], ['Última leitura de vendas', horaCurta(roteador.dados?.ultimoMonitoramento)]]} />
      <CartaoServico parado={parado} desligadoAMao={comp['benura-rodizio']} acao={<LigaDesliga v={v} app="benura-rodizio" />} s={rodizio}
        linhas={[['Último ciclo da URA', ultimoCiclo], ['Modo dos robôs', r?.robos?.modo === 'panico' ? 'pânico' : 'automático'], ['DRY_RUN', r?.dryRun ? 'ligado (simulação)' : 'desligado']]} />
      <CartaoServico parado={parado} desligadoAMao={comp['benura-rotinas']} acao={<LigaDesliga v={v} app="benura-rotinas" />} s={rotinas}
        linhas={[['Última execução', horaCurta(rotinas.dados?.ultimaExecucao)]]} />
      {atualizador && <CartaoServico s={atualizador} linhas={[]} opcional />}
      <div className="cartao grid content-start gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-semibold">Argus (discadora)</h2>
          {parado
            ? <Selo tom="neutro">automação desligada</Selo>
            : <Selo tom={argusOk ? 'ok' : 'perigo'} pulsar={!argusOk}>{v.argus.tokenRecusado ? 'token recusado' : argusOk ? 'respondendo' : 'sem resposta'}</Selo>}
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-slate-500 dark:text-slate-400">Último ciclo</dt><dd className="text-right tabular-nums">{ultimoCiclo}</dd>
          <dt className="text-slate-500 dark:text-slate-400">Fixos na URA</dt><dd className="text-right tabular-nums">{r ? (r.fixosPermanentes ?? []).length : '–'}</dd>
        </dl>
      </div>
    </div>
  );
}

/** Botão "Modo simulação" (DRY_RUN). */
function Simulacao({ v }: { v: Visao }) {
  const mutacao = useSimulacao();
  const admin = usePode('administrador');
  const { confirmar } = useRetorno();
  const s = v.automacao?.simulacao;
  const ativa = Boolean(v.servicos.rodizio.dados?.dryRun);
  const ligada = Boolean(s?.escolhida || s?.fixaPeloEnv);
  // Desligando, religando ou reiniciando: espera terminar.
  const ocupado = mutacao.isPending || ['desligando', 'religando', 'reiniciando'].includes(v.automacao?.estado ?? '');
  const trocar = async () => {
    const ligar = !ligada;
    const ok = await confirmar(ligar
      ? { titulo: 'Ligar o modo simulação?', texto: 'O BenURA continua lendo a Argus e mostrando o que faria, mas não move ninguém nem mexe nos robôs. Os serviços reiniciam em alguns segundos.', confirmar: 'Ligar simulação' }
      : { titulo: 'Voltar a agir de verdade?', texto: 'O BenURA volta a mover operadores e a desligar robôs (pânico). Os serviços reiniciam em alguns segundos.', confirmar: 'Agir de verdade', perigo: true });
    if (ok) mutacao.mutate(ligar);
  };
  return (
    <section id="simulacao" className="cartao mb-5 flex flex-wrap items-center gap-4 p-4">
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-amarelo-100 text-amber-800 dark:bg-amber-950 dark:text-amber-200"><FlaskConical className="size-5" aria-hidden /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Modo simulação (DRY_RUN)</h2>
          {s?.fixaPeloEnv ? <Selo tom="alerta">fixa pelo .env</Selo> : <Selo tom={ligada ? 'alerta' : 'ok'}>{ligada ? 'ligada' : 'desligada: agindo de verdade'}</Selo>}
          {ligada !== ativa && v.servicos.rodizio.online && <Selo tom="neutro">reinicie para valer</Selo>}
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          {s?.fixaPeloEnv
            ? 'DRY_RUN=1 no .env do PC: para agir de verdade, troque para DRY_RUN=0 e reinicie (npx pm2 restart all).'
            : ligada
              ? `O BenURA só mostra o que faria, sem mexer na Argus${s?.desde ? ` · ligada às ${horaCurta(s.desde)}${s.por ? ` por ${s.por}` : ''}` : ''}.`
              : 'Ligada, o BenURA continua lendo a Argus e mostrando o que faria, mas não move ninguém nem mexe nos robôs.'}
        </p>
      </div>
      {!s?.fixaPeloEnv && (
        <Botao variante={ligada ? 'perigo' : 'secundario'} carregando={mutacao.isPending} disabled={ocupado} semAcesso={admin ? null : semAcesso('administrador')} onClick={trocar}>
          {ligada ? 'Voltar a agir de verdade' : 'Ligar simulação'}
        </Botao>
      )}
    </section>
  );
}

function Avisos() {
  const { data: dia, isLoading } = useDia();
  const [nivel, setNivel] = useState<'todos' | 'ERRO'>('todos');
  const [servico, setServico] = useState('todos');
  const [busca, setBusca] = useState('');
  const avisos = dia?.avisos ?? [];
  const servicos = [...new Set(avisos.map((a) => a.servico))];
  const lista = avisos.filter((a) => (nivel === 'todos' || a.nivel === nivel) && (servico === 'todos' || a.servico === servico)
    && (!busca || a.texto.toLowerCase().includes(busca.toLowerCase())));
  return (
    <Cartao titulo="Avisos de hoje" extra={(
      <>
        <label className="relative">
          <span className="sr-only">Buscar nos avisos</span>
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
          <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="Buscar"
            className="w-36 rounded-lg border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-sm dark:border-noite-600 dark:bg-noite-950" />
        </label>
        {servicos.length > 1 && (
          <select value={servico} onChange={(e) => setServico(e.target.value)} aria-label="Filtrar por serviço"
            className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm dark:border-noite-600 dark:bg-noite-950">
            <option value="todos">Todos os serviços</option>
            {servicos.map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        )}
        <Segmentado rotulo="Nível" valor={nivel} aoMudar={setNivel} opcoes={[{ valor: 'todos', texto: 'Todos' }, { valor: 'ERRO', texto: 'Só erros' }]} />
      </>
    )}>
      {isLoading ? <Esqueleto className="h-32 w-full" /> : lista.length ? (
        <ol className="max-h-[520px] divide-y divide-slate-100 overflow-y-auto pr-1 text-sm dark:divide-noite-800">
          {lista.map((a, i) => (
            <li key={`${a.hora}-${i}`} className="grid grid-cols-[64px_1fr] gap-x-3 gap-y-0.5 py-2 sm:grid-cols-[70px_96px_1fr]">
              <span className="tabular-nums text-slate-500 dark:text-slate-400">{a.hora}</span>
              <span className="font-semibold text-slate-600 dark:text-slate-300">{a.servico}</span>
              <span className={clsx('col-span-2 sm:col-span-1', a.nivel === 'ERRO' && 'text-red-700 dark:text-red-400')}>
                {a.nivel === 'ERRO' && <b>Erro · </b>}{a.texto}
              </span>
            </li>
          ))}
        </ol>
      ) : <Vazio>{avisos.length ? 'Nenhum aviso com esse filtro.' : 'Nenhum aviso hoje.'}</Vazio>}
    </Cartao>
  );
}

export function Servicos() {
  const { data: v } = useVisao();
  const admin = usePode('administrador');
  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Serviços</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          O BenURA roda no PC do expediente (PM2). Fora do ar: <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs dark:bg-noite-800">npx pm2 status</code> e <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs dark:bg-noite-800">npx pm2 logs</code>.
        </p>
      </div>
      {v?.doisPcs && <CartaoDoisPcs v={v} />}
      {v ? <Cartoes v={v} /> : <Esqueleto className="mb-5 h-32 w-full" />}
      {admin && <GerenciarUsuarios />}
      {admin && v && <AvisosBenhub v={v} />}
      {admin && <ClientesWebhook />}
      {admin && <ConfiguracaoEmUso />}
      {v && <Simulacao v={v} />}
      <Avisos />
    </>
  );
}
