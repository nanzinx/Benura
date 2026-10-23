/**
 * [NOVO] Usuários do painel (aba Serviços, só administrador): criar, mudar o papel,
 * desativar/ativar e redefinir a senha (gera uma provisória, mostrada uma vez só).
 * E a janela "Trocar minha senha", de todos.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { clsx } from 'clsx';
import { Check, Copy, KeyRound, ShieldCheck, UserPlus, UserRoundX, Users } from 'lucide-react';
import { useState } from 'react';
import { api, type Usuario } from '../api';
import { horaCurta } from '../formatos';
import { conferirSessao, DESCRICAO_PAPEIS, NOMES_PAPEIS, PAPEIS, useSessao, type Papel } from '../sessao';
import { Botao, Cartao, Esqueleto, Selo, Vazio, type Tom } from '../ui/base';
import { CAMPO, Campo, Dialogo } from '../ui/dialogo';
import { useRetorno } from '../ui/retorno';

const TOM_PAPEL: Record<Papel, Tom> = { administrador: 'info', supervisor: 'ok', visualizacao: 'neutro' };
const SENHA_MINIMA = 10;

const iniciais = (nome: string) => nome.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('');

function quando(iso: string | null) {
  if (!iso) return 'nunca entrou';
  const d = new Date(iso);
  const hoje = new Date().toDateString() === d.toDateString();
  return hoje ? `hoje, ${horaCurta(iso)}` : d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' }) + `, ${horaCurta(iso)}`;
}

/** A senha provisória, mostrada uma vez: copiar e entregar à pessoa. */
function SenhaProvisoria({ email, senha, fechar }: { email: string; senha: string; fechar: () => void }) {
  const [copiou, setCopiou] = useState(false);
  return (
    <Dialogo titulo="Senha provisória" icone={<KeyRound className="size-5" />} fechar={fechar}
      rodape={<Botao onClick={fechar}>Já anotei</Botao>}>
      <p>Entregue a <b>{email}</b>. Ela aparece <b>só agora</b>; no primeiro acesso, o painel pede para trocar.</p>
      <div className="mt-4 flex items-center gap-2 rounded-xl border border-slate-200 bg-slate-50 p-3 dark:border-noite-700 dark:bg-noite-950">
        <code className="flex-1 font-mono text-lg font-semibold tracking-wider text-slate-900 select-all dark:text-slate-100">{senha}</code>
        <Botao variante="secundario" icone={copiou ? <Check className="size-4" /> : <Copy className="size-4" />}
          onClick={() => navigator.clipboard?.writeText(senha).then(() => setCopiou(true), () => undefined)}>{copiou ? 'Copiada' : 'Copiar'}</Botao>
      </div>
    </Dialogo>
  );
}

function EscolherPapel({ valor, aoMudar, desligado, rotulo }: { valor: Papel; aoMudar: (p: Papel) => void; desligado?: boolean; rotulo: string }) {
  return (
    <select value={valor} onChange={(e) => aoMudar(e.target.value as Papel)} disabled={desligado} aria-label={rotulo}
      className="rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm disabled:opacity-60 dark:border-noite-600 dark:bg-noite-950">
      {[...PAPEIS].reverse().map((p) => <option key={p} value={p}>{NOMES_PAPEIS[p]}</option>)}
    </select>
  );
}

function NovoUsuario({ fechar, aoCriar, exigirSenha }: { fechar: () => void; aoCriar: (email: string, senha: string | null) => void; exigirSenha: boolean }) {
  const [form, setForm] = useState({ nome: '', email: '', papel: (exigirSenha ? 'administrador' : 'supervisor') as Papel, senha: '' });
  const cliente = useQueryClient();
  const criar = useMutation({
    mutationFn: () => api.criarUsuario({ ...form, email: form.email.trim(), senha: form.senha || undefined }),
    onSuccess: (r) => { cliente.invalidateQueries({ queryKey: ['usuarios'] }); aoCriar(r.usuario.email, r.senhaProvisoria); },
  });
  const curta = form.senha !== '' && form.senha.length < SENHA_MINIMA;
  return (
    <Dialogo titulo="Novo usuário" icone={<UserPlus className="size-5" />} fechar={fechar} aoEnviar={() => !curta && criar.mutate()}
      rodape={<><Botao variante="secundario" onClick={fechar}>Cancelar</Botao><Botao type="submit" carregando={criar.isPending} disabled={curta}>Criar usuário</Botao></>}>
      <div className="grid gap-4">
        <Campo rotulo="Nome"><input value={form.nome} onChange={(e) => setForm({ ...form, nome: e.target.value })} required autoFocus maxLength={80} className={CAMPO} /></Campo>
        <Campo rotulo="E-mail" dica="O mesmo do e-mail da empresa (depois, o do BenHub).">
          <input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} required spellCheck={false} className={CAMPO} />
        </Campo>
        <fieldset className="grid gap-2">
          <legend className="mb-1.5 text-sm font-semibold text-slate-800 dark:text-slate-100">Papel</legend>
          {[...PAPEIS].reverse().map((p) => (
            <label key={p} className={clsx('flex cursor-pointer items-start gap-3 rounded-lg border p-2.5', form.papel === p ? 'border-azul-500 bg-azul-50 dark:border-azul-400 dark:bg-noite-800' : 'border-slate-200 dark:border-noite-700')}>
              <input type="radio" name="papel" value={p} checked={form.papel === p} onChange={() => setForm({ ...form, papel: p })} className="mt-1" />
              <span><b className="text-slate-900 dark:text-slate-100">{NOMES_PAPEIS[p]}</b><span className="block text-xs text-slate-500 dark:text-slate-400">{DESCRICAO_PAPEIS[p]}</span></span>
            </label>
          ))}
        </fieldset>
        <Campo rotulo={exigirSenha ? 'Senha' : 'Senha (opcional)'}
          dica={curta ? <span className="text-red-700 dark:text-red-400">{SENHA_MINIMA} caracteres ou mais.</span>
            : exigirSenha ? `${SENHA_MINIMA} caracteres ou mais. Com o primeiro usuário, a senha do painel deixa de valer: você entra de novo com este.`
              : 'Em branco, o painel gera uma provisória e a pessoa troca no primeiro acesso.'}>
          <input type="password" value={form.senha} onChange={(e) => setForm({ ...form, senha: e.target.value })} required={exigirSenha} autoComplete="new-password" className={CAMPO} />
        </Campo>
        {criar.error && <p role="alert" className="font-semibold text-red-700 dark:text-red-400">{criar.error.message}</p>}
      </div>
    </Dialogo>
  );
}

/** "Trocar minha senha" (menu do usuário, no topo). */
export function TrocarSenha({ fechar, provisoria = false }: { fechar: () => void; provisoria?: boolean }) {
  const [form, setForm] = useState({ atual: '', nova: '', repetir: '' });
  const { avisar } = useRetorno();
  const trocar = useMutation({
    mutationFn: () => api.minhaSenha(form.atual, form.nova),
    onSuccess: () => { avisar('ok', 'Senha trocada. Nos outros aparelhos, entre de novo.'); void conferirSessao(); fechar(); },
  });
  const problema = form.nova && form.nova.length < SENHA_MINIMA ? `${SENHA_MINIMA} caracteres ou mais.`
    : form.repetir && form.repetir !== form.nova ? 'As senhas não conferem.' : '';
  return (
    <Dialogo titulo={provisoria ? 'Troque sua senha provisória' : 'Trocar minha senha'} icone={<KeyRound className="size-5" />} fechar={fechar} largura={420}
      aoEnviar={() => !problema && trocar.mutate()}
      rodape={<><Botao variante="secundario" onClick={fechar}>{provisoria ? 'Depois' : 'Cancelar'}</Botao><Botao type="submit" carregando={trocar.isPending} disabled={Boolean(problema)}>Trocar senha</Botao></>}>
      <div className="grid gap-4">
        {provisoria && <p>Você entrou com uma senha provisória. Escolha uma só sua.</p>}
        <Campo rotulo={provisoria ? 'Senha provisória' : 'Senha atual'}><input type="password" value={form.atual} onChange={(e) => setForm({ ...form, atual: e.target.value })} required autoFocus autoComplete="current-password" className={CAMPO} /></Campo>
        <Campo rotulo="Nova senha"><input type="password" value={form.nova} onChange={(e) => setForm({ ...form, nova: e.target.value })} required autoComplete="new-password" className={CAMPO} /></Campo>
        <Campo rotulo="Repita a nova senha" dica={problema ? <span className="text-red-700 dark:text-red-400">{problema}</span> : 'Trocar a senha encerra as suas sessões nos outros aparelhos.'}>
          <input type="password" value={form.repetir} onChange={(e) => setForm({ ...form, repetir: e.target.value })} required autoComplete="new-password" className={CAMPO} />
        </Campo>
        {trocar.error && <p role="alert" className="font-semibold text-red-700 dark:text-red-400">{trocar.error.message}</p>}
      </div>
    </Dialogo>
  );
}

function Linha({ u, eu }: { u: Usuario; eu: boolean }) {
  const cliente = useQueryClient();
  const { avisar, confirmar } = useRetorno();
  const [provisoria, setProvisoria] = useState<string | null>(null);
  const erro = (e: Error) => avisar('erro', `Não foi possível: ${e.message}`);
  const atualizar = useMutation({
    mutationFn: (mudanca: { papel?: Papel; ativo?: boolean }) => api.atualizarUsuario({ id: u.id, ...mudanca }),
    onSuccess: (r) => { cliente.invalidateQueries({ queryKey: ['usuarios'] }); avisar('ok', `${r.usuario.nome}: ${r.usuario.ativo ? NOMES_PAPEIS[r.usuario.papel] : 'desativado'}.`); },
    onError: erro,
  });
  const redefinir = useMutation({ mutationFn: () => api.redefinirSenha(u.id), onSuccess: (r) => setProvisoria(r.senhaProvisoria), onError: erro });

  return (
    <li className={clsx('grid grid-cols-[1fr_auto] items-center gap-x-3 gap-y-2 py-3 sm:grid-cols-[minmax(0,1fr)_170px_130px_88px] lg:grid-cols-[minmax(0,1fr)_170px_130px_290px]', !u.ativo && 'opacity-60')}>
      <div className="col-span-2 sm:col-span-1">
        <div className="flex items-center gap-3">
          <span className={clsx('grid size-9 shrink-0 place-items-center rounded-full text-xs font-bold', u.ativo ? 'bg-azul-100 text-azul-700 dark:bg-noite-800 dark:text-azul-300' : 'bg-slate-100 text-slate-500 dark:bg-noite-800')}>{iniciais(u.nome)}</span>
          <span className="min-w-0">
            <span className="flex flex-wrap items-center gap-x-2 font-semibold">{u.nome}{eu && <Selo tom="info">você</Selo>}{!u.ativo && <Selo tom="neutro">desativado</Selo>}{u.ativo && u.senhaProvisoria && <Selo tom="alerta">senha provisória</Selo>}</span>
            <span className="block truncate text-xs text-slate-500 dark:text-slate-400">{u.email}</span>
          </span>
        </div>
      </div>
      <div>
        {eu ? <Selo tom={TOM_PAPEL[u.papel]}>{NOMES_PAPEIS[u.papel]}</Selo> : (
          <EscolherPapel valor={u.papel} rotulo={`Papel de ${u.nome}`} desligado={!u.ativo || atualizar.isPending} aoMudar={async (papel) => {
            if (await confirmar({ titulo: `${u.nome} vira ${NOMES_PAPEIS[papel]}?`, texto: <p>{DESCRICAO_PAPEIS[papel]} Se estiver no painel, sai e entra de novo.</p>, confirmar: 'Mudar papel' })) atualizar.mutate({ papel });
          }} />
        )}
      </div>
      <div className="hidden text-sm text-slate-500 sm:block dark:text-slate-400">{quando(u.ultimoAcesso)}</div>
      <div>
        {!eu && (
          <div className="flex justify-end gap-1">
            <Botao variante="fantasma" className="min-h-8 px-2.5 whitespace-nowrap" icone={<KeyRound className="size-4" />} carregando={redefinir.isPending} disabled={!u.ativo} title="Gera uma senha provisória"
              onClick={async () => { if (await confirmar({ titulo: `Redefinir a senha de ${u.nome}?`, texto: <p>A senha atual deixa de valer e a pessoa sai do painel. O painel mostra uma provisória para você entregar.</p>, confirmar: 'Redefinir' })) redefinir.mutate(); }}>
              <span className="sr-only lg:not-sr-only">Redefinir senha</span>
            </Botao>
            <Botao variante="fantasma" className={clsx('min-h-8 px-2.5 whitespace-nowrap', u.ativo && 'text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-950/50')}
              icone={u.ativo ? <UserRoundX className="size-4" /> : <ShieldCheck className="size-4" />} carregando={atualizar.isPending && atualizar.variables?.ativo !== undefined}
              onClick={async () => {
                if (!u.ativo) return atualizar.mutate({ ativo: true });
                if (await confirmar({ titulo: `Desativar ${u.nome}?`, texto: <p>Sai do painel na hora e não entra mais até alguém ativar de novo. O histórico continua no log.</p>, confirmar: 'Desativar', perigo: true })) atualizar.mutate({ ativo: false });
                return undefined;
              }}>
              <span className="sr-only lg:not-sr-only">{u.ativo ? 'Desativar' : 'Ativar'}</span>
            </Botao>
          </div>
        )}
        {provisoria && <SenhaProvisoria email={u.email} senha={provisoria} fechar={() => setProvisoria(null)} />}
      </div>
    </li>
  );
}

export function GerenciarUsuarios() {
  const sessao = useSessao();
  const { data, isLoading } = useQuery({ queryKey: ['usuarios'], queryFn: api.usuarios });
  const [novo, setNovo] = useState(false);
  const [criado, setCriado] = useState<{ email: string; senha: string } | null>(null);
  const { avisar } = useRetorno();
  if (sessao.estado !== 'dentro') return null;
  const lista = data?.usuarios ?? [];
  const contagem = PAPEIS.map((p) => [p, lista.filter((u) => u.ativo && u.papel === p).length] as const).filter(([, n]) => n);

  return (
    <Cartao className="mb-5" titulo={<span className="flex items-center gap-2"><Users className="size-5 text-azul-600 dark:text-azul-300" aria-hidden />Usuários</span>}
      extra={<Botao icone={<UserPlus className="size-4" />} onClick={() => setNovo(true)}>Novo usuário</Botao>}>
      {sessao.emergencia && (
        <p className="mb-4 rounded-lg bg-amber-50 px-3 py-2.5 text-sm text-amber-900 dark:bg-amber-950/60 dark:text-amber-100">
          Você entrou com a senha do painel. Crie o seu usuário de <b>administrador</b>: a partir dele, cada pessoa entra com o próprio e-mail e a senha do painel deixa de valer.
        </p>
      )}
      {contagem.length > 0 && (
        <p className="mb-3 flex flex-wrap gap-2 text-sm text-slate-500 dark:text-slate-400">
          {contagem.map(([p, n]) => <Selo key={p} tom={TOM_PAPEL[p]}>{n} {NOMES_PAPEIS[p].toLowerCase()}{n > 1 && p !== 'visualizacao' ? 'es' : ''}</Selo>)}
        </p>
      )}
      {isLoading ? <Esqueleto className="h-32 w-full" /> : lista.length ? (
        <>
          <div aria-hidden className="rotulo hidden gap-x-3 border-b border-slate-200 pb-2 sm:grid sm:grid-cols-[minmax(0,1fr)_170px_130px_88px] lg:grid-cols-[minmax(0,1fr)_170px_130px_290px] dark:border-noite-700">
            <span>Pessoa</span><span>Papel</span><span>Último acesso</span><span className="w-0" />
          </div>
          <ul className="divide-y divide-slate-100 dark:divide-noite-800">
            {lista.map((u) => <Linha key={u.id} u={u} eu={!sessao.emergencia && u.email === sessao.usuario.email} />)}
          </ul>
        </>
      ) : <Vazio>Nenhum usuário ainda.</Vazio>}
      <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">
        Mudar o papel, redefinir a senha ou desativar tira a pessoa do painel na hora. Sem acesso ao painel: <code className="font-mono">npm run usuarios -- listar</code> no servidor.
      </p>
      {novo && <NovoUsuario exigirSenha={sessao.emergencia} fechar={() => setNovo(false)} aoCriar={(email, senha) => {
        setNovo(false);
        if (senha) setCriado({ email, senha });
        else avisar('ok', `Usuário ${email} criado.${sessao.emergencia ? ' Entre de novo com ele.' : ''}`);
        if (sessao.emergencia) void conferirSessao();
      }} />}
      {criado && <SenhaProvisoria email={criado.email} senha={criado.senha} fechar={() => setCriado(null)} />}
    </Cartao>
  );
}
