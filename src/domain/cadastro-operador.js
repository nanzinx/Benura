'use strict';
/**
 * Regras de negócio do cadastro de operadores — funções puras, sem I/O.
 *
 * Correspondência Vanguard (Sistema Corban) → Argus, confirmada nos dados reais:
 *   Usuário  "YASMIN.FERREIRA@36241"  →  Login "YASMIN.FERREIRA"
 *            (o sufixo @36241 é o código da agência no Vanguard)
 *   Agência  "36241 - MAYSA DE FATIMA ..."  →  Supervisor MAYSA (usuário administrativo)
 *   Perfil   "Operador Call Center"  →  Usuário Operador
 */

const { normalizarNome, normalizarLogin } = require('../utils/texto');

/** Status do planejamento de um cadastro. */
const StatusPlano = Object.freeze({
  PRONTO: 'PRONTO_PARA_CADASTRO', // ficha completa; pode cadastrar na Argus
  PENDENTE: 'PENDENTE', // ficha gerada, mas com campos que precisam de decisão humana
  JA_EXISTE: 'JA_EXISTE', // login já cadastrado na Argus (ativo ou inativo)
  BLOQUEADO: 'BLOQUEADO', // dados de origem impedem o cadastro
});

/** Status da conferência pós-cadastro. */
const StatusConferencia = Object.freeze({
  OK: 'OK',
  CORRIGIDO: 'CORRIGIDO',
  DIVERGENTE: 'DIVERGENTE',
  INCONCLUSIVO: 'INCONCLUSIVO', // cadastro existe, mas não foi possível saber o esperado
  NAO_ENCONTRADO: 'NAO_ENCONTRADO',
});

class LoginVanguardInvalidoError extends Error {
  constructor(login) {
    super(`Login do Vanguard inválido: "${login}". Formato esperado: NOME.SOBRENOME@AGENCIA (ex.: YASMIN.FERREIRA@36241).`);
    this.name = 'LoginVanguardInvalidoError';
  }
}

/**
 * Separa o login do Vanguard em login da Argus e código da agência.
 * @returns {{ loginVanguard: string, loginArgus: string, codigoAgencia: string|null }}
 * @throws {LoginVanguardInvalidoError}
 */
function interpretarLoginVanguard(login) {
  const bruto = normalizarLogin(login);
  const m = bruto.match(/^([A-Z0-9][A-Z0-9._-]*[A-Z0-9])(?:@(\d+))?$/);
  if (!m) throw new LoginVanguardInvalidoError(login);
  return { loginVanguard: bruto, loginArgus: m[1], codigoAgencia: m[2] ?? null };
}

/** Perfis do Vanguard que viram operador na Argus. */
const ehPerfilOperador = (perfil) => /OPERADOR/.test(normalizarNome(perfil));

/** Status do Vanguard considerado ativo. */
const ehStatusAtivo = (status) => !status || /^ATIVO$/.test(normalizarNome(status));

/**
 * Sugere o próximo "Ramal Integração": o maior ramal numérico em uso + 1.
 * Os ramais da Argus são sequenciais (ex.: 2266111, 2266112...).
 * É só uma sugestão — quem cadastra confirma no formulário.
 */
function sugerirProximoRamal(ramaisEmUso) {
  const numeros = ramaisEmUso.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  return numeros.length ? String(Math.max(...numeros) + 1) : null;
}

/**
 * Compara o cadastro existente na Argus com o esperado.
 * @param {object} usuario - Usuário da Argus (modelo do DiretorioOperadores)
 * @param {{ idGrupo: number|null, idSupervisor: number|null }} esperado
 * @returns {{ vinculo: object|null, divergencias: Array<{ campo, esperado, atual }> }}
 */
function compararCadastro(usuario, esperado) {
  const divergencias = [];
  if (!usuario.ativo) divergencias.push({ campo: 'status', esperado: 'ATIVO', atual: 'INATIVO' });
  if (usuario.tipo !== 2) divergencias.push({ campo: 'tipo', esperado: 'Operador', atual: 'Administrativo' });
  if (!usuario.ramal) divergencias.push({ campo: 'ramal', esperado: 'preenchido', atual: '(vazio)' });

  // Vínculo relevante: o do grupo esperado; senão o primeiro com grupo.
  const vinculo = usuario.vinculos.find((v) => v.idGrupo === esperado.idGrupo)
    || usuario.vinculos.find((v) => v.idGrupo != null)
    || null;

  if (!vinculo) {
    divergencias.push({ campo: 'campanha', esperado: 'vinculado a uma campanha', atual: '(nenhuma)' });
  } else {
    if (esperado.idGrupo != null && vinculo.idGrupo !== esperado.idGrupo) {
      divergencias.push({ campo: 'grupo', esperado: esperado.idGrupo, atual: vinculo.idGrupo });
    }
    if (esperado.idSupervisor != null && vinculo.idSupervisor !== esperado.idSupervisor) {
      divergencias.push({ campo: 'supervisor', esperado: esperado.idSupervisor, atual: vinculo.idSupervisor });
    }
  }
  return { vinculo, divergencias };
}

module.exports = {
  StatusPlano,
  StatusConferencia,
  LoginVanguardInvalidoError,
  interpretarLoginVanguard,
  ehPerfilOperador,
  ehStatusAtivo,
  sugerirProximoRamal,
  compararCadastro,
};
