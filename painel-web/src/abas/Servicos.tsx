import { clsx } from 'clsx';
import { Search } from 'lucide-react';
import { useState } from 'react';
import { useDia, useVisao } from '../dados';
import { duracao, horaCurta } from '../formatos';
import type { Servico, Visao } from '../tipos';
import { Cartao, Esqueleto, Segmentado, Selo, Vazio } from '../ui/base';

function CartaoServico({ s, linhas, opcional }: { s: Servico<{ uptime?: number }>; linhas: [string, string][]; opcional?: boolean }) {
  const todas: [string, string][] = [['Resposta', s.online ? `${s.ms} ms` : '–'], ['No ar há', s.dados?.uptime != null ? duracao(s.dados.uptime) : '–'], ...(s.online ? linhas : [])];
  return (
    <div className="cartao grid content-start gap-3 p-4">
      <div className="flex items-start justify-between gap-2">
        <h2 className="font-semibold">{s.nome}</h2>
        <Selo tom={s.online ? 'ok' : opcional ? 'neutro' : 'perigo'} pulsar={!s.online && !opcional}>{s.online ? 'no ar' : 'fora do ar'}</Selo>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
        {todas.map(([k, v]) => [<dt key={`${k}-t`} className="text-slate-500 dark:text-slate-400">{k}</dt>, <dd key={`${k}-d`} className="text-right tabular-nums">{v}</dd>])}
      </dl>
    </div>
  );
}

function Cartoes({ v }: { v: Visao }) {
  const { roteador, rodizio, rotinas, atualizador } = v.servicos;
  const r = rodizio.dados;
  const argusOk = v.argus.respondendo && !v.argus.tokenRecusado;
  const ultimoCiclo = v.argus.cicloUraHaSeg == null ? '–' : `${duracao(v.argus.cicloUraHaSeg)} atrás`;
  return (
    <div className="mb-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <CartaoServico s={roteador} linhas={[['Carga do dia', roteador.dados?.cargaInicialFeita ? 'feita' : 'pendente'], ['Última leitura de vendas', horaCurta(roteador.dados?.ultimoMonitoramento)]]} />
      <CartaoServico s={rodizio} linhas={[['Último ciclo da URA', ultimoCiclo], ['Modo dos robôs', r?.robos?.modo === 'panico' ? 'pânico' : 'automático'], ['DRY_RUN', r?.dryRun ? 'ligado (simulação)' : 'desligado']]} />
      <CartaoServico s={rotinas} linhas={[['Última execução', horaCurta(rotinas.dados?.ultimaExecucao)]]} />
      {atualizador && <CartaoServico s={atualizador} linhas={[]} opcional />}
      <div className="cartao grid content-start gap-3 p-4">
        <div className="flex items-start justify-between gap-2">
          <h2 className="font-semibold">Argus (discadora)</h2>
          <Selo tom={argusOk ? 'ok' : 'perigo'} pulsar={!argusOk}>{v.argus.tokenRecusado ? 'token recusado' : argusOk ? 'respondendo' : 'sem resposta'}</Selo>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-slate-500 dark:text-slate-400">Último ciclo</dt><dd className="text-right tabular-nums">{ultimoCiclo}</dd>
          <dt className="text-slate-500 dark:text-slate-400">Fixos na URA</dt><dd className="text-right tabular-nums">{r ? (r.fixosPermanentes ?? []).length : '–'}</dd>
        </dl>
      </div>
    </div>
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
  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Serviços</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          O BenURA roda no PC do expediente (PM2). Fora do ar: <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs dark:bg-noite-800">npx pm2 status</code> e <code className="rounded bg-slate-200 px-1.5 py-0.5 text-xs dark:bg-noite-800">npx pm2 logs</code>.
        </p>
      </div>
      {v ? <Cartoes v={v} /> : <Esqueleto className="mb-5 h-32 w-full" />}
      <Avisos />
    </>
  );
}
