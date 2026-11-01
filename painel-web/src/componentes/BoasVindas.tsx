/**
 * [NOVO] Entrada do painel, em ~2,6 s:
 *  1. o ícone surge sozinho no centro, com duas ondas saindo do centro dele e as barras
 *     mexendo como um equalizador;
 *  2. a logo "expande": o ícone desliza e o nome BenURA sai de trás dele (o conjunto fica no centro);
 *  3. "Bom dia, Renan" sobe palavra por palavra e os números de agora (status da URA, livres e
 *     leads de hoje) entram um a um, contando de 0 até o valor;
 *  4. uma barrinha mostra quanto falta; na saída, abre um círculo do centro para fora e o painel
 *     entra em cascata.
 * Um clique ou uma tecla pula. Aparece uma vez por dia em cada navegador e sempre logo depois do
 * login (boas-vindas.ts). Usa os dados que o painel já busca. Com "reduzir movimento", só esmaece.
 */

import { clsx } from 'clsx';
import { useEffect, useRef, useState } from 'react';
import { useMetricasHoje, useVisao } from '../dados';
import { useSessao } from '../sessao';
import { primeiroNome, saudacao, valorNaContagem } from '../boas-vindas';
import { CORES_DA_URA, NOMES_DA_URA } from './StatusUra';

const DURACAO_MS = 2600;
const SAIDA_MS = 600;
const CONTAGEM_MS = 650;

const movimentoReduzido = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Conta de 0 até `valor`, começando `atrasoMs` depois de montar (ou na hora, se o valor chegar depois). */
function useContagem(valor: number | null, atrasoMs: number): number | null {
  const [mostrado, setMostrado] = useState<number | null>(null);
  useEffect(() => {
    if (valor == null) return undefined;
    if (movimentoReduzido()) { setMostrado(valor); return undefined; }
    let quadro = 0;
    const id = setTimeout(() => {
      const inicio = performance.now();
      const passo = (t: number) => {
        setMostrado(valorNaContagem(valor, t - inicio, CONTAGEM_MS));
        if (t - inicio < CONTAGEM_MS) quadro = requestAnimationFrame(passo);
      };
      quadro = requestAnimationFrame(passo);
    }, atrasoMs);
    return () => { clearTimeout(id); cancelAnimationFrame(quadro); };
  }, [valor, atrasoMs]);
  return valor == null ? null : mostrado ?? 0;
}

/** O ícone do BenURA (o mesmo de /logo.svg, com as barras centralizadas), para as barras poderem mexer. */
function Icone() {
  return (
    <svg viewBox="0 0 64 64" className="block size-16" aria-hidden>
      <rect width="64" height="64" rx="14" fill="#0A2350" />
      <rect className="bv-barra" x="10" y="26" width="6" height="12" rx="3" fill="#FFFFFF" />
      <rect className="bv-barra" x="20" y="16" width="6" height="32" rx="3" fill="#F5B800" />
      <rect className="bv-barra" x="30" y="21" width="6" height="22" rx="3" fill="#FFFFFF" />
      <rect className="bv-barra" x="40" y="12" width="6" height="40" rx="3" fill="#F5B800" />
      <rect className="bv-barra" x="50" y="27" width="4" height="10" rx="2" fill="#FFFFFF" opacity=".6" />
    </svg>
  );
}

export function BoasVindas({ aoSair, aoTerminar }: { aoSair: () => void; aoTerminar: () => void }) {
  const sessao = useSessao();
  const { data: v } = useVisao();
  const { data: m } = useMetricasHoje();
  const [saindo, setSaindo] = useState(false);
  // As funções do App mudam a cada render: guardadas aqui, os timers não recomeçam.
  const avisos = useRef({ aoSair, aoTerminar });
  avisos.current = { aoSair, aoTerminar };
  const r = v?.servicos.rodizio.dados;
  const nome = sessao.estado === 'dentro' ? primeiroNome(sessao.usuario.nome) : null;
  const status = r?.statusUra?.status ?? null;
  const livres = useContagem(r?.uraAgora ? r.uraAgora.filter((u) => !u.virtual && u.classe === 'livre').length : null, 1500);
  const leads = useContagem(m?.leadsDerivadosHoje ?? null, 1660);
  const palavras = `${saudacao()}${nome ? `, ${nome}` : ''}`.split(' ');

  useEffect(() => {
    if (saindo) {
      avisos.current.aoSair();
      const id = setTimeout(() => avisos.current.aoTerminar(), SAIDA_MS);
      return () => clearTimeout(id);
    }
    const id = setTimeout(() => setSaindo(true), DURACAO_MS);
    const pular = () => setSaindo(true);
    window.addEventListener('keydown', pular);
    return () => { clearTimeout(id); window.removeEventListener('keydown', pular); };
  }, [saindo]);

  const selos = [
    status && <span key="s" className={clsx('rounded-lg border px-3 py-1 text-sm font-bold tracking-wide uppercase', CORES_DA_URA[status])}>{NOMES_DA_URA[status]}</span>,
    livres != null && <span key="l" className="rounded-lg bg-white/10 px-3 py-1 text-sm font-semibold text-white tabular-nums">{livres} livre(s) na URA</span>,
    leads != null && <span key="d" className="rounded-lg bg-white/10 px-3 py-1 text-sm font-semibold text-white tabular-nums">{leads} lead(s) hoje</span>,
  ].filter(Boolean);

  return (
    <div role="status" aria-live="polite" onClick={() => setSaindo(true)}
      className={clsx('bv-fundo fixed inset-0 z-50 grid cursor-pointer place-items-center overflow-hidden px-6 text-center text-white', saindo && 'bv-saindo')}>
      <div className="bv-brilho pointer-events-none absolute -bottom-48 -left-48 size-[560px] rounded-full bg-amarelo-500/15 blur-3xl" aria-hidden />
      <div className={clsx('relative grid justify-items-center gap-6', saindo && 'bv-expandir')}>
        <div className="inline-flex items-center">
          <div className="bv-icone relative size-16 flex-none">
            {/* ondas saindo do centro do ícone */}
            <span className="bv-onda pointer-events-none absolute inset-0 rounded-2xl border-2 border-amarelo-400/75" aria-hidden />
            <span className="bv-onda pointer-events-none absolute inset-0 rounded-2xl border-2 border-amarelo-400/75" style={{ animationDelay: '0.55s' }} aria-hidden />
            <Icone />
          </div>
          <span className="bv-abre inline-block overflow-hidden">
            <span className="bv-palavra inline-block pl-4 text-4xl leading-none font-extrabold tracking-tight whitespace-nowrap">
              Ben<span className="text-amarelo-500">URA</span>
            </span>
          </span>
        </div>
        <p className="text-2xl font-semibold sm:text-3xl" aria-label={palavras.join(' ')}>
          {palavras.map((p, i) => (
            <span key={i} className="bv-surgir inline-block" style={{ animationDelay: `${1 + i * 0.09}s` }} aria-hidden>{p}{i < palavras.length - 1 ? ' ' : ''}</span>
          ))}
        </p>
        <div className="flex flex-wrap justify-center gap-2">
          {selos.map((selo, i) => <span key={i} className="bv-pulo inline-block" style={{ animationDelay: `${1.3 + i * 0.16}s` }}>{selo}</span>)}
        </div>
      </div>
      <div className={clsx('bv-rodape absolute bottom-6 left-1/2 grid w-60 max-w-[70%] -translate-x-1/2 justify-items-center gap-2', saindo && 'opacity-0')}>
        <div className="h-[3px] w-full overflow-hidden rounded-full bg-white/10">
          <div className="bv-progresso h-full w-full bg-amarelo-500" style={{ animationDuration: `${DURACAO_MS}ms` }} />
        </div>
        <span className="text-xs text-white/60">clique para pular</span>
      </div>
    </div>
  );
}
