/**
 * [NOVO] "Os dois PCs" (aba Serviços) e a faixa do topo: quem está agindo de verdade
 * na Argus (a trava na Cloudflare), o outro PC pela rede e o botão Assumir.
 */

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Cloud, KeyRound, Monitor, MonitorX, ShieldCheck } from 'lucide-react';
import { api } from '../api';
import { duracao, horaCurta } from '../formatos';
import { semAcesso, usePode } from '../sessao';
import type { DoisPcs, Visao } from '../tipos';
import { Botao, ComoFunciona, Selo } from '../ui/base';
import { useRetorno } from '../ui/retorno';

/** O que está acontecendo, numa frase, para o cartão e a faixa. */
export function situacaoDosPcs(d: DoisPcs, v: Visao) {
  const t = d.trava;
  const agindoAqui = v.automacao?.estado === 'ligada' && !v.servicos.rodizio.dados?.dryRun;
  if (t.minha) return { tom: 'ok' as const, titulo: `Este PC (${t.pc}) está agindo de verdade`, detalhe: `desde ${horaCurta(t.desde)}${t.por ? ` · ${t.por}` : ''}` };
  if (t.erro && !t.dono) return { tom: 'perigo' as const, titulo: 'A trava dos dois PCs não responde', detalhe: `${t.erro}. Sem ela, nenhum PC age de verdade.` };
  if (t.dono && t.vale) return { tom: agindoAqui ? 'alerta' as const : 'neutro' as const, titulo: `O PC ${t.dono} está agindo de verdade`, detalhe: `desde ${horaCurta(t.desde)}${t.por ? ` · ${t.por}` : ''}${agindoAqui ? ' · este PC espera, sem mexer na Argus' : ''}` };
  if (t.dono && !t.vale) return { tom: 'perigo' as const, titulo: `O PC ${t.dono} parou de responder`, detalhe: 'A trava venceu. Um administrador pode assumir por este PC.' };
  return { tom: 'neutro' as const, titulo: 'Nenhum PC está agindo de verdade', detalhe: 'Os dois estão desligados ou em simulação.' };
}

function useAssumir() {
  const cliente = useQueryClient();
  const { avisar } = useRetorno();
  return useMutation({
    mutationFn: api.assumir,
    onSuccess: () => { avisar('ok', 'Este PC pegou a trava e passa a agir de verdade.'); cliente.invalidateQueries({ queryKey: ['visao'] }); },
    onError: (e) => avisar('erro', `Não foi possível: ${e.message}`),
  });
}

/** Assumir: só faz sentido com este PC ligado de verdade e a trava vencida no outro. */
function BotaoAssumir({ d, v }: { d: DoisPcs; v: Visao }) {
  const admin = usePode('administrador');
  const assumir = useAssumir();
  const { confirmar } = useRetorno();
  const t = d.trava;
  const ligadoAqui = v.automacao?.estado === 'ligada' && !v.servicos.rodizio.dados?.dryRun;
  if (t.minha || !ligadoAqui || (t.dono && t.vale)) return null;
  return (
    <Botao variante="perigo" icone={<KeyRound className="size-4" />} carregando={assumir.isPending} semAcesso={admin ? null : semAcesso('administrador')}
      onClick={async () => {
        if (await confirmar({
          titulo: 'Assumir a automação neste PC?',
          texto: <p>{t.dono ? <>O PC <b>{t.dono}</b> parou de renovar a trava. </> : null}Este PC ({t.pc}) passa a agir de verdade na Argus: move atendentes e liga e desliga robôs. Se o outro voltar, ele fica esperando até devolverem.</p>,
          confirmar: 'Assumir', perigo: true,
        })) assumir.mutate();
      }}>Assumir</Botao>
  );
}

function Pc({ nome, papel, agindo, linha, fora }: { nome: string; papel: string; agindo: boolean | null; linha: string; fora?: boolean }) {
  const Icone = fora ? MonitorX : Monitor;
  return (
    <div className={clsx('flex items-start gap-3 rounded-xl border-2 p-3.5', agindo ? 'border-emerald-500 bg-emerald-50 dark:border-emerald-600 dark:bg-emerald-950/40' : 'border-slate-200 dark:border-noite-700')}>
      <Icone className={clsx('mt-0.5 size-5 shrink-0', agindo ? 'text-emerald-700 dark:text-emerald-300' : 'text-slate-400')} aria-hidden />
      <div className="min-w-0">
        <p className="flex flex-wrap items-center gap-2 font-semibold">{nome}<span className="text-xs font-normal text-slate-500 dark:text-slate-400">{papel}</span>{agindo && <Selo tom="ok" pulsar>agindo de verdade</Selo>}</p>
        <p className="text-sm text-slate-500 dark:text-slate-400">{linha}</p>
      </div>
    </div>
  );
}

export function CartaoDoisPcs({ v }: { v: Visao }) {
  const d = v.doisPcs;
  if (!d) return null;
  const t = d.trava;
  const p = d.parceiro;
  const s = situacaoDosPcs(d, v);
  const modoAqui = v.automacao?.estado !== 'ligada' ? 'automação desligada' : v.servicos.rodizio.dados?.dryRun ? 'em simulação' : t.minha ? 'agindo' : 'esperando a trava';
  return (
    <section className="cartao mb-5">
      <header className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-semibold"><ShieldCheck className="size-5 text-azul-600 dark:text-azul-300" aria-hidden />Os dois PCs</h2>
          <p className="text-sm text-slate-500 dark:text-slate-400">Só um age de verdade na Argus por vez. O outro pode simular à vontade.</p>
        </div>
        <BotaoAssumir d={d} v={v} />
      </header>
      <div className={clsx('mb-4 rounded-xl px-4 py-3', {
        ok: 'bg-emerald-50 text-emerald-900 dark:bg-emerald-950/50 dark:text-emerald-100',
        alerta: 'bg-amber-50 text-amber-900 dark:bg-amber-950/60 dark:text-amber-100',
        perigo: 'bg-red-50 text-red-800 dark:bg-red-950/60 dark:text-red-200',
        neutro: 'bg-slate-50 text-slate-700 dark:bg-noite-950/50 dark:text-slate-200',
      }[s.tom])}>
        <p className="font-semibold">{s.titulo}</p>
        <p className="text-sm opacity-85">{s.detalhe}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <Pc nome={t.pc} papel="este PC" agindo={t.minha} linha={`${modoAqui}${t.minha && t.renovadaHaSeg != null ? ` · trava renovada há ${duracao(t.renovadaHaSeg)}` : ''}`} />
        {p.ativo
          ? <Pc nome={p.pc ?? 'o outro PC'} papel={p.url} agindo={p.respondeu ? Boolean(p.agindo) : null} fora={!p.respondeu}
              linha={p.respondeu ? `${p.agindo ? 'agindo' : 'não está agindo'} · usuários ${p.usuariosCopiadosEm ? `copiados às ${horaCurta(p.usuariosCopiadosEm)}` : 'em dia'}` : (p.erro ?? 'sem resposta')} />
          : <Pc nome="o outro PC" papel="não configurado" agindo={null} fora linha="Sem TRAVA_PARCEIRO_URL: os usuários e o estado do dia não são copiados." />}
      </div>
      <p className="mt-3 flex items-center gap-1.5 text-xs text-slate-500 dark:text-slate-400">
        <Cloud className="size-3.5" aria-hidden />Trava na Cloudflare{t.erro ? <span className="text-red-700 dark:text-red-400"> · {t.erro}</span> : t.vale ? ` · vence em ${duracao(t.venceEmSeg)} sem renovar` : ''}
      </p>
      <div className="mt-3">
        <ComoFunciona>
          <p><b>Quem age de verdade segura a trava</b> (automação ligada e fora da simulação) e a renova a cada 30 s. Sem renovar, ela vence em 2 min.</p>
          <p><b>Para o outro PC agir:</b> neste, clique em <b>Desligar automação</b> ou ligue o <b>Modo simulação</b>: a trava é solta na hora. Para voltar, <b>Religar</b> ou <b>Voltar a agir de verdade</b> pegam a trava, e são recusados se o outro estiver agindo.</p>
          <p><b>Se um PC cair:</b> a trava vence em 2 min e o outro pode <b>Assumir</b> (administrador). Quem volta fica esperando, sem mexer na Argus.</p>
          <p><b>Sem internet:</b> quem estava agindo para sozinho em 1 min (os robôs parados desligam). Assim os dois nunca agem juntos.</p>
          <p>Os usuários são copiados do outro PC a cada minuto, pela rede. Ao pegar a trava, este PC traz o estado do dia (modo dos robôs, status da URA, retenção e travas) de quem esteve com ela por último.</p>
        </ComoFunciona>
      </div>
    </section>
  );
}
