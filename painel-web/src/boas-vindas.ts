/**
 * [NOVO] Regras da entrada do painel (componentes/BoasVindas.tsx): a saudação pela hora de
 * Brasília, o primeiro nome de quem entrou e quando mostrar (uma vez por dia em cada
 * navegador, e sempre logo depois de fazer o login).
 */

const FUSO = 'America/Sao_Paulo';
export const CHAVE_ENTRADA = 'benura.entrada-vista-em';

const horaEm = (data: Date) => Number(new Intl.DateTimeFormat('pt-BR', { timeZone: FUSO, hour: 'numeric', hourCycle: 'h23' }).format(data));

/** "2026-11-03" no fuso da operação. */
export const diaDe = (data: Date) => new Intl.DateTimeFormat('sv-SE', { timeZone: FUSO }).format(data);

export function saudacao(agora: Date = new Date()): 'Bom dia' | 'Boa tarde' | 'Boa noite' {
  const h = horaEm(agora);
  return h >= 5 && h < 12 ? 'Bom dia' : h >= 12 && h < 18 ? 'Boa tarde' : 'Boa noite';
}

export function primeiroNome(nome: string | null | undefined): string | null {
  const p = String(nome ?? '').trim().split(/\s+/)[0];
  return p ? p[0]!.toUpperCase() + p.slice(1).toLowerCase() : null;
}

export function deveMostrarEntrada({ vistoEm, hoje, acabouDeEntrar }: { vistoEm: string | null; hoje: string; acabouDeEntrar: boolean }): boolean {
  return acabouDeEntrar || vistoEm !== hoje;
}

/** localStorage pode não existir (janela anônima, bloqueado): sem ele, mostra e segue. */
export function lerVistoEm(): string | null {
  try {
    return localStorage.getItem(CHAVE_ENTRADA);
  } catch {
    return null;
  }
}

export function marcarVisto(hoje: string): void {
  try {
    localStorage.setItem(CHAVE_ENTRADA, hoje);
  } catch {
    /* sem armazenamento: aparece de novo na próxima vez, sem problema */
  }
}
