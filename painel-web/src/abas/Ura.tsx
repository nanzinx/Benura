import { Bell, BellRing, Search } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { ComandoUra } from '../api';
import { useComandoUra, useRisco, useVisao } from '../dados';
import { dataBr, horaCurta, motivoLegivel } from '../formatos';
import { ESTADOS_TERMOMETRO, MedidorTermometro, medidaDoTermometro } from '../componentes/Termometro';
import { ativarAvisos, avisosAtivos } from '../notificacoes';
import { Botao, Cartao, Esqueleto, Selo, Vazio, type Tom } from '../ui/base';
import { useRetorno } from '../ui/retorno';

interface Confirmar { titulo: string; texto: ReactNode; perigo?: boolean }

interface PropsInterruptor {
  comando: ComandoUra;
  titulo: string;
  estado: { texto: string; tom: Tom; pulsar?: boolean };
  children: ReactNode;
  ligar: { texto: string; perigo?: boolean; confirmar?: Confirmar };
  desligar: { texto: string; confirmar?: Confirmar };
}

/** Cartão de um interruptor da URA: estado, explicação e os dois botões (com confirmação quando pesa). */
function Interruptor({ comando, titulo, estado, children, ligar, desligar }: PropsInterruptor) {
  const mutacao = useComandoUra(comando);
  const { confirmar } = useRetorno();
  const executar = async (ligado: boolean) => {
    const c = ligado ? ligar.confirmar : desligar.confirmar;
    if (c && !(await confirmar({ ...c, confirmar: ligado ? ligar.texto : desligar.texto }))) return;
    mutacao.mutate(ligado);
  };
  const alvo = mutacao.isPending ? mutacao.variables : null;
  return (
    <Cartao titulo={titulo} extra={<Selo tom={estado.tom} pulsar={estado.pulsar}>{estado.texto}</Selo>} className="flex flex-col">
      <div className="grid flex-1 content-start gap-2 text-sm leading-relaxed">{children}</div>
      <div className="mt-4 flex flex-wrap gap-2">
        <Botao variante={ligar.perigo ? 'perigo' : 'primario'} carregando={alvo === true} disabled={mutacao.isPending} onClick={() => executar(true)}>{ligar.texto}</Botao>
        <Botao variante="secundario" carregando={alvo === false} disabled={mutacao.isPending} onClick={() => executar(false)}>{desligar.texto}</Botao>
      </div>
    </Cartao>
  );
}

function ClientesDeRisco() {
  const { data, isLoading } = useRisco();
  const [busca, setBusca] = useState('');
  const lista = (data?.clientes ?? []).filter((c) => !busca || c.mascara.replace(/\D/g, '').includes(busca.replace(/\D/g, '')));
  return (
    <Cartao titulo="Os 20 clientes de maior risco" extra={(
      <label className="relative">
        <span className="sr-only">Buscar por DDD ou final</span>
        <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-slate-400" aria-hidden />
        <input value={busca} onChange={(e) => setBusca(e.target.value)} placeholder="DDD ou final" inputMode="numeric"
          className="w-36 rounded-lg border border-slate-300 bg-white py-1.5 pr-3 pl-8 text-sm dark:border-noite-600 dark:bg-noite-950" />
      </label>
    )}>
      {isLoading ? <Esqueleto className="h-24 w-full" /> : lista.length ? (
        <div className="overflow-x-auto">
          <table className="tabela">
            <thead><tr><th>Telefone</th><th className="text-right">Callbacks</th><th className="text-right">Atendeu</th><th>Último dia</th><th>Motivo</th></tr></thead>
            <tbody>{lista.map((c) => (
              <tr key={c.mascara + c.ultimoDia}>
                <td className="numero">{c.mascara}</td>
                <td className="numero text-right font-semibold">{c.callbacks}</td>
                <td className="numero text-right">{c.atendeu}</td>
                <td className="numero">{dataBr(c.ultimoDia)}</td>
                <td>{c.motivos.join(', ')}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      ) : <Vazio>{busca ? 'Nenhum cliente com esse número.' : 'Nenhum cliente de risco ainda.'}</Vazio>}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Só o telefone mascarado: o BenURA não guarda o número.</p>
    </Cartao>
  );
}

function BotaoAvisos() {
  const [estado, setEstado] = useState(avisosAtivos() ? 'Som ligado' : '');
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3 dark:border-noite-800">
      <Botao variante="fantasma" icone={estado ? <BellRing className="size-4" /> : <Bell className="size-4" />} onClick={async () => {
        const r = await ativarAvisos();
        setEstado(`Som ligado · notificações ${r.notificacoes === 'granted' ? 'ligadas' : r.notificacoes === 'sem suporte' ? 'sem suporte neste navegador' : 'bloqueadas no navegador'}`);
      }}>Ativar som e notificações</Botao>
      <span className="text-sm text-slate-500 dark:text-slate-400">{estado}</span>
    </div>
  );
}

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
  const p = r.panico;
  const passiva = p?.uraPassiva;
  const cheia = r.uraCheia;
  const risco = v?.alertas;
  const antesDeSair = Math.round((p?.antesDeSairMs ?? 60_000) / 1000);
  const passoFixo = Math.round((p?.fixoReduzirMs ?? 60_000) / 1000);
  const fixoOcioso = Math.round((p?.fixoOciosoMs ?? 180_000) / 60_000);
  const t = r.termometro;
  const auto = p?.passivaAuto;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">URA e robôs</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Quem liga os robôs é a supervisão, pelo painel da Argus. O BenURA só desliga.</p>
      </div>
      <div className="mb-5 grid gap-5 lg:grid-cols-2">
        {p?.modo && (
          <Interruptor comando="panico" titulo="Pânico dos robôs"
            estado={p.ativoAgora ? { texto: p.tipo === 'fixo' ? 'reduzindo robôs' : 'desligando robôs', tom: 'perigo', pulsar: true } : p.ligado ? { texto: 'ligado', tom: 'ok' } : { texto: 'desligado', tom: 'neutro' }}
            ligar={{ texto: 'Ligar pânico', perigo: true }}
            desligar={{ texto: 'Desligar', confirmar: { titulo: 'Desligar o pânico?', texto: 'O BenURA deixa de desligar os robôs quando a URA fica com poucos livres.' } }}>
            <ul className="grid list-disc gap-1.5 pl-5">
              <li><b>Nenhum livre:</b> desliga todos os robôs na hora, inclusive os em ligação.</li>
              <li><b>1 livre:</b> os robôs seguem até <b>{antesDeSair} s</b> antes de ele sair por ociosidade; aí os parados desligam e os em ligação terminam a chamada.</li>
              <li><b>1 livre fixo</b> (equipe do Robson): desliga <b>metade</b> dos robôs ligados e de novo a cada <b>{passoFixo} s</b> (quem está em ligação termina; fica pelo menos 1). Livre há <b>{fixoOcioso} min</b>, ou com a URA passiva (manual ou calma), os robôs seguem até ele atender.</li>
            </ul>
            {p.motivo && <p className="rounded-lg bg-red-50 px-3 py-2 font-semibold text-red-700 dark:bg-red-950/60 dark:text-red-300">Agora: {motivoLegivel(p.motivo)}</p>}
          </Interruptor>
        )}
        {t && p?.modo && (
          <Interruptor comando="ura/passiva-auto" titulo="Termômetro da URA"
            estado={{ texto: ESTADOS_TERMOMETRO[t.estado].texto, tom: ESTADOS_TERMOMETRO[t.estado].tom }}
            ligar={{ texto: 'Ligar passiva automática' }}
            desligar={{ texto: 'Desligar', confirmar: { titulo: 'Desligar a passiva automática?', texto: 'Com a URA calma, 1 fixo livre volta a reduzir os robôs. Só o botão "URA passiva hoje" relaxa a regra.' } }}>
            <MedidorTermometro t={t} />
            <p><b>Agora:</b> {medidaDoTermometro(t)} · {t.derivacoes} derivação(ões) em {t.janelaMin} min · {t.observadoMin.toLocaleString('pt-BR')} min observados com robô ligado{t.desde ? ` · ${ESTADOS_TERMOMETRO[t.estado].texto} desde ${horaCurta(t.desde)}` : ''}.</p>
            <p className="text-slate-500 dark:text-slate-400">{ESTADOS_TERMOMETRO[t.estado].explicacao}</p>
            <p className="flex flex-wrap items-center gap-2">
              <b>Passiva automática:</b>
              {auto?.ligado
                ? <Selo tom={p?.passivaAgora && !passiva?.ligado ? 'ok' : 'neutro'}>{p?.passivaAgora && !passiva?.ligado ? 'agindo agora (URA calma)' : 'ligada: age quando a URA ficar calma'}</Selo>
                : <Selo tom="neutro">desligada</Selo>}
            </p>
            {passiva?.ligado && t.estado === 'agressiva' && (
              <p className="rounded-lg bg-amber-50 px-3 py-2 font-semibold text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">A URA está agressiva e a URA passiva hoje está ligada: considere desligá-la.</p>
            )}
          </Interruptor>
        )}
        <Interruptor comando="ura/passiva" titulo="URA passiva hoje"
          estado={passiva?.ligado ? { texto: `ligada desde ${horaCurta(passiva.desde)}`, tom: 'ok' } : { texto: 'desligada', tom: 'neutro' }}
          ligar={{ texto: 'Ligar' }} desligar={{ texto: 'Desligar' }}>
          <p>Para os dias em que a URA não está agressiva. Ligada, com só um <b>fixo</b> livre os robôs seguem até ele atender; aí sobra nenhum livre e eles desligam.</p>
          <p>O termômetro faz o mesmo sozinho quando a URA fica calma; este botão vale o dia todo, seja qual for o termômetro.</p>
          <p className="text-slate-500 dark:text-slate-400">Vale até desligar ou até virar o dia.</p>
        </Interruptor>
        <Interruptor comando="ura/cheia" titulo="URA cheia"
          estado={cheia?.ligada ? { texto: `ligada desde ${horaCurta(cheia.desde)}`, tom: 'alerta' } : { texto: 'rodízio normal', tom: 'neutro' }}
          ligar={{ texto: 'Colocar todos na URA', confirmar: { titulo: 'Colocar todos na URA?', texto: 'Todos os operadores do Ativo vão para a URA em até 5 s, atendendo ou não.' } }}
          desligar={{ texto: 'Voltar ao normal' }}>
          <p>Leva <b>todos</b> os operadores do Ativo para a URA. A regra do ocioso continua valendo: quem fica livre o tempo todo volta ao Ativo e sobe de novo ao atender lá.</p>
          <p className="text-slate-500 dark:text-slate-400">Voltar ao normal: só sobe quem é elegível (meta de ontem, venda hoje ou fixo). Vale até desligar ou virar o dia.</p>
        </Interruptor>
        {risco?.ativo && (
          <Interruptor comando="risco/desligar" titulo="Clientes de risco"
            estado={risco.desligaRobos?.ligado ? { texto: 'desliga os robôs', tom: 'perigo' } : { texto: 'só avisa', tom: 'ok' }}
            ligar={{ texto: 'Desligar robôs com cliente de risco', perigo: true }} desligar={{ texto: 'Só avisar' }}>
            <p>Cliente que gerou callback ou atende muito o robô nos últimos dias. Quando um robô fala com ele, o aviso aparece no topo, com som e notificação.</p>
            <p className="text-slate-500 dark:text-slate-400">
              {risco.perfis?.clientes ?? 0} cliente(s) com perfil · {risco.perfis?.risco ?? 0} de risco
              {risco.perfis?.historicoAte ? ` · histórico até ${dataBr(risco.perfis.historicoAte)}` : ''}
            </p>
            <BotaoAvisos />
          </Interruptor>
        )}
      </div>
      {risco?.ativo && <ClientesDeRisco />}
    </>
  );
}
