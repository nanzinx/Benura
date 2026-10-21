/** Faixas do topo, em qualquer aba: automação desligada, cliente de risco, pânico, serviço fora do ar, Argus. */

import { clsx } from 'clsx';
import { CircleAlert, LoaderCircle, PhoneCall, Power, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useAutomacao, useVisao } from '../dados';
import type { EstadoAutomacao } from '../tipos';
import { Botao } from '../ui/base';
import { useRetorno } from '../ui/retorno';
import { duracao, horaCurta, motivoLegivel } from '../formatos';
import { avisarClientesNovos } from '../notificacoes';

/** Automação desligada (ou desligando/religando): a faixa mais importante, com o botão de religar. */
function FaixaAutomacao({ a }: { a: EstadoAutomacao }) {
  const religar = useAutomacao();
  const { confirmar } = useRetorno();
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
        <Botao variante="secundario" carregando={religar.isPending} onClick={async () => {
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

  useEffect(() => {
    document.title = (alertas.length ? '⚠ Cliente de risco · ' : '') + tituloOriginal.current;
    avisarClientesNovos(alertas);
  }, [alertas]);

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

  for (const a of alertas) {
    faixas.push(<Faixa key={`risco-${a.id}`} tom="perigo" icone={<PhoneCall className="size-5" />}
      titulo={`Cliente de risco em ligação com ${a.robo ?? 'robô'}: ${a.mascara}`} detalhe={`${a.motivos.join(', ')} nos últimos dias · desde ${horaCurta(a.inicio)}`} />);
  }
  if (r?.panico?.ativoAgora) {
    faixas.push(<Faixa key="panico" tom="perigo" icone={<ShieldAlert className="size-5" />} titulo="Pânico ativo: o BenURA está desligando os robôs" detalhe={motivoLegivel(r.panico.motivo)} />);
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
