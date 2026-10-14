'use strict';
/**
 * Diagnóstico de callbacks dos robôs — funções puras, sem I/O.
 *
 * Lê o relatório de ligações detalhadas da Argus (doc 5.1) e resume: quais
 * campos existem, quantas ligações por status/resultado e quais viraram
 * callback, com hora e robô. A documentação não descreve os campos de cada
 * ligação, por isso o resumo descobre os nomes pelo próprio relatório.
 *
 * Nenhum dado de cliente sai daqui: CPF, telefone, nome, lead e afins são
 * descartados antes de qualquer resumo.
 */

/** Campos de cliente (descartados). */
const CAMPO_DE_CLIENTE = /cpf|cnpj|telefone|fone|cliente|lead|email|endere|mailing/i;
/** "nome..." só passa se for do operador/robô ou de algo da Argus (grupo, lote, tabulação...). */
const NOME_PERMITIDO = /usuario|operador|grupo|campanha|lote|skill|tabula|status|servico/i;
/** Campos que contam (status, resultado, derivação, tabulação). */
const CAMPO_DE_RESULTADO = /status|result|conclus|deriv|callback|tabul/i;
const CALLBACK = /call\s*-?\s*back/i;

const ehDeCliente = (campo) => CAMPO_DE_CLIENTE.test(campo) || (/^nome/i.test(campo) && !NOME_PERMITIDO.test(campo));

/** Cópia da ligação sem os campos de cliente. */
const semDadosDeCliente = (ligacao) => Object.fromEntries(Object.entries(ligacao || {}).filter(([campo]) => !ehDeCliente(campo)));

/** Algum valor (texto) da ligação fala em callback. */
const ehCallback = (ligacao) => Object.values(ligacao).some((v) => typeof v === 'string' && CALLBACK.test(v));

/** campo → valor → quantidade, só para os campos de resultado. */
function contarResultados(ligacoes) {
  const contagens = {};
  for (const ligacao of ligacoes) {
    for (const [campo, valor] of Object.entries(ligacao)) {
      if (!CAMPO_DE_RESULTADO.test(campo)) continue;
      const porValor = (contagens[campo] ||= {});
      porValor[String(valor)] = (porValor[String(valor)] || 0) + 1;
    }
  }
  return contagens;
}

/**
 * @param {object[]} ligacoes - itens de `ligacoesDetalhadas` da Argus
 * @returns {{ total: number, campos: string[], resultados: object, callbacks: object[] }}
 */
function resumirLigacoes(ligacoes) {
  const limpas = ligacoes.map(semDadosDeCliente);
  return {
    total: limpas.length,
    campos: [...new Set(limpas.flatMap(Object.keys))].sort(),
    resultados: contarResultados(limpas),
    callbacks: limpas.filter(ehCallback),
  };
}

/** Minutos desde a meia-noite de `hora` (HH:MM), para "ultimosMinutos" pegar o dia todo. */
const minutosDesdeMeiaNoite = (hora) => {
  const [h, m] = String(hora).split(':').map(Number);
  return Math.max(1, h * 60 + m);
};

module.exports = { semDadosDeCliente, resumirLigacoes, minutosDesdeMeiaNoite, ehDeCliente };
