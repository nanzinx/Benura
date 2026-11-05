/**
 * [NOVO] Endereço de cada aba, sem # (benura.benconsig.com/receptivo). O servidor do painel
 * (src/painel/servidor.js) e o Cloudflare Pages entregam a mesma página nesses caminhos.
 * Os links antigos com # (…/#servicos) continuam abrindo a aba certa.
 */

export type Aba = 'visao' | 'relatorios' | 'receptivo' | 'ura' | 'esteira' | 'servicos' | 'ajuda';

/** Se mudar um caminho aqui, mude também ROTAS_DA_PAGINA em src/painel/servidor.js (um teste confere). */
export const CAMINHOS: Record<Aba, string> = {
  visao: '/',
  relatorios: '/relatorios',
  receptivo: '/receptivo',
  ura: '/robos',
  esteira: '/esteira',
  servicos: '/servicos',
  ajuda: '/ajuda',
};

export const NOMES_DAS_ABAS: Record<Aba, string> = {
  visao: 'Visão geral',
  relatorios: 'Relatórios',
  receptivo: 'Receptivo URA',
  ura: 'URA e robôs',
  esteira: 'Esteira manual',
  servicos: 'Serviços',
  ajuda: 'Ajuda',
};

const ABAS = Object.keys(CAMINHOS) as Aba[];

export function abaDoEndereco(caminho: string, hash = ''): Aba {
  const doHash = hash.replace(/^#/, '') as Aba;
  if (ABAS.includes(doHash)) return doHash;
  const limpo = (caminho.replace(/\/+$/, '') || '/').toLowerCase();
  return ABAS.find((a) => CAMINHOS[a] === limpo) ?? 'visao';
}

export const tituloDaAba = (aba: Aba) => `BenURA · ${NOMES_DAS_ABAS[aba]}`;

const RISCO = '⚠ Cliente de risco · ';
/**
 * O título da guia: o da aba e, enquanto há aviso de cliente de risco (Faixas), o "⚠" na frente.
 * Quem troca um não perde o outro.
 */
export function definirTitulo({ aba, risco }: { aba?: Aba; risco?: boolean }) {
  const atual = document.title;
  const comRisco = risco ?? atual.startsWith(RISCO);
  document.title = (comRisco ? RISCO : '') + (aba ? tituloDaAba(aba) : atual.replace(RISCO, ''));
}

const EVENTO = 'benura:aba';

/** Troca de aba sem recarregar: muda o endereço e avisa o App. */
export function irPara(aba: Aba) {
  // O título antes do pushState: o navegador guarda o título da entrada e o mostra de novo no voltar.
  definirTitulo({ aba });
  if (location.pathname !== CAMINHOS[aba] || location.hash) history.pushState(null, '', CAMINHOS[aba]);
  window.dispatchEvent(new Event(EVENTO));
  window.scrollTo({ top: 0 });
}

/** Ouve a troca de aba (pelos links, pelos atalhos e pelo voltar/avançar do navegador). */
export function ouvirTrocaDeAba(avisar: () => void) {
  window.addEventListener(EVENTO, avisar);
  window.addEventListener('popstate', avisar);
  return () => {
    window.removeEventListener(EVENTO, avisar);
    window.removeEventListener('popstate', avisar);
  };
}

/**
 * Clique num link de aba: troca sem recarregar. Com Ctrl, Shift, ⌘ ou o botão do meio, deixa o
 * navegador abrir em outra guia (o href é o endereço de verdade).
 */
export function aoClicarNaAba(aba: Aba) {
  return (e: { button: number; ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean; preventDefault: () => void }) => {
    if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    irPara(aba);
  };
}
