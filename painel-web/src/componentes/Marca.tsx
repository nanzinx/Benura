import { clsx } from 'clsx';

export function Marca({ tamanho = 'normal' }: { tamanho?: 'normal' | 'grande' }) {
  const grande = tamanho === 'grande';
  return (
    <span className={clsx('inline-flex items-center font-bold tracking-tight text-white', grande ? 'gap-3.5 text-4xl' : 'gap-2.5 text-xl')}>
      <img src="/logo.svg" alt="" className={grande ? 'size-14 rounded-2xl' : 'size-8 rounded-lg'} />
      <span>Ben<span className="font-extrabold text-amarelo-500">URA</span></span>
    </span>
  );
}
