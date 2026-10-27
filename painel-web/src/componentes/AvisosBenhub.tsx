/**
 * [NOVO] Para onde vão os avisos do BenURA (aba Serviços, só administrador): só o log de
 * hoje ou também o BenHub (webhook), e o botão "Testar envio".
 * Avisos: serviço fora do ar há mais de 5 min (e a volta) e o resumo do dia às 18:00.
 */

import { useMutation } from '@tanstack/react-query';
import { BellRing, Send } from 'lucide-react';
import { api } from '../api';
import type { Visao } from '../tipos';
import { Botao, Selo } from '../ui/base';
import { useRetorno } from '../ui/retorno';

export function AvisosBenhub({ v }: { v: Visao }) {
  const { avisar } = useRetorno();
  const n = v.notificacoes;
  const webhook = n?.tipo === 'webhook';
  const testar = useMutation({
    mutationFn: api.testarAviso,
    onSuccess: (r) => {
      if (r.ok) avisar('ok', r.destino === 'webhook' ? 'Aviso de teste enviado ao BenHub.' : 'Aviso de teste registrado no log de hoje (o BenHub ainda não está configurado).');
      else avisar('erro', `O aviso de teste não chegou ao BenHub (${r.erro}). Ficou no log de hoje.`);
    },
    onError: (e: Error) => avisar('erro', e.message),
  });
  return (
    <section id="avisos-benhub" className="cartao mb-5 flex flex-wrap items-center gap-4 p-4">
      <div className="grid size-11 shrink-0 place-items-center rounded-xl bg-azul-50 text-azul-700 dark:bg-noite-800 dark:text-azul-300"><BellRing className="size-5" aria-hidden /></div>
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="font-semibold">Avisos (BenHub)</h2>
          <Selo tom={webhook ? 'ok' : 'neutro'}>{webhook ? 'enviando ao BenHub' : 'só no log de hoje'}</Selo>
        </div>
        <p className="text-sm text-slate-500 dark:text-slate-400">
          Serviço fora do ar há mais de 5 min (e quando volta) e o resumo do dia às 18:00.
          {webhook ? ' Cada aviso também fica no log de hoje.' : <> Para mandar ao BenHub: <code className="rounded bg-slate-200 px-1 text-xs dark:bg-noite-800">NOTIFICADOR=webhook</code>, a URL e o token no <code className="rounded bg-slate-200 px-1 text-xs dark:bg-noite-800">.env</code>.</>}
        </p>
      </div>
      <Botao variante="secundario" icone={<Send className="size-4" aria-hidden />} carregando={testar.isPending} onClick={() => testar.mutate()}>Testar envio</Botao>
    </section>
  );
}
