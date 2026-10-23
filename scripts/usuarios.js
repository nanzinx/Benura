#!/usr/bin/env node
'use strict';
/**
 * [NOVO] Usuários do painel pelo terminal, no próprio servidor (para criar o
 * primeiro administrador, ou se ninguém conseguir entrar). Pode rodar com o
 * painel no ar: ele relê o arquivo sozinho.
 *
 *   npm run usuarios -- criar                     pergunta e-mail, nome, papel e senha
 *   npm run usuarios -- criar --email ana@empresa.com --nome "Ana" --papel administrador
 *   npm run usuarios -- listar
 *   npm run usuarios -- senha ana@empresa.com     troca a senha (pergunta a nova)
 *   npm run usuarios -- papel ana@empresa.com supervisor
 *   npm run usuarios -- desativar ana@empresa.com | ativar ana@empresa.com
 *
 * Papéis: administrador, supervisor, visualizacao. A senha aparece como asteriscos.
 */

const readline = require('readline');
const { carregarConfig } = require('../src/config');
const { criarLogger } = require('../src/utils/logger');
const { Usuarios, PAPEIS, NOMES_PAPEIS, normalizarEmail } = require('../src/painel/usuarios');

/**
 * Lê as respostas. No terminal: uma pergunta de cada vez, e a senha aparece como
 * asteriscos (com Backspace e Ctrl+C). Com a entrada redirecionada (testes): linha a linha.
 */
function criarLeitor(entrada = process.stdin, saida = process.stdout) {
  if (entrada.isTTY && typeof entrada.setRawMode === 'function') return leitorDoTerminal(entrada, saida);
  const rl = readline.createInterface({ input: entrada, terminal: false });
  const fila = [];
  const esperando = [];
  let fim = false;
  rl.on('line', (l) => (esperando.length ? esperando.shift()(l) : fila.push(l)));
  rl.on('close', () => { fim = true; while (esperando.length) esperando.shift()(null); });
  return {
    async perguntar(texto, { oculto = false } = {}) {
      saida.write(texto);
      const linha = fila.length ? fila.shift() : fim ? null : await new Promise((r) => esperando.push(r));
      if (oculto) saida.write('\n');
      if (linha === null) throw new Error('entrada terminou antes da resposta');
      return linha.trim();
    },
    fechar: () => rl.close(),
  };
}

function leitorDoTerminal(entrada, saida) {
  /** A senha, tecla por tecla, mostrando * (o Windows e o Linux mandam \r ou \n no Enter). */
  const lerOculto = () => new Promise((resolver, rejeitar) => {
    let valor = '';
    entrada.setRawMode(true);
    entrada.resume();
    entrada.setEncoding('utf8');
    const terminar = (erro) => {
      entrada.removeListener('data', tecla);
      entrada.setRawMode(false);
      entrada.pause();
      saida.write('\n');
      if (erro) rejeitar(erro); else resolver(valor);
    };
    function tecla(pedaco) {
      for (const c of pedaco) {
        if (c === '\r' || c === '\n') return terminar();
        if (c === '\u0003') return terminar(new Error('cancelado (Ctrl+C)'));
        if (c === '\u007f' || c === '\b') {
          if (valor) { valor = valor.slice(0, -1); saida.write('\b \b'); }
        } else if (c >= ' ') {
          valor += c;
          saida.write('*');
        }
      }
      return undefined;
    }
    entrada.on('data', tecla);
  });
  const lerLinha = (texto) => new Promise((resolver) => {
    const rl = readline.createInterface({ input: entrada, output: saida, terminal: true });
    rl.question(texto, (r) => { rl.close(); resolver(r); });
  });
  return {
    async perguntar(texto, { oculto = false } = {}) {
      if (!oculto) return (await lerLinha(texto)).trim();
      saida.write(texto);
      return (await lerOculto()).trim();
    },
    fechar: () => entrada.pause(),
  };
}

function lerOpcoes(args) {
  const opcoes = {};
  const posicionais = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) opcoes[args[i].slice(2)] = args[i + 1] ?? '';
    if (args[i].startsWith('--')) i += 1;
    else posicionais.push(args[i]);
  }
  return { opcoes, posicionais };
}

async function pedirSenhaNova(leitor) {
  const senha = await leitor.perguntar('Senha (10 caracteres ou mais): ', { oculto: true });
  const repetida = await leitor.perguntar('Repita a senha: ', { oculto: true });
  if (senha !== repetida) throw new Error('as senhas não conferem');
  return senha;
}

async function executar(args, { usuarios, leitor, escrever = console.log }) {
  const [comando, ...resto] = args;
  const { opcoes, posicionais } = lerOpcoes(resto);
  const porEmail = (email) => {
    const u = usuarios.listar().find((x) => x.email === normalizarEmail(email));
    if (!u) throw new Error(`usuário ${email} não encontrado`);
    return u;
  };
  const por = 'terminal do servidor';

  if (comando === 'listar') {
    const lista = usuarios.listar();
    if (!lista.length) escrever('Nenhum usuário ainda. Crie o primeiro: npm run usuarios -- criar');
    for (const u of lista) escrever(`${u.ativo ? ' ' : '✗'} ${u.email.padEnd(32)} ${u.nome.padEnd(24)} ${NOMES_PAPEIS[u.papel]}${u.ativo ? '' : ' (desativado)'}`);
    return;
  }
  if (comando === 'criar') {
    const email = opcoes.email || await leitor.perguntar('E-mail: ');
    const nome = opcoes.nome || await leitor.perguntar('Nome: ');
    const primeiro = usuarios.vazia;
    const papel = opcoes.papel || await leitor.perguntar(`Papel (${PAPEIS.join(', ')})${primeiro ? ' [administrador]' : ''}: `) || (primeiro ? 'administrador' : '');
    const senha = await pedirSenhaNova(leitor);
    const { usuario } = await usuarios.criar({ email, nome, papel, senha }, por);
    escrever(`Usuário ${usuario.email} criado (${NOMES_PAPEIS[usuario.papel]}).`);
    return;
  }
  if (comando === 'senha') {
    const u = porEmail(posicionais[0] || await leitor.perguntar('E-mail: '));
    await usuarios.definirSenha(u.id, await pedirSenhaNova(leitor), por);
    escrever(`Senha de ${u.email} trocada: as sessões abertas dele saíram.`);
    return;
  }
  if (comando === 'papel') {
    const u = usuarios.atualizar(porEmail(posicionais[0]).id, { papel: posicionais[1] }, por);
    escrever(`${u.email} agora é ${NOMES_PAPEIS[u.papel]}.`);
    return;
  }
  if (comando === 'desativar' || comando === 'ativar') {
    const u = usuarios.atualizar(porEmail(posicionais[0]).id, { ativo: comando === 'ativar' }, por);
    escrever(`${u.email} ${u.ativo ? 'ativado' : 'desativado'}.`);
    return;
  }
  throw new Error('use: criar | listar | senha <email> | papel <email> <papel> | desativar <email> | ativar <email>');
}

async function principal() {
  const cfg = carregarConfig();
  const usuarios = new Usuarios({ arquivo: cfg.painel.arquivoUsuarios, logger: criarLogger({ escopo: 'usuarios' }) }).carregar();
  const leitor = criarLeitor();
  try {
    await executar(process.argv.slice(2), { usuarios, leitor });
  } catch (e) {
    console.error(`Erro: ${e.message}`);
    process.exitCode = 1;
  } finally {
    leitor.fechar();
  }
}

if (require.main === module) principal();

module.exports = { executar, criarLeitor };
