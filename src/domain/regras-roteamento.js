'use strict';
/**
 * Regras de negócio do roteamento — funções puras, sem I/O.
 *
 *  1. CARGA INICIAL: venda de ontem > meta → URA; caso contrário → Ativo.
 *     (R$ 50.000,00 exatos NÃO qualificam: o critério é "superior a".)
 *     Operadores fixos (OPERADORES_FIXOS_URA) começam na URA com ou sem venda.
 *  2. GATILHO: vendedor no Ativo com qualquer venda hoje (> 0) → URA,
 *     permanecendo lá pelo resto do dia.
 *  3. RESET: no dia seguinte o ciclo recomeça.
 */

const { Fila } = require('./fila');

/** @returns {'URA'|'ATIVO'} */
const filaInicial = (vendaOntem, metaDiaria, fixo = false) => (fixo || vendaOntem > metaDiaria ? Fila.URA : Fila.ATIVO);

/**
 * Separa os vendedores pela regra da carga inicial (`fixo: true` → URA).
 * @returns {{ ura: object[], ativo: object[] }}
 */
function distribuirCargaInicial(vendedores, metaDiaria) {
  const ura = [];
  const ativo = [];
  for (const v of vendedores) {
    (filaInicial(v.totalVendas, metaDiaria, v.fixo) === Fila.URA ? ura : ativo).push(v);
  }
  return { ura, ativo };
}

/** Gatilho de mudança: quem está no Ativo e vendeu hoje sobe para a URA. */
const deveSubirParaUra = (filaAtual, vendaHoje) => filaAtual === Fila.ATIVO && vendaHoje > 0;

module.exports = { filaInicial, distribuirCargaInicial, deveSubirParaUra };
