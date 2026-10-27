'use strict';
/**
 * [NOVO] Respostas da Argus → fixtures de teste sem dado pessoal (scripts/capturar-argus.js).
 *
 * Mantém os nomes dos campos e os tipos (é o que os parsers do BenURA leem) e:
 *  - campos de cliente (CPF, telefone, nome do cliente, lead, e-mail, CRM, histórico...)
 *    viram "(removido)", 0, false, {} ou [] (o mesmo critério de diagnostico-callbacks.js);
 *  - nome e usuário do operador viram "Operador N", e cada ramal vira 9000NN, sempre o
 *    mesmo apelido para o mesmo original (as ligações de uma pessoa continuam juntas);
 *  - telefone, CPF e e-mail no meio de um texto são trocados.
 * dadosPessoais() confere o resultado: o que sobrar aparece na lista.
 */

const { ehDeCliente } = require('./diagnostico-callbacks');

const NOME_DE_OPERADOR = /^(nome|nomeOperador|nomeUsuario|usuarioOperador|usuario|login|nomeUsuarioSupervisor|nomeSupervisor)$/i;
const CAMPO_DE_RAMAL = /rama(l|is)/i;
/** Ids, códigos e datas: números longos ali não são telefone. */
const CAMPO_SEM_CONFERIR = /^(id|nr|cod)|data|hora|lote/i;

const PADROES = [
  ['CPF', /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b|\b\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}\b/],
  ['e-mail', /[\w.+-]+@[\w-]+\.[\w.]+/],
  ['telefone', /\(\d{2}\)\s?\d{4,5}-?\d{4}|\b\d{10,11}\b|\b9?\d{4}-\d{4}\b/],
];

const vazioDoTipo = (v) => (Array.isArray(v) ? [] : v && typeof v === 'object' ? {} : typeof v === 'number' ? 0 : typeof v === 'boolean' ? false : v == null ? v : '(removido)');

class Sanitizador {
  constructor() {
    this.nomes = new Map();
    this.ramais = new Map();
  }

  apelido(nome) {
    const chave = String(nome).trim();
    if (!chave) return nome;
    if (!this.nomes.has(chave)) this.nomes.set(chave, `Operador ${this.nomes.size + 1}`);
    return this.nomes.get(chave);
  }

  ramal(valor) {
    if (valor == null || valor === '') return valor;
    const chave = String(valor);
    if (!this.ramais.has(chave)) this.ramais.set(chave, 900000 + this.ramais.size + 1);
    const novo = this.ramais.get(chave);
    return typeof valor === 'number' ? novo : String(novo);
  }

  /** @param {*} valor - a resposta (objeto, lista ou valor) @param {string|null} [campo] */
  limpar(valor, campo = null) {
    if (campo != null && NOME_DE_OPERADOR.test(campo) && typeof valor === 'string') return this.apelido(valor);
    if (campo != null && CAMPO_DE_RAMAL.test(campo)) {
      if (Array.isArray(valor)) return valor.map((r) => this.ramal(r));
      if (typeof valor !== 'object') return this.ramal(valor);
    }
    if (campo != null && ehDeCliente(campo)) return vazioDoTipo(valor);
    if (Array.isArray(valor)) return valor.map((v) => this.limpar(v));
    if (valor && typeof valor === 'object') return Object.fromEntries(Object.entries(valor).map(([k, v]) => [k, this.limpar(v, k)]));
    if (typeof valor === 'string' && !(campo && CAMPO_SEM_CONFERIR.test(campo))) {
      return PADROES.reduce((t, [nome, re]) => t.replace(new RegExp(re.source, 'g'), `(${nome})`), valor);
    }
    return valor;
  }
}

/** O que parece dado pessoal ainda: ['caminho: tipo', ...]. Vazio = pode ir para o repositório. */
function dadosPessoais(valor, caminho = '', campo = null) {
  if (Array.isArray(valor)) return valor.flatMap((v, i) => dadosPessoais(v, `${caminho}[${i}]`, campo));
  if (valor && typeof valor === 'object') return Object.entries(valor).flatMap(([k, v]) => dadosPessoais(v, caminho ? `${caminho}.${k}` : k, k));
  if (typeof valor !== 'string' || (campo && CAMPO_SEM_CONFERIR.test(campo))) return [];
  const achado = PADROES.find(([, re]) => re.test(valor));
  return achado ? [`${caminho}: ${achado[0]}`] : [];
}

module.exports = { Sanitizador, dadosPessoais };
