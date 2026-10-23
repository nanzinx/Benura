/** Faixas do topo, em qualquer aba: automação desligada, cliente de risco, pânico, serviço fora do ar, Argus. */

import { clsx } from 'clsx';
import { CircleAlert, LoaderCircle, Monitor, Pause, PhoneCall, Power, PowerOff, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useAutomacao, useVisao } from '../dados';
import type { AlertaDeRisco, EstadoAutomacao } from '../tipos';
import { Botao } from '../ui/base';
import { useRetorno } from '../ui/retorno';
import { semAcesso, usePode } from '../sessao';
import { duracao, horaCurta, motivoLegivel } from '../formatos';
import { alertasRecentes, avisarClientesNovos, proximoFimDeAviso, registrarAlertas } from '../notificacoes';

const MAX_FAIXAS_RISCO = 3;
import { situacaoDosPcs } from './DoisPcs';

/** Automação desligada (ou desligando/religando): a faixa mais importante, com o botão de religar. */
function FaixaAutomacao({ a }: { a: EstadoAutomacao }) {
  const religar = useAutomacao();
  const { confirmar } = useRetorno();
  const admin = usePode('administrador');
  const andando = a.estado === 'desligando' || a.estado === 'religando';
  const titulo = a.estado === 'desligando' ? 'Desligando a automação…' : a.estado === 'religando' ? 'Religando a automação…'
    : `Automação desligada${a.desde ? ` desde ${horaCurta(a.desde)}` : ''}${a.por ? ` (por ${a.por})` : ''}`;
  const detalhe = andando ? `${a.etapa ?? ''}${a.aviso ? ` · ${a.aviso}` : ''}`
    : `O BenURA não move ninguém nem mexe nos robôs, nem se o PC reiniciar.${a.aviso ? ` Atenção: ${a.aviso}` : ''}`;
  return (
    <div role="alert" className="mt-4 flex animate-entrar flex-wrap items-center gap-3 rounded-xl border-2 border-red-600 bg-red-600 px-4 py-3 text-white">
      {andando ? <LoaderCircle className="size-5 shrink-0 animate-spin" aria-hidden /> : <Power className="size-5 shrink-0" aria-hidden />}
      <div className="min-w-0 flex-1">
        <p className="font-semibold">{titulo}</p>
        <p className="text-sm text-red-50">{detalhe}</p>
      </div>
      {a.estado === 'desligada' && (
        <Botao variante="secundario" carregando={religar.isPending} semAcesso={admin ? null : semAcesso('administrador')} onClick={async () => {
          if (await confirmar({ titulo: 'Religar a automação?', texto: 'O roteador, o rodízio e as rotinas voltam a funcionar. Os robôs continuam desligados: quem liga é a supervisão, pela Argus.', confirmar: 'Religar automação' })) religar.mutate(true);
        }}>Religar automação</Botao>
      )}
    </div>
  );
}

function Faixa({ tom, icone, titulo, detalhe }: { tom: 'perigo' | 'alerta'; icone: ReactNode; titulo: string; detalhe?: string }) {
  return (
    <div role={tom === 'perigo' ? 'alert' : 'status'} className={clsx('mt-4 flex animate-entrar items-start gap-3 rounded-xl border px-4 py-3',
      tom === 'perigo' ? 'border-red-300 bg-red-50 text-red-800 dark:border-red-800 dark:bg-red-950/70 dark:text-red-200' : 'border-amarelo-500 bg-amarelo-100 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100')}>
      <span className="mt-0.5 shrink-0">{icone}</span>
      <div>
        <p className="font-semibold">{titulo}</p>
        {detalhe && <p className="text-sm opacity-85">{detalhe}</p>}
      </div>
    </div>
  );
}

export function Faixas() {
  const { data: v } = useVisao();
  const tituloOriginal = useRef(document.title);
  const alertas = v?.alertas?.alertas ?? [];
  // [NOVO] Cada aviso de cliente de risco fica AVISO_MS (5 s) e some: a faixa, a notificação e o título.
  const [, setTique] = useState(0);
  const novos = useRef<AlertaDeRisco[]>([]);
  novos.current.push(...registrarAlertas(alertas));
  const recentes = alertasRecentes(alertas);

  useEffect(() => {
    avisarClientesNovos(novos.current.splice(0));
    document.title = (recentes.length ? '⚠ Cliente de risco · ' : '') + tituloOriginal.current;
    const fim = proximoFimDeAviso(alertas);
    if (fim == null) return undefined;
    const t = setTimeout(() => setTique((n) => n + 1), fim + 50);
    return () => clearTimeout(t);
  });

  if (!v) return null;
  const r = v.servicos.rodizio.dados;
  const fora = Object.entries(v.servicos).filter(([nome, s]) => s && !s.online && nome !== 'atualizador').map(([, s]) => s!.nome);
  const faixas: ReactNode[] = [];
  const automacao = v.automacao;
  const reiniciando = automacao?.estado === 'reiniciando';
  // Parada de propósito (ou reiniciando para a simulação): sem "fora do ar" nem "rodízio sem Argus".
  const automacaoParada = Boolean(automacao && automacao.estado !== 'ligada');
  if (automacao && automacaoParada && !reiniciando) faixas.push(<FaixaAutomacao key="automacao" a={automacao} />);
  if (automacao && reiniciando) {
    faixas.push(<Faixa key="reiniciando" tom="alerta" icone={<LoaderCircle className="size-5 animate-spin" />} titulo="Reiniciando os serviços…"
      detalhe={`${automacao.etapa ?? ''}${automacao.aviso ? ` · ${automacao.aviso}` : ''}`} />);
  }

  // [NOVO] dois PCs: este espera (o outro está agindo), o outro parou de responder, ou a trava não responde
  if (v.doisPcs && !v.doisPcs.trava.minha) {
    const s = situacaoDosPcs(v.doisPcs, v);
    const ligadoAqui = automacao?.estado === 'ligada' && !r?.dryRun;
    if (s.tom === 'perigo' || (s.tom === 'alerta' && ligadoAqui)) {
      faixas.push(<Faixa key="dois-pcs" tom={s.tom === 'perigo' ? 'perigo' : 'alerta'} icone={<Monitor className="size-5" />} titulo={s.titulo} detalhe={`${s.detalhe.replace(/\.$/, '')}. Veja na aba Serviços.`} />);
    }
  }
  // Até 3 de uma vez; mais que isso vira uma faixa só.
  if (recentes.length > MAX_FAIXAS_RISCO) {
    faixas.push(<Faixa key="risco-varios" tom="perigo" icone={<PhoneCall className="size-5" />}
      titulo={`${recentes.length} clientes de risco entraram em ligação agora`} detalhe={`${alertas.length} em ligação no total · veja o cartão Clientes de risco, na aba Robôs`} />);
  } else {
    for (const a of recentes) {
      faixas.push(<Faixa key={`risco-${a.id}`} tom="perigo" icone={<PhoneCall className="size-5" />}
        titulo={`Cliente de risco em ligação com ${a.robo ?? 'robô'}: ${a.mascara}`} detalhe={`${a.motivos.join(', ')} nos últimos dias · desde ${horaCurta(a.inicio)}`} />);
    }
  }
  // [NOVO] robôs desligados pelo painel (aba URA e robôs)
  if (r?.robos?.modo === 'desligados') {
    faixas.push(<Faixa key="robos-desligados" tom="alerta" icone={<PowerOff className="size-5" />}
      titulo={`Robôs desligados pelo painel${r.robos.modoDesde ? ` desde ${horaCurta(r.robos.modoDesde)}` : ''}${r.robos.modoPor ? ` (${r.robos.modoPor})` : ''}`}
      detalhe='O BenURA mantém todos desligados; o resto da automação segue. Para voltar, escolha "Automático" ou "Só pânico" na aba URA e robôs.' />);
  }
  if (r?.retencaoAtivo?.ativa) {
    const ret = r.retencaoAtivo;
    faixas.push(<Faixa key="retencao" tom="alerta" icone={<Pause className="size-5" />}
      titulo={`Rodízio pausado: todos no Ativo desde ${horaCurta(ret.desde)}${ret.por ? ` (${ret.por})` : ''}`}
      detalhe='Ninguém sobe para a URA (nem quem vender) até "Retomar rodízio da URA", na aba Receptivo. Os fixos continuam na URA.' />);
  }
  if (r?.panico?.ativoAgora) {
    const titulo = r.panico.tipo === 'fixo' ? 'Pânico ativo: o BenURA está reduzindo os robôs à metade' : 'Pânico ativo: o BenURA está desligando os robôs';
    faixas.push(<Faixa key="panico" tom="perigo" icone={<ShieldAlert className="size-5" />} titulo={titulo} detalhe={motivoLegivel(r.panico.motivo)} />);
  }
  if (fora.length && !automacaoParada) {
    faixas.push(<Faixa key="fora" tom="alerta" icone={<TriangleAlert className="size-5" />} titulo={`Fora do ar: ${fora.join(', ')}`} detalhe="No PC do BenURA: npx pm2 status (e npx pm2 logs para ver o motivo)." />);
  }
  // Serviços parados de propósito (automação desligada): sem "fora do ar" nem "rodízio sem Argus".
  if (!automacaoParada && v.argus.tokenRecusado) {
    faixas.push(<Faixa key="token" tom="alerta" icone={<CircleAlert className="size-5" />} titulo="A Argus recusou o token"
      detalhe="Atualize ARGUS_TOKEN no .env (Configurações → Desenvolvedor → Acesso API) e reinicie: npx pm2 restart all." />);
  } else if (!automacaoParada && v.servicos.rodizio.online && !v.argus.respondendo) {
    faixas.push(<Faixa key="argus" tom="alerta" icone={<CircleAlert className="size-5" />} titulo={`O rodízio não fala com a Argus há ${duracao(v.argus.cicloUraHaSeg)}`} detalhe="Veja os avisos na aba Serviços." />);
  }
  if (!faixas.length) return null;
  return <div className="mx-auto max-w-7xl px-4 sm:px-6" aria-live="polite">{faixas}</div>;
}
