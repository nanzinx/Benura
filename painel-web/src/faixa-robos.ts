/**
 * [NOVO] Com os robôs num serviço próprio (benura-robos), a Visão geral precisa mostrar na hora quando
 * ele cai: os robôs param por segurança (o rodízio de pessoas manda os parados pararem em 30 s).
 */

import { horaCurta } from './formatos';
import type { Visao } from './tipos';

export function faixaDosRobos(v: Visao): { titulo: string; detalhe: string } | null {
  const robos = v.servicos.robos;
  if (!robos) return null; // ROBOS_SERVICO_PROPRIO=false: os robôs são do rodízio
  if (v.automacao && v.automacao.estado !== 'ligada') return null; // parada de propósito (tem a faixa dela)
  if (v.automacao?.componentes?.['benura-robos']) return null; // desligado à mão (tem a faixa dele)
  const conversa = v.servicos.rodizio.dados?.servicoDosRobos;
  if (robos.online && !conversa?.emergencia) return null;
  const desde = conversa?.respondeuEm ? ` (última resposta às ${horaCurta(conversa.respondeuEm)})` : '';
  return {
    titulo: conversa?.emergencia
      ? `Serviço dos robôs fora do ar: os robôs parados pararam de discar${desde}`
      : `Serviço dos robôs fora do ar${desde}`,
    detalhe: 'O rodízio de pessoas segue normal. O PM2 tenta religar sozinho; no PC do BenURA: npx pm2 logs benura-robos. '
      + 'Quando ele voltar, quem religa os robôs é a supervisão, pela Argus.',
  };
}
