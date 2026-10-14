'use strict';
/**
 * Diagnóstico de callbacks dos robôs — funções puras, sem I/O.
 *
 * Lê o relatório de ligações detalhadas da Argus (doc 5.1) e resume: quais
 * campos existem, quantas ligações por status/resultado, a linha do tempo
 * (de 15 em 15 min) e cada callback com hora e robô.
 *
 * Na Argus, o "Gerou Callback" do painel aparece no relatório como resultado
 * "OPER. VIRTUAL - ABANDONO EM FILA" (o cliente pediu um humano, esperou na
 * fila e desistiu); "Derivou" é o resultado "ATENDIMENTO". "SEM AGENTE" vem do
 * discador (0 s), não dos robôs: conta à parte.
 *
 * Nenhum dado de cliente sai daqui: CPF, telefone, nome, lead, campos do CRM,
 * histórico e afins são descartados antes de qualquer resumo, assim como
 * qualquer valor que não seja texto, número ou booleano.
 */

/** Campos de cliente (descartados). */
const CAMPO_DE_CLIENTE = /cpf|cnpj|telefone|fone|cliente|lead|email|endere|mailing|crm|historico/i;
/** "nome..." só passa se for do operador/robô ou de algo da Argus (grupo, lote, tabulação...). */
const NOME_PERMITIDO = /usuario|operador|grupo|campanha|lote|skill|tabula|status|servico/i;
/** Campos que contam (status, resultado, derivação, tabulação). */
const CAMPO_DE_RESULTADO = /status|result|conclus|deriv|callback|tabul/i;
/** Campos mostrados na lista de callbacks. */
const CAMPO_DO_CALLBACK = /^idLigacao$|data|hora|usuario|operador|result|tempo|dura/i;

/** Como cada resultado entra na linha do tempo. */
const TIPOS = Object.freeze([
  ['callback', /abandono em fila|call\s*-?\s*back/i],
  ['semAgente', /sem agente/i],
  ['derivou', /^atendimento$/i],
  ['abandonoNaUra', /oper\.?\s*virtual\s*-\s*abandono$/i],
]);

const ehDeCliente = (campo) => CAMPO_DE_CLIENTE.test(campo) || (/^nome/i.test(campo) && !NOME_PERMITIDO.test(campo));
const ehPrimitivo = (v) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

/** Cópia da ligação sem os campos de cliente (e sem objetos aninhados, que podem trazer dados dele). */
const semDadosDeCliente = (ligacao) => Object.fromEntries(Object.entries(ligacao || {})
  .filter(([campo, valor]) => !ehDeCliente(campo) && ehPrimitivo(valor)));

/** Tipo da ligação pelos campos de resultado: 'callback', 'semAgente', 'derivou', 'abandonoNaUra' ou null. */
function tipoDaLigacao(ligacao) {
  const resultados = Object.entries(ligacao)
    .filter(([campo, v]) => CAMPO_DE_RESULTADO.test(campo) && typeof v === 'string')
    .map(([, v]) => v.trim());
  const tipo = TIPOS.find(([, padrao]) => resultados.some((v) => padrao.test(v)));
  return tipo ? tipo[0] : null;
}

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

/** "2026-10-14T09:03:12", "2026-10-14 09:03" ou "14/10/2026 09:03:12" → minutos do dia; null se não for data. */
function minutoDoDia(texto) {
  const m = /(\d{2}):(\d{2})/.exec(String(texto || '').replace(/^.*?(\d{4}-\d{2}-\d{2}|\d{2}\/\d{2}\/\d{4})[T\s]+/, ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

const formatarMinuto = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;

/** Campo de data/hora da ligação (o primeiro que parece uma). */
const horaDaLigacao = (ligacao) => {
  const campo = Object.keys(ligacao).find((c) => /data.*hora|hora.*liga|datahora/i.test(c)) || Object.keys(ligacao).find((c) => /data|hora/i.test(c));
  return campo ? minutoDoDia(ligacao[campo]) : null;
};

/**
 * Contagem por janela de `janelaMin` minutos: total, callback, sem agente, derivou e abandono na URA.
 * @returns {Array<{ janela: string, total: number, callback: number, semAgente: number, derivou: number, abandonoNaUra: number }>}
 */
function linhaDoTempo(ligacoes, janelaMin = 15) {
  const janelas = new Map();
  for (const ligacao of ligacoes) {
    const minuto = horaDaLigacao(ligacao);
    if (minuto === null) continue;
    const inicio = Math.floor(minuto / janelaMin) * janelaMin;
    const j = janelas.get(inicio) || { janela: formatarMinuto(inicio), total: 0, callback: 0, semAgente: 0, derivou: 0, abandonoNaUra: 0 };
    j.total++;
    const tipo = tipoDaLigacao(ligacao);
    if (tipo) j[tipo]++;
    janelas.set(inicio, j);
  }
  return [...janelas.entries()].sort((a, b) => a[0] - b[0]).map(([, j]) => j);
}

const resumoDoCallback = (ligacao) => Object.fromEntries(Object.entries(ligacao).filter(([campo]) => CAMPO_DO_CALLBACK.test(campo)));

/**
 * @param {object[]} ligacoes - itens de `ligacoesDetalhadas` da Argus
 * @returns {{ total: number, campos: string[], resultados: object, linhaDoTempo: object[], callbacks: object[] }}
 */
function resumirLigacoes(ligacoes) {
  const limpas = ligacoes.map(semDadosDeCliente);
  return {
    total: limpas.length,
    campos: [...new Set(limpas.flatMap(Object.keys))].sort(),
    resultados: contarResultados(limpas),
    linhaDoTempo: linhaDoTempo(limpas),
    callbacks: limpas.filter((l) => tipoDaLigacao(l) === 'callback').map(resumoDoCallback),
  };
}

/**
 * Quem está na URA e em que grupo está LOGADO na telefonia (statusoperador.idGrupo,
 * "código do grupo logado" na doc 4.14). Estar no grupo da URA na lista de grupos
 * e logado em outro significa que a derivação dos robôs não chega na pessoa.
 * Só campos do operador: o último lead (dados do cliente) nunca é usado.
 * @param {string[]} ramais - ramais do grupo da URA (listargrupos)
 * @param {Map<string, object|null|Error>} statusPorRamal - statusOperador de cada um (null = deslogado)
 * @returns {Array<{ ramal, operador, grupoLogado, grupo, status, origemDerivacao, situacao: 'ok'|'outro grupo'|'deslogado'|'erro' }>}
 */
function conferirUra(ramais, statusPorRamal, grupoUraId) {
  return ramais.map((ramal) => {
    const s = statusPorRamal.get(String(ramal));
    if (s instanceof Error) return { ramal, situacao: 'erro' };
    if (!s) return { ramal, situacao: 'deslogado' };
    const naUra = Number(s.idGrupo) === Number(grupoUraId);
    return {
      ramal,
      operador: s.nome ?? null,
      grupoLogado: s.idGrupo ?? null,
      grupo: s.grupo ?? null,
      status: s.descricaoStatus ?? null,
      origemDerivacao: s.origemDerivacao ?? null,
      situacao: naUra ? 'ok' : 'outro grupo',
    };
  });
}

/** Minutos desde a meia-noite de `hora` (HH:MM), para "ultimosMinutos" pegar o dia todo. */
const minutosDesdeMeiaNoite = (hora) => {
  const [h, m] = String(hora).split(':').map(Number);
  return Math.max(1, h * 60 + m);
};

module.exports = {
  semDadosDeCliente, resumirLigacoes, minutosDesdeMeiaNoite, ehDeCliente, tipoDaLigacao, linhaDoTempo, minutoDoDia, conferirUra,
};
