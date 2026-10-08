'use strict';
/**
 * Fonte de dados de funcionários do Vanguard (Sistema Corban).
 *
 * CONTRATO — qualquer fonte implementa:
 *
 *   buscarPorLogin(loginVanguard: string): Promise<Funcionario|null>
 *
 *   Funcionario = {
 *     loginVanguard: string,   // "YASMIN.FERREIRA@36241"
 *     nome: string,            // "YASMIN FERREIRA DE JESUS"
 *     supervisor: string,      // nome da agência no Vanguard = supervisor
 *     perfil: string,          // "Operador Call Center"
 *     status: string,          // "Ativo"
 *     origem: string           // de onde veio o dado (auditoria)
 *   }
 *
 * Esta implementação usa dados informados à mão (linha de comando). Quando a
 * rota GET /api/funcionarios/:login existir no Carrossel, basta criar uma
 * FonteFuncionarioCarrossel com o mesmo método e trocá-la no cadastrar-operador.js.
 */

const { normalizarLogin } = require('../../utils/texto');

class FonteFuncionarioManual {
  /**
   * @param {{ nome?: string, supervisor?: string, perfil?: string, status?: string }} dados
   */
  constructor(dados = {}) {
    this.dados = dados;
  }

  async buscarPorLogin(loginVanguard) {
    const { nome, supervisor, perfil = 'Operador Call Center', status = 'Ativo' } = this.dados;
    if (!nome && !supervisor) return null;
    return {
      loginVanguard: normalizarLogin(loginVanguard),
      nome: nome ? String(nome).trim() : null,
      supervisor: supervisor ? String(supervisor).trim() : null,
      perfil,
      status,
      origem: 'manual (linha de comando)',
    };
  }
}

module.exports = { FonteFuncionarioManual };
