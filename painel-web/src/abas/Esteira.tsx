import { useMutation, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { FileSpreadsheet, RefreshCw, Send, Trash2, UploadCloud } from 'lucide-react';
import { useRef, useState, type DragEvent } from 'react';
import { api } from '../api';
import { reais } from '../formatos';
import type { ResultadoEsteira } from '../tipos';
import { Botao, Cartao, Vazio } from '../ui/base';
import { useRetorno } from '../ui/retorno';

/** CSV exportado no Windows costuma vir em windows-1252: se o UTF-8 der caractere quebrado, relê. */
async function lerTexto(arquivo: File): Promise<string> {
  const bytes = await arquivo.arrayBuffer();
  const utf8 = new TextDecoder('utf-8').decode(bytes);
  return utf8.includes('�') ? new TextDecoder('windows-1252').decode(bytes) : utf8;
}

function Tabela({ titulo, lista, vazio }: { titulo: string; lista: { nome: string; total: number }[]; vazio: string }) {
  return (
    <div>
      <h3 className="mb-2 text-sm font-semibold text-slate-600 dark:text-slate-300">{titulo} · {lista.length}</h3>
      {lista.length ? (
        <table className="tabela"><tbody>{lista.map((v) => (
          <tr key={v.nome}><td>{v.nome}</td><td className="numero text-right">{reais(v.total)}</td></tr>
        ))}</tbody></table>
      ) : <Vazio>{vazio}</Vazio>}
    </div>
  );
}

export function Esteira() {
  const [texto, setTexto] = useState('');
  const [nomeArquivo, setNomeArquivo] = useState('');
  const [arrastando, setArrastando] = useState(false);
  const [resultado, setResultado] = useState<ResultadoEsteira | null>(null);
  const entrada = useRef<HTMLInputElement>(null);
  const { avisar, confirmar } = useRetorno();
  const cliente = useQueryClient();
  const linhas = texto ? texto.split(/\r?\n/).filter((l) => l.trim()).length : 0;

  const carregar = async (arquivo: File | undefined) => {
    if (!arquivo) return;
    setTexto(await lerTexto(arquivo));
    setNomeArquivo(arquivo.name);
  };
  const soltar = (e: DragEvent) => {
    e.preventDefault();
    setArrastando(false);
    void carregar(e.dataTransfer.files[0]);
  };

  const erro = (e: Error) => avisar('erro', `Não foi possível: ${e.message}`);
  const enviar = useMutation({
    mutationFn: () => api.colarEsteira(texto),
    onSuccess: (r) => { setResultado(r); avisar('ok', `Esteira recebida: ${r.vendas} venda(s).`); cliente.invalidateQueries({ queryKey: ['roteador'] }); },
    onError: erro,
  });
  const limpar = useMutation({
    mutationFn: api.limparEsteira,
    onSuccess: (r) => { setResultado(null); avisar('ok', `${r.apagados} dia(s) de esteira apagado(s).`); },
    onError: erro,
  });
  const recarregar = useMutation({
    mutationFn: api.recarregarVendas,
    onSuccess: () => { avisar('ok', 'Recarga iniciada. Acompanhe na Visão geral.'); cliente.invalidateQueries({ queryKey: ['roteador'] }); },
    onError: erro,
  });
  const ocupado = enviar.isPending || limpar.isPending || recarregar.isPending;

  return (
    <>
      <div className="mb-5 flex flex-wrap items-baseline justify-between gap-2">
        <h1 className="text-2xl font-bold tracking-tight">Esteira manual</h1>
        <p className="text-sm text-slate-500 dark:text-slate-400">Use quando o Carrossel ou a API dele estiverem fora do ar. O roteador aplica as mesmas regras com estas vendas.</p>
      </div>
      <div className="mb-5 grid gap-5 lg:grid-cols-[2fr_1fr]">
        <Cartao titulo="Colar a esteira">
          <div
            onDragOver={(e) => { e.preventDefault(); setArrastando(true); }}
            onDragLeave={() => setArrastando(false)}
            onDrop={soltar}
            className={clsx('mb-3 flex flex-wrap items-center gap-3 rounded-xl border-2 border-dashed px-4 py-4 transition-colors',
              arrastando ? 'border-azul-500 bg-azul-50 dark:bg-noite-800' : 'border-slate-200 dark:border-noite-700')}
          >
            <UploadCloud className="size-6 text-azul-600 dark:text-azul-300" aria-hidden />
            <div className="flex-1 text-sm">
              <p className="font-semibold">{nomeArquivo || 'Arraste o CSV da esteira para cá'}</p>
              <p className="text-slate-500 dark:text-slate-400">{nomeArquivo ? `${linhas} linha(s) com conteúdo` : 'ou escolha o arquivo, ou cole a tabela abaixo'}</p>
            </div>
            <input ref={entrada} type="file" accept=".csv,.txt" className="sr-only" onChange={(e) => void carregar(e.target.files?.[0])} />
            <Botao variante="secundario" icone={<FileSpreadsheet className="size-4" />} onClick={() => entrada.current?.click()}>Escolher arquivo</Botao>
          </div>
          <textarea
            value={texto}
            onChange={(e) => { setTexto(e.target.value); setNomeArquivo(''); }}
            spellCheck={false}
            placeholder="Proposta;...;Data/Hora;...;Agente;...;Valor Contrato;..."
            className="min-h-60 w-full resize-y rounded-lg border border-slate-300 bg-white p-3 font-mono text-xs leading-relaxed dark:border-noite-600 dark:bg-noite-950"
          />
          <div className="mt-3 flex flex-wrap gap-2">
            <Botao icone={<Send className="size-4" />} carregando={enviar.isPending} disabled={ocupado || !texto.trim()} onClick={() => enviar.mutate()}>Enviar esteira</Botao>
            <Botao variante="secundario" icone={<Trash2 className="size-4" />} carregando={limpar.isPending} disabled={ocupado} onClick={async () => {
              if (await confirmar({ titulo: 'Apagar as esteiras coladas?', texto: 'Se o Carrossel estiver fora do ar, o roteador fica sem vendas até colar de novo.', confirmar: 'Apagar', perigo: true })) limpar.mutate();
            }}>Apagar esteiras coladas</Botao>
            <Botao variante="fantasma" icone={<RefreshCw className="size-4" />} carregando={recarregar.isPending} disabled={ocupado} onClick={async () => {
              if (await confirmar({ titulo: 'Recarregar as vendas agora?', texto: 'O roteador relê o Carrossel (ou a esteira colada) e reaplica as filas do dia.', confirmar: 'Recarregar' })) recarregar.mutate();
            }}>Recarregar vendas</Botao>
          </div>
        </Cartao>
        <Cartao titulo="Como fazer">
          <ol className="grid list-decimal gap-2 pl-5 text-sm leading-relaxed">
            <li>Na esteira, filtre <b>Etapa = Andamento</b> e o período por <b>data de cadastro</b>, do <b>dia anterior trabalhado até hoje</b>.</li>
            <li>Exporte o CSV e arraste para cá (ou escolha o arquivo), <b>ou</b> copie a tabela com o cabeçalho e cole na caixa.</li>
            <li>Clique em <b>Enviar esteira</b>. Durante o dia, cole de novo para atualizar as vendas de hoje.</li>
            <li>Cada colagem substitui os dias que ela contém. <b>Apagar esteiras coladas</b> tira tudo.</li>
          </ol>
        </Cartao>
      </div>
      {resultado && (
        <Cartao titulo="O que a esteira decidiu" extra={<span>
          {resultado.vendas} venda(s) de {resultado.diasColados.join(', ')}{resultado.ignoradas ? ` · ${resultado.ignoradas} linha(s) ignorada(s)` : ''} · dia anterior: {resultado.diaAnterior ?? 'não encontrado (cole também o dia anterior)'}
        </span>} className="animate-entrar">
          <div className="grid gap-6 md:grid-cols-2">
            <Tabela titulo={`Acima da meta no dia anterior (${reais(resultado.metaDiaria)}) → URA`} lista={resultado.acimaDaMeta} vazio="Ninguém passou da meta." />
            <Tabela titulo={`Venderam hoje (${resultado.hoje}) → sobem para a URA`} lista={resultado.vendeuHoje} vazio="Nenhuma venda de hoje na esteira colada." />
          </div>
        </Cartao>
      )}
    </>
  );
}
