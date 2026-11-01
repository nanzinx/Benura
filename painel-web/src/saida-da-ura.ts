/**
 * [NOVO] Aba Receptivo: quanto falta para cada livre da URA voltar ao Ativo, ou por que ele não
 * volta (fixo, travado à mão, conta de supervisor, sem grupo do Ativo). A regra é a do rodízio
 * (src/domain/rodizio.js: saidaDaUra); aqui só o relógio anda entre uma leitura e outra.
 */

import { cronometro } from './formatos';
import type { SaidaDaUra } from './tipos';

export interface TextoDaSaida { texto: string; tom: 'neutro' | 'alerta' | 'info'; dica: string }

const FICA: Record<string, TextoDaSaida> = {
  fixo: { texto: 'fica: fixo', tom: 'info', dica: 'Fixo: fica na URA de vez, sem a regra do ocioso.' },
  'travado à mão': { texto: 'fica: travado à mão', tom: 'info', dica: 'Posto na URA pelo painel: fica até alguém clicar em "Liberar para o rodízio".' },
  'conta de supervisor': { texto: 'sai já: conta de supervisor', tom: 'alerta', dica: 'Conta de supervisor não fica na URA: volta ao Ativo no próximo ciclo.' },
  'em transferência': { texto: 'transferindo', tom: 'neutro', dica: 'A troca de grupo está em andamento.' },
};

export function textoDaSaida(saida: SaidaDaUra | null | undefined, livreDesde: string | null, agora: number): TextoDaSaida | null {
  if (!saida) return null;
  const fica = saida.motivo ? FICA[saida.motivo] : undefined;
  if (fica) return fica;
  const limite = `Volta ao Ativo com ${cronometro(saida.limiteMs / 1000)} livre (limite com a antiguidade).`;
  if (saida.motivo === 'sem grupo do Ativo') {
    return { texto: 'não sai: sem grupo do Ativo', tom: 'alerta', dica: `${limite} Passou do tempo, mas o BenURA não achou o grupo do Ativo dele: defina no supervisores-grupos.json.` };
  }
  const falta = livreDesde ? Math.max(0, Date.parse(livreDesde) + saida.limiteMs - agora) : saida.emMs ?? 0;
  return { texto: falta > 0 ? `sai em ${cronometro(falta / 1000)}` : 'saindo agora', tom: 'neutro', dica: limite };
}
