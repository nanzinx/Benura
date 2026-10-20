/** Faixas do topo, em qualquer aba: cliente de risco, pânico, serviço fora do ar, Argus. */

import { clsx } from 'clsx';
import { CircleAlert, PhoneCall, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useEffect, useRef, type ReactNode } from 'react';
import { useVisao } from '../dados';
import { duracao, horaCurta, motivoLegivel } from '../formatos';
import { avisarClientesNovos } from '../notificacoes';

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

  for (const a of alertas) {
    faixas.push(<Faixa key={`risco-${a.id}`} tom="perigo" icone={<PhoneCall className="size-5" />}
      titulo={`Cliente de risco em ligação com ${a.robo ?? 'robô'}: ${a.mascara}`} detalhe={`${a.motivos.join(', ')} nos últimos dias · desde ${horaCurta(a.inicio)}`} />);
  }
  if (r?.panico?.ativoAgora) {
    faixas.push(<Faixa key="panico" tom="perigo" icone={<ShieldAlert className="size-5" />} titulo="Pânico ativo: o BenURA está desligando os robôs" detalhe={motivoLegivel(r.panico.motivo)} />);
  }
  if (fora.length) {
    faixas.push(<Faixa key="fora" tom="alerta" icone={<TriangleAlert className="size-5" />} titulo={`Fora do ar: ${fora.join(', ')}`} detalhe="No PC do BenURA: npx pm2 status (e npx pm2 logs para ver o motivo)." />);
  }
  if (v.argus.tokenRecusado) {
    faixas.push(<Faixa key="token" tom="alerta" icone={<CircleAlert className="size-5" />} titulo="A Argus recusou o token"
      detalhe="Atualize ARGUS_TOKEN no .env (Configurações → Desenvolvedor → Acesso API) e reinicie: npx pm2 restart all." />);
  } else if (v.servicos.rodizio.online && !v.argus.respondendo) {
    faixas.push(<Faixa key="argus" tom="alerta" icone={<CircleAlert className="size-5" />} titulo={`O rodízio não fala com a Argus há ${duracao(v.argus.cicloUraHaSeg)}`} detalhe="Veja os avisos na aba Serviços." />);
  }
  if (!faixas.length) return null;
  return <div className="mx-auto max-w-7xl px-4 sm:px-6" aria-live="polite">{faixas}</div>;
}
