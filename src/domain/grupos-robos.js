'use strict';
/**
 * Identificação dos grupos de robôs da URA (puro, sem I/O).
 *
 * Robôs podem ser configurados por ID fixo (GRUPOS_ROBOS_URA_IDS) ou por
 * prefixo de nome (GRUPOS_ROBOS_URA_NOMES, padrão "URA PORT").
 * Por nome, apenas grupos virtuais DTMF da Argus (TipoGrupo.VIRTUAL_DTMF) são aceitos.
 */

const { TipoGrupo } = require('../integrations/argus/argus.client');
const { normalizarNome } = require('../utils/texto');

/** Remove espaços e traços para comparação flexível de nomes e prefixos. */
const semPontuacao = (s) => s.replace(/[\s\-_]+/g, '');

/**
 * Retorna os grupos correspondentes aos robôs da URA.
 *
 * @param {Array<object>} grupos Lista de grupos da Argus (/listargrupos)
 * @param {object} [opcoes]
 * @param {number[]|Set<number>} [opcoes.ids] IDs fixos de grupos de robôs
 * @param {string[]|string} [opcoes.nomes] Prefixos de nome dos grupos de robôs
 * @returns {Array<{ id: number, nome: string, ramais: string[] }>}
 */
function gruposDosRobos(grupos, { ids = [], nomes = [] } = {}) {
  if (!Array.isArray(grupos)) return [];

  const listaIds = Array.isArray(ids) || ids instanceof Set ? [...ids] : [ids];
  const idsSet = new Set(listaIds.filter((x) => x != null && x !== '').map(Number));

  const listaNomes = (Array.isArray(nomes)
    ? nomes
    : (typeof nomes === 'string' ? nomes.split(',') : [])
  ).map(normalizarNome).filter(Boolean);

  const prefixosSemPontuacao = listaNomes.map(semPontuacao);

  const resultado = [];
  const vistos = new Set();

  for (const g of grupos) {
    if (!g) continue;
    const id = Number(g.idGrupoUsuario ?? g.id);
    const nome = String(g.nome ?? g.descricao ?? g.grupoUsuarioDesc ?? '');
    const ramais = (g.ramaisOperadores ?? g.ramais ?? []).map(String);
    const idTipoGrupo = g.idTipoGrupo != null ? Number(g.idTipoGrupo) : null;

    const batePorId = Number.isInteger(id) && idsSet.has(id);

    let batePorNome = false;
    if (listaNomes.length > 0 && idTipoGrupo === TipoGrupo.VIRTUAL_DTMF) {
      const nomeNorm = normalizarNome(nome);
      const nomeSemPontuacao = semPontuacao(nomeNorm);
      batePorNome = listaNomes.some((pref, idx) => (
        nomeNorm.startsWith(pref) || nomeSemPontuacao.startsWith(prefixosSemPontuacao[idx])
      ));
    }

    if (batePorId || batePorNome) {
      if (!vistos.has(id)) {
        vistos.add(id);
        resultado.push({ id, nome, ramais });
      }
    }
  }

  return resultado;
}

module.exports = { gruposDosRobos, TipoGrupo };

