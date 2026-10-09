'use strict';
/**
 * Desligados — regras puras.
 *
 * Quem sai da empresa vira "Inativo" na tela Funcionários do Vanguard, mas o
 * usuário continua ativo na Argus até alguém lembrar de inativar. Aqui se
 * cruza a exportação de Funcionários (filtro "Todos") com /listarusuarios.
 *
 * Só entra na lista quem está Inativo no Vanguard E ativo na Argus. Quem não
 * aparece no Vanguard é ignorado (a exportação pode estar filtrada por agência)
 * e quem tem outro cadastro ATIVO com o mesmo login (recontratado) também.
 */

const { coluna } = require('./bases');
const { interpretarLoginVanguard, ehStatusAtivo } = require('./cadastro-operador');

const COLUNAS = Object.freeze({ usuario: 'Usuário', status: 'Status', nome: 'Nome', agencia: 'Agencia' });

/** Login da Argus de uma linha do Vanguard ("ANA.SOUZA@36241" → "ANA.SOUZA"); null se inválido. */
function loginArgusDe(usuarioVanguard) {
  try {
    return interpretarLoginVanguard(usuarioVanguard).loginArgus;
  } catch {
    return null;
  }
}

/**
 * Situação de cada login no Vanguard: ativo se algum cadastro dele está Ativo.
 * @returns {Map<string, { ativo: boolean, status: string, nome: string, agencia: string }>}
 */
function situacaoNoVanguard(funcionarios, colunas = COLUNAS) {
  const porLogin = new Map();
  for (const linha of funcionarios) {
    const login = loginArgusDe(coluna(linha, colunas.usuario));
    if (!login) continue;
    const status = String(coluna(linha, colunas.status) ?? '').trim();
    const ativo = ehStatusAtivo(status) || Boolean(porLogin.get(login)?.ativo);
    porLogin.set(login, { ativo, status, nome: String(coluna(linha, colunas.nome) ?? '').trim(), agencia: String(coluna(linha, colunas.agencia) ?? '').trim() });
  }
  return porLogin;
}

/**
 * Operadores ativos na Argus cujo login está Inativo no Vanguard.
 * @param {object[]} funcionarios - linhas da exportação de Funcionários
 * @param {Array<{ login, nome, ramal, ativo, tipo }>} usuarios - modelo do DiretorioOperadores (mapearUsuario)
 * @returns {Array<{ login, nome, ramal, statusVanguard, agencia }>}
 */
function quemSaiu(funcionarios, usuarios, colunas = COLUNAS) {
  const vanguard = situacaoNoVanguard(funcionarios, colunas);
  return usuarios
    .filter((u) => u.tipo === 2 && u.ativo && u.login)
    .filter((u) => vanguard.has(u.login) && !vanguard.get(u.login).ativo)
    .map((u) => ({ login: u.login, nome: u.nome, ramal: u.ramal, statusVanguard: vanguard.get(u.login).status, agencia: vanguard.get(u.login).agencia }));
}

module.exports = { COLUNAS, loginArgusDe, situacaoNoVanguard, quemSaiu };
