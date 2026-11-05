/**
 * [NOVO] Aba Relatórios: tudo de relatório num lugar só. O relatório de hoje, 7 e 30 dias (com a
 * planilha), o dia da URA (livres e robôs ao longo do dia), os callbacks de hoje e as vendas e filas
 * do roteador. A Visão geral fica só com o de hoje e o que é do momento.
 */

import { Relatorio } from '../componentes/Relatorio';
import { StatusUra } from '../componentes/StatusUra';
import { useDia, useVisao } from '../dados';
import { Graficos, ListaCallbacks, Roteador } from './Visao';

export function Relatorios({ escuro }: { escuro: boolean }) {
  const { data: v, dataUpdatedAt } = useVisao();
  const { data: dia } = useDia();
  const r = v ? v.servicos.rodizio.dados : undefined;
  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-bold tracking-tight">Relatórios</h1>
          <StatusUra />
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">{dataUpdatedAt ? `Atualizado às ${new Date(dataUpdatedAt).toLocaleTimeString('pt-BR')}` : 'Carregando…'}</p>
      </div>
      <Relatorio r={r?.relatorio} statusAtual={r?.statusUra?.status} />
      <Graficos escuro={escuro} />
      <div className="mb-5"><ListaCallbacks callbacks={dia?.callbacks ?? []} /></div>
      <Roteador />
    </>
  );
}
