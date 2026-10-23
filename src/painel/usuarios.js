'use strict';
/**
 * [NOVO] Usuários do painel: e-mail, nome, papel e senha (scrypt com sal).
 *
 * É a fonte de usuários local, num arquivo (USUARIOS_FILE). O painel só usa
 * autenticar/buscar/listar/criar/atualizar/definirSenha: para entrar com o
 * login do BenHub, basta outra fonte com os mesmos métodos.
 *
 * Papéis (do menor para o maior):
 *  - visualizacao: só vê as telas;
 *  - supervisor: opera o dia (atendentes, robôs, status da URA, pânico, esteira);
 *  - administrador: tudo, inclusive Desligar automação, Modo simulação e usuários.
 *
 * Cada usuário tem uma `versao`: trocar a senha, o papel ou desativar sobe a
 * versão, e as sessões abertas dele deixam de valer.
 *
 * O arquivo é lido de novo quando muda (o `npm run usuarios` grava nele com o
 * painel no ar). A gravação é síncrona e atômica (.tmp → renomeia, com .bak).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { promisify } = require('util');
const { lerComBackup } = require('../utils/persistencia-json');

const scrypt = promisify(crypto.scrypt);
const PAPEIS = Object.freeze(['visualizacao', 'supervisor', 'administrador']);
const NOMES_PAPEIS = Object.freeze({ visualizacao: 'Visualização', supervisor: 'Supervisor', administrador: 'Administrador' });
const SENHA_MINIMA = 10;
const PARAMETROS = { N: 16384, r: 8, p: 1, tamanho: 32 };

/** O papel `papel` alcança o `minimo`? */
const podeFazer = (papel, minimo) => PAPEIS.indexOf(papel) >= PAPEIS.indexOf(minimo) && PAPEIS.includes(minimo);
const normalizarEmail = (email) => String(email ?? '').trim().toLowerCase();
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class ErroUsuarios extends Error {
  constructor(status, mensagem) {
    super(mensagem);
    this.status = status;
  }
}

async function gerarHash(senha) {
  const sal = crypto.randomBytes(16);
  const { N, r, p, tamanho } = PARAMETROS;
  const hash = await scrypt(senha, sal, tamanho, { N, r, p });
  return `scrypt$${N}$${r}$${p}$${sal.toString('base64')}$${hash.toString('base64')}`;
}

async function conferirHash(senha, guardado) {
  const [tipo, N, r, p, sal, hash] = String(guardado || '').split('$');
  if (tipo !== 'scrypt' || !hash) return false;
  const esperado = Buffer.from(hash, 'base64');
  const obtido = await scrypt(String(senha), Buffer.from(sal, 'base64'), esperado.length, { N: Number(N), r: Number(r), p: Number(p) });
  return crypto.timingSafeEqual(esperado, obtido);
}

/** Senha provisória legível (sem 0/O, 1/l/I), com 14 caracteres. */
function senhaProvisoria() {
  const letras = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(14), (b) => letras[b % letras.length]).join('');
}

/** O que sai para o painel (nunca o hash). */
const publico = ({ hash, ...u }) => u;

class Usuarios {
  /**
   * @param {object} deps
   * @param {string|null} deps.arquivo - null: só na memória (testes)
   * @param {object} deps.logger
   * @param {() => Date} [deps.agora]
   */
  constructor({ arquivo, logger, agora = () => new Date() }) {
    Object.assign(this, { arquivo, log: logger, agora });
    this.lista = [];
    this.lidoEm = null; // mtime do arquivo da última leitura
    // Para quem não existe, confere contra um hash qualquer: o tempo de resposta não revela quem tem conta.
    this.hashFalso = gerarHash(crypto.randomBytes(16).toString('hex'));
  }

  carregar() {
    if (!this.arquivo) return this;
    let mtime = null;
    try {
      mtime = fs.statSync(this.arquivo).mtimeMs;
    } catch { /* ainda não existe */ }
    if (mtime === this.lidoEm) return this;
    const { dados, erro } = lerComBackup(this.arquivo);
    if (erro) this.log.aviso(`Não foi possível ler ${this.arquivo}: ${erro.message}`);
    this.lista = Array.isArray(dados?.usuarios) ? dados.usuarios.filter((u) => u && u.id && u.email) : [];
    this.lidoEm = mtime;
    return this;
  }

  gravar() {
    if (!this.arquivo) return;
    fs.mkdirSync(path.dirname(this.arquivo), { recursive: true });
    const tmp = `${this.arquivo}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ usuarios: this.lista }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, this.arquivo);
    fs.copyFileSync(this.arquivo, `${this.arquivo}.bak`);
    this.lidoEm = fs.statSync(this.arquivo).mtimeMs;
  }

  /** Nenhum usuário criado ainda (só então vale a PAINEL_SENHA de emergência). */
  get vazia() {
    return this.carregar().lista.length === 0;
  }

  /** @returns {Promise<object|null>} o usuário (sem o hash), se e-mail e senha batem e ele está ativo */
  async autenticar(email, senha) {
    const u = this.carregar().lista.find((x) => x.email === normalizarEmail(email));
    const ok = await conferirHash(String(senha ?? ''), u?.hash ?? await this.hashFalso);
    if (!u || !ok || !u.ativo) return null;
    u.ultimoAcesso = this.agora().toISOString();
    this.gravar();
    return publico(u);
  }

  buscar(id) {
    const u = this.carregar().lista.find((x) => x.id === id);
    return u ? publico(u) : null;
  }

  listar() {
    return this.carregar().lista.map(publico).sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));
  }

  /** @returns {Promise<{ usuario: object, senha: string|null }>} senha: a provisória, quando não veio uma */
  async criar({ email, nome, papel, senha }, por = null) {
    const e = normalizarEmail(email);
    if (!EMAIL.test(e)) throw new ErroUsuarios(400, 'E-mail inválido');
    if (!String(nome ?? '').trim()) throw new ErroUsuarios(400, 'Informe o nome');
    if (!PAPEIS.includes(papel)) throw new ErroUsuarios(400, `Papel deve ser ${PAPEIS.join(', ')}`);
    if (this.carregar().lista.some((x) => x.email === e)) throw new ErroUsuarios(409, 'Já existe um usuário com esse e-mail');
    const provisoria = senha ? null : senhaProvisoria();
    this.validarSenha(senha ?? provisoria);
    const u = {
      id: crypto.randomBytes(8).toString('hex'), email: e, nome: String(nome).trim().slice(0, 80), papel, ativo: true, versao: 1,
      senhaProvisoria: Boolean(provisoria), criadoEm: this.agora().toISOString(), criadoPor: por, ultimoAcesso: null,
      hash: await gerarHash(senha ?? provisoria),
    };
    this.lista.push(u);
    this.gravar();
    this.log.aviso(`Painel: usuário ${u.email} criado (${NOMES_PAPEIS[papel]})${por ? ` por ${por}` : ''}.`);
    return { usuario: publico(u), senha: provisoria };
  }

  /** Nome, papel ou ativo. Não deixa o painel sem nenhum administrador ativo. */
  atualizar(id, { nome, papel, ativo }, por = null) {
    const u = this.carregar().lista.find((x) => x.id === id);
    if (!u) throw new ErroUsuarios(404, 'Usuário não encontrado');
    if (papel !== undefined && !PAPEIS.includes(papel)) throw new ErroUsuarios(400, `Papel deve ser ${PAPEIS.join(', ')}`);
    if (ativo !== undefined && typeof ativo !== 'boolean') throw new ErroUsuarios(400, 'ativo deve ser true ou false');
    const novo = { ...u, ...(nome !== undefined ? { nome: String(nome).trim().slice(0, 80) || u.nome } : {}), ...(papel !== undefined ? { papel } : {}), ...(ativo !== undefined ? { ativo } : {}) };
    const admins = this.lista.filter((x) => x.ativo && x.papel === 'administrador' && x.id !== id).length;
    if (u.ativo && u.papel === 'administrador' && !(novo.ativo && novo.papel === 'administrador') && admins === 0) {
      throw new ErroUsuarios(409, 'Este é o único administrador ativo: crie ou promova outro antes.');
    }
    if (novo.papel !== u.papel || novo.ativo !== u.ativo) novo.versao = u.versao + 1;
    Object.assign(u, novo);
    this.gravar();
    const mudancas = [papel !== undefined && `papel ${NOMES_PAPEIS[u.papel]}`, ativo !== undefined && (u.ativo ? 'ativado' : 'desativado')].filter(Boolean);
    if (mudancas.length) this.log.aviso(`Painel: usuário ${u.email} ${mudancas.join(', ')}${por ? ` por ${por}` : ''}.`);
    return publico(u);
  }

  /**
   * Troca a senha e derruba as sessões abertas do usuário.
   * @param {string|null} senha - null: gera uma provisória (redefinição pelo administrador)
   * @returns {Promise<string|null>} a provisória, quando gerada
   */
  async definirSenha(id, senha, por = null) {
    const u = this.carregar().lista.find((x) => x.id === id);
    if (!u) throw new ErroUsuarios(404, 'Usuário não encontrado');
    const provisoria = senha ? null : senhaProvisoria();
    this.validarSenha(senha ?? provisoria);
    u.hash = await gerarHash(senha ?? provisoria);
    Object.assign(u, { versao: u.versao + 1, senhaProvisoria: Boolean(provisoria) });
    this.gravar();
    this.log.aviso(`Painel: senha de ${u.email} ${provisoria ? 'redefinida' : 'trocada'}${por ? ` por ${por}` : ''}.`);
    return provisoria;
  }

  /** O próprio usuário troca a senha (confere a atual). */
  async trocarMinhaSenha(id, atual, nova) {
    const u = this.carregar().lista.find((x) => x.id === id);
    if (!u || !(await conferirHash(String(atual ?? ''), u.hash))) throw new ErroUsuarios(400, 'Senha atual incorreta');
    this.validarSenha(nova);
    if (nova === atual) throw new ErroUsuarios(400, 'A nova senha deve ser diferente da atual');
    await this.definirSenha(id, nova);
    return this.buscar(id);
  }

  validarSenha(senha) {
    if (typeof senha !== 'string' || senha.length < SENHA_MINIMA) throw new ErroUsuarios(400, `A senha precisa de ${SENHA_MINIMA} caracteres ou mais`);
    if (senha.length > 200) throw new ErroUsuarios(400, 'Senha longa demais');
  }
}

module.exports = { Usuarios, ErroUsuarios, PAPEIS, NOMES_PAPEIS, SENHA_MINIMA, podeFazer, normalizarEmail };
