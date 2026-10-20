import { Eye, EyeOff, LockKeyhole } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Botao } from '../ui/base';
import { Marca } from './Marca';

export function Entrada({ aoEntrar }: { aoEntrar: () => void }) {
  const [senha, setSenha] = useState('');
  const [mostrar, setMostrar] = useState(false);
  const [erro, setErro] = useState('');
  const [enviando, setEnviando] = useState(false);

  const enviar = async (e: FormEvent) => {
    e.preventDefault();
    setEnviando(true);
    setErro('');
    try {
      await api.entrar(senha);
      aoEntrar();
    } catch (falha) {
      setErro((falha as Error).message);
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="grid min-h-screen lg:grid-cols-[1.1fr_1fr]">
      <div className="relative flex flex-col justify-center gap-5 overflow-hidden border-b-4 border-amarelo-500 bg-gradient-to-br from-marinho-900 to-marinho-950 px-6 py-12 text-white sm:px-14 lg:border-r-4 lg:border-b-0">
        <div className="pointer-events-none absolute -bottom-40 -left-40 size-[520px] rounded-full bg-amarelo-500/15 blur-3xl" aria-hidden />
        <Marca tamanho="grande" />
        <p className="text-xl text-azul-100">Painel da supervisão</p>
        <ul className="grid gap-3 text-azul-100/90">
          {['Controles da URA e dos robôs', 'Esteira manual quando o Carrossel cair', 'Saúde dos serviços e o dia da URA'].map((t) => (
            <li key={t} className="flex items-center gap-3"><span className="size-2 rounded-sm bg-amarelo-500" aria-hidden />{t}</li>
          ))}
        </ul>
      </div>
      <div className="grid place-items-center px-4 py-10">
        <form onSubmit={enviar} className="cartao w-full max-w-sm animate-entrar p-8">
          <div className="mb-6 grid size-11 place-items-center rounded-xl bg-azul-50 text-azul-600 dark:bg-noite-800 dark:text-azul-300">
            <LockKeyhole className="size-5" aria-hidden />
          </div>
          <h1 className="text-2xl font-bold tracking-tight">Entrar</h1>
          <p className="mt-1 text-sm text-slate-500 dark:text-slate-400">Use a senha da supervisão.</p>
          <label className="mt-6 grid gap-1.5 text-sm font-semibold">
            Senha
            <div className="relative">
              <input
                type={mostrar ? 'text' : 'password'}
                value={senha}
                onChange={(e) => setSenha(e.target.value)}
                autoComplete="current-password"
                autoFocus
                required
                className="w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 pr-11 font-normal dark:border-noite-600 dark:bg-noite-950"
              />
              <button type="button" onClick={() => setMostrar((m) => !m)} className="absolute inset-y-0 right-0 grid w-11 cursor-pointer place-items-center text-slate-500" aria-label={mostrar ? 'Esconder a senha' : 'Mostrar a senha'}>
                {mostrar ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
              </button>
            </div>
          </label>
          <Botao type="submit" carregando={enviando} className="mt-5 w-full">Entrar</Botao>
          <p role="alert" className="mt-3 min-h-5 text-sm font-semibold text-red-700 dark:text-red-400">{erro}</p>
        </form>
      </div>
    </div>
  );
}
