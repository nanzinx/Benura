'use strict';
/**
 * Ramais dos fixos na URA, pelo diretório da Argus: OPERADORES_FIXOS_URA
 * (ramais ou nomes) e EQUIPES_FIXAS_URA (toda a equipe de cada supervisor).
 * Usado pelo roteador (carga do dia) e pelo rodízio (sem a lista do dia, só os
 * fixos sobem para a URA).
 */

/**
 * @param {import('./diretorio-operadores.service').DiretorioOperadores} diretorio - já carregado
 * @param {{ fixosUra?: string[], equipesFixasUra?: string[] }} regras
 * @returns {{ ramais: Set<string>, faltando: Array<{ item: string, onde: string, motivo: string }> }}
 */
function resolverFixos(diretorio, { fixosUra = [], equipesFixasUra = [] }) {
  const ramais = new Set();
  const faltando = [];
  const tentar = (item, onde, resolver) => {
    try {
      const { encontrados, motivo } = resolver();
      encontrados.forEach((r) => ramais.add(String(r)));
      if (motivo) faltando.push({ item, onde, motivo });
    } catch (e) {
      faltando.push({ item, onde, motivo: `diretório da Argus indisponível (${e.message})` });
    }
  };

  for (const item of fixosUra) tentar(item, 'OPERADORES_FIXOS_URA', () => operadorFixo(diretorio, item));
  for (const nome of equipesFixasUra) tentar(nome, 'EQUIPES_FIXAS_URA', () => equipeFixa(diretorio, nome));
  return { ramais, faltando };
}

function operadorFixo(diretorio, item) {
  if (/^\d+$/.test(item)) return { encontrados: [item] };
  const ramal = diretorio.ramalPorNome(item);
  return ramal ? { encontrados: [ramal] } : { encontrados: [], motivo: 'nome sem ramal na Argus' };
}

function equipeFixa(diretorio, nome) {
  const { supervisor, candidatos, ramais } = diretorio.ramaisDaEquipe(nome);
  if (supervisor && ramais.length) return { encontrados: ramais };
  if (!supervisor && candidatos.length > 1) {
    return { encontrados: [], motivo: `corresponde a ${candidatos.length} supervisores (${candidatos.map((c) => c.nome).join(', ')}); use o nome completo` };
  }
  return { encontrados: [], motivo: supervisor ? 'não tem nenhum operador ativo na equipe' : 'não foi encontrado entre os supervisores da Argus' };
}

module.exports = { resolverFixos };
