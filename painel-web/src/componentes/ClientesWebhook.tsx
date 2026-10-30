/**
 * [NOVO] Clientes do webhook de transferências (aba Serviços, só administrador): quem se
 * cadastrou por API, o último envio e o último erro, e os botões Testar e Remover.
 * O contrato para passar ao cliente fica em docs/webhook-clientes.md.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Send, Trash2 } from 'lucide-react';
import { api } from '../api';
import { horaCurta } from '../formatos';
import { Botao, Cartao, Esqueleto, Selo, Vazio } from '../ui/base';
import { useRetorno } from '../ui/retorno';

const dominio = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

export function ClientesWebhook() {
  const cliente = useQueryClient();
  const { avisar, confirmar } = useRetorno();
  const { data, isLoading, isError } = useQuery({ queryKey: ['clientes-webhook'], queryFn: api.clientesWebhook, refetchInterval: 30_000 });
  const testar = useMutation({
    mutationFn: api.testarClienteWebhook,
    onSuccess: (r) => { avisar(r.ok ? 'ok' : 'erro', r.ok ? 'Mensagem de teste entregue.' : `Não chegou: ${r.erro}`); cliente.invalidateQueries({ queryKey: ['clientes-webhook'] }); },
    onError: (e: Error) => avisar('erro', e.message),
  });
  const remover = useMutation({
    mutationFn: api.removerClienteWebhook,
    onSuccess: () => { avisar('ok', 'Cliente removido do webhook.'); cliente.invalidateQueries({ queryKey: ['clientes-webhook'] }); },
    onError: (e: Error) => avisar('erro', e.message),
  });
  const lista = data?.clientes ?? [];
  return (
    <Cartao className="mb-5" titulo={<span className="flex items-center gap-2"><ArrowLeftRight className="size-5 text-azul-600 dark:text-azul-300" aria-hidden />Clientes do webhook de transferências</span>}
      extra={<span>avisa cada operador transferido entre URA e Ativo</span>}>
      {isLoading ? <Esqueleto className="h-20 w-full" /> : isError ? <Vazio>Não deu para ler os clientes (o rodízio está no ar?).</Vazio> : lista.length ? (
        <ul className="divide-y divide-slate-100 text-sm dark:divide-noite-800">
          {lista.map((c) => (
            <li key={c.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <p className="font-semibold">{c.nome ?? 'Cliente sem nome'} <span className="font-normal text-slate-500 dark:text-slate-400">· {dominio(c.url)}</span></p>
                <p className="text-xs text-slate-500 dark:text-slate-400">
                  Cadastrado em {new Date(c.criadoEm).toLocaleDateString('pt-BR')}
                  {c.ultimoEnvio ? ` · último envio às ${horaCurta(c.ultimoEnvio)}` : ' · nenhum envio desde que o rodízio subiu'}
                </p>
              </div>
              {c.ultimoErro && <Selo tom="perigo">falhou: {c.ultimoErro.split(' ').slice(1).join(' ')}</Selo>}
              <Botao variante="secundario" className="min-h-8 px-3 py-1" icone={<Send className="size-4" aria-hidden />} carregando={testar.isPending && testar.variables === c.id}
                onClick={() => testar.mutate(c.id)}>Testar</Botao>
              <Botao variante="secundario" className="min-h-8 px-3 py-1" icone={<Trash2 className="size-4" aria-hidden />} onClick={async () => {
                if (await confirmar({ titulo: `Remover ${c.nome ?? 'este cliente'}?`, texto: 'Ele deixa de receber os avisos de transferência. Para voltar, o cliente precisa se cadastrar de novo.', confirmar: 'Remover', perigo: true })) remover.mutate(c.id);
              }}>Remover</Botao>
            </li>
          ))}
        </ul>
      ) : (
        <Vazio>Nenhum cliente cadastrado. O cliente se cadastra por API: POST /webhooks/clientes no rodízio (veja docs/webhook-clientes.md).</Vazio>
      )}
    </Cartao>
  );
}
