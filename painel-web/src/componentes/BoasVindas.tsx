/**
 * [NOVO] Entrada do painel: logo do BenURA, "Bom dia, Renan" e o resumo de agora (status da URA,
 * livres e leads de hoje), um após o outro. Some sozinha em ~2 s; um clique ou uma tecla pula.
 * Aparece uma vez por dia em cada navegador e sempre logo depois do login (boas-vindas.ts).
 * Usa os dados que o painel já busca. Com "reduzir movimento" no sistema, só esmaece.
 */

import { clsx } from 'clsx';
import { useEffect, useState } from 'react';
import { useMetricasHoje, useVisao } from '../dados';
import { useSessao } from '../sessao';
import { primeiroNome, saudacao } from '../boas-vindas';
import { Marca } from './Marca';
import { CORES_DA_URA, NOMES_DA_URA } from './StatusUra';

const DURACAO_MS = 2200;
const SAIDA_MS = 350;

export function BoasVindas({ aoTerminar }: { aoTerminar: () => void }) {
  const sessao = useSessao();
  const { data: v } = useVisao();
  const { data: m } = useMetricasHoje();
  const [saindo, setSaindo] = useState(false);
  const r = v?.servicos.rodizio.dados;
  const nome = sessao.estado === 'dentro' ? primeiroNome(sessao.usuario.nome) : null;
  const status = r?.statusUra?.status ?? null;
  const livres = r?.uraAgora ? r.uraAgora.filter((u) => !u.virtual && u.classe === 'livre').length : null;
  const leads = m?.leadsDerivadosHoje ?? null;

  useEffect(() => {
    if (saindo) {
      const id = setTimeout(aoTerminar, SAIDA_MS);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setSaindo(true), DURACAO_MS);
    const pular = () => setSaindo(true);
    window.addEventListener('keydown', pular);
    return () => { clearTimeout(id); window.removeEventListener('keydown', pular); };
  }, [saindo, aoTerminar]);

  const itens = [
    status && <span key="s" className={clsx('rounded-lg border px-3 py-1 text-sm font-bold tracking-wide uppercase', CORES_DA_URA[status])}>{NOMES_DA_URA[status]}</span>,
    livres != null && <span key="l" className="rounded-lg bg-white/10 px-3 py-1 text-sm font-semibold text-white">{livres} livre(s) na URA</span>,
    leads != null && <span key="d" className="rounded-lg bg-white/10 px-3 py-1 text-sm font-semibold text-white">{leads} lead(s) hoje</span>,
  ].filter(Boolean);

  return (
    <div role="status" aria-live="polite" onClick={() => setSaindo(true)}
      className={clsx('fixed inset-0 z-50 grid cursor-pointer place-items-center overflow-hidden bg-gradient-to-br from-marinho-900 to-marinho-950 px-6 text-center', saindo && 'bv-saindo')}>
      <div className="pointer-events-none absolute -bottom-48 -left-48 size-[560px] rounded-full bg-amarelo-500/15 blur-3xl" aria-hidden />
      <div className="relative grid justify-items-center gap-6">
        <div className="bv-logo"><Marca tamanho="grande" /></div>
        <p className="bv-surgir text-2xl font-semibold text-white sm:text-3xl" style={{ animationDelay: '0.35s' }}>
          {saudacao()}{nome ? `, ${nome}` : ''}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {itens.map((item, i) => <span key={i} className="bv-surgir inline-block" style={{ animationDelay: `${0.6 + i * 0.15}s` }}>{item}</span>)}
        </div>
        <p className="bv-surgir text-xs text-white/60" style={{ animationDelay: '1s' }}>clique para pular</p>
      </div>
    </div>
  );
}
