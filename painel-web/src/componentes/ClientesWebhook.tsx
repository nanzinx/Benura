/**
 * [NOVO] Clientes do webhook de transferências (aba Serviços, só administrador): quem está
 * cadastrado (pelo painel ou por API), o último envio e o último erro, e os botões Testar e
 * Remover. Cadastrar pelo painel mostra o segredo uma vez só, para passar ao cliente.
 * O contrato para passar ao cliente fica em docs/webhook-clientes.md.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowLeftRight, Copy, KeyRound, Plus, Send, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { horaCurta } from '../formatos';
import { Botao, Cartao, Esqueleto, Selo, Vazio } from '../ui/base';
import { CAMPO } from '../ui/dialogo';
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
  const [form, setForm] = useState({ nome: '', url: '' });
  const [novo, setNovo] = useState<{ nome: string | null; segredo: string } | null>(null);
  const cadastrar = useMutation({
    mutationFn: api.cadastrarClienteWebhook,
    onSuccess: (c) => {
      setNovo({ nome: c.nome, segredo: c.segredo });
      setForm({ nome: '', url: '' });
      cliente.invalidateQueries({ queryKey: ['clientes-webhook'] });
    },
    onError: (e: Error) => avisar('erro', e.message),
  });
  const enviar = (e: FormEvent) => {
    e.preventDefault();
    cadastrar.mutate({ nome: form.nome.trim(), url: form.url.trim() });
  };
  const copiar = async (texto: string) => {
    try {
      await navigator.clipboard.writeText(texto);
      avisar('ok', 'Segredo copiado.');
    } catch {
      avisar('erro', 'Não deu para copiar: selecione e copie à mão.');
    }
  };
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
        <Vazio>Nenhum cliente cadastrado. Cadastre abaixo ou o cliente se cadastra por API: POST /webhooks/clientes no rodízio (veja docs/webhook-clientes.md).</Vazio>
      )}
      {novo && (
        <div role="status" className="mt-4 grid gap-2 rounded-xl border border-amber-300 bg-amarelo-100 p-3 text-sm text-amber-950 dark:border-amber-800 dark:bg-amber-950/50 dark:text-amber-100">
          <p className="flex items-center gap-2 font-semibold"><KeyRound className="size-4" aria-hidden />Segredo de {novo.nome ?? 'o novo cliente'}: copie agora, ele não aparece de novo</p>
          <div className="flex flex-wrap items-center gap-2">
            <code className="min-w-0 flex-1 rounded-md bg-white px-2 py-1.5 font-mono text-xs break-all text-slate-900 select-all dark:bg-noite-950 dark:text-slate-100">{novo.segredo}</code>
            <Botao variante="secundario" className="min-h-8 px-3 py-1" icone={<Copy className="size-4" aria-hidden />} onClick={() => copiar(novo.segredo)}>Copiar</Botao>
            <Botao variante="secundario" className="min-h-8 px-3 py-1" onClick={() => setNovo(null)}>Já guardei</Botao>
          </div>
          <p className="text-xs">O cliente usa o segredo para conferir o cabeçalho X-BenURA-Assinatura (docs/webhook-clientes.md).</p>
        </div>
      )}
      <form onSubmit={enviar} className="mt-4 grid gap-3 border-t border-slate-100 pt-4 sm:grid-cols-[1fr_2fr_auto] sm:items-end dark:border-noite-800">
        <label className="grid gap-1 text-sm font-semibold">Nome
          <input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} maxLength={80} placeholder="Ex.: CRM" className={CAMPO} />
        </label>
        <label className="grid gap-1 text-sm font-semibold">Endereço (URL)
          <input type="url" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} required placeholder="https://cliente.com/webhook"
            spellCheck={false} autoComplete="off" className={CAMPO} />
        </label>
        <Botao type="submit" icone={<Plus className="size-4" aria-hidden />} carregando={cadastrar.isPending}>Cadastrar</Botao>
      </form>
    </Cartao>
  );
}
