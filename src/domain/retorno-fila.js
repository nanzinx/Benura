'use strict';
/**
 * Retorno de quem desistiu da fila da URA — regras puras.
 *
 * O webhook "Receptivo: Encerramento de URA" (tipo 5, doc 6.5) informa como a
 * ligação terminou. Cliente que ligou e não foi atendido é o lead mais quente
 * que existe: ele volta para a discadora como retorno.
 *
 *   conclusão 2 ABANDONOU FILA, 3 SEM AGENTE, 4 TIME-OUT FILA → incluir retorno
 *   conclusão 1 DERIVOU (o cliente ligou de novo e foi atendido) → remover retorno pendente
 */

const TIPO_ENCERRAMENTO_URA = 5;
const CONCLUSAO_DERIVOU = 1;

const MOTIVOS = Object.freeze({
  2: 'ABANDONOU_FILA',
  3: 'SEM_AGENTE',
  4: 'TIMEOUT_FILA',
});

const Acao = Object.freeze({ INCLUIR: 'INCLUIR', REMOVER: 'REMOVER' });

/**
 * Telefone em DDD + número (10 ou 11 dígitos). Remove o 55 do Brasil e zeros
 * de operadora. Número anônimo, curto ou inválido → null.
 */
function normalizarTelefone(bruto) {
  let digitos = String(bruto ?? '').replace(/\D/g, '').replace(/^0+/, '');
  if (digitos.length >= 12 && digitos.startsWith('55')) digitos = digitos.slice(2);
  if (digitos.length < 10 || digitos.length > 11) return null;
  if (/^(\d)\1+$/.test(digitos)) return null; // 0000000000, 9999999999...
  return digitos;
}

/** Código único do lead de retorno: permite incluir e, depois, remover exatamente ele. */
const codClienteDoRetorno = (telefone, dataIso) => `RETORNO-${telefone}-${dataIso.replace(/-/g, '')}`;

/**
 * Interpreta o webhook. A documentação escreve o campo de conclusão de duas
 * formas ("idConclusaoDerivacao" e "FidConclusaoDerivacao"); aceitamos as duas.
 *
 * @returns {{ acao: string, telefone: string, motivo?: string, servico?: string,
 *             quando?: string, foraHorario: boolean }|null}
 */
function interpretarEncerramentoUra(evento) {
  if (evento?.idTipoWebhook !== TIPO_ENCERRAMENTO_URA) return null;
  const telefone = normalizarTelefone(evento.telefone);
  if (!telefone) return null;

  const conclusao = evento.idConclusaoDerivacao ?? evento.FidConclusaoDerivacao;
  const base = { telefone, quando: evento.dataInicioUra || null, foraHorario: evento.foraHorario === true };
  if (conclusao === CONCLUSAO_DERIVOU) return { ...base, acao: Acao.REMOVER };

  const motivo = MOTIVOS[conclusao];
  if (!motivo) return null;
  return { ...base, acao: Acao.INCLUIR, motivo, servico: evento.servicoDesc || null };
}

/**
 * O mesmo telefone já gerou retorno dentro da janela? (cliente que liga 3 vezes
 * seguidas e desiste vira UM retorno, não três)
 */
function jaTemRetorno(pendentes, telefone, agora, janelaMs) {
  const existente = pendentes[telefone];
  return Boolean(existente) && agora - existente.incluidoEm < janelaMs;
}

/** Remove pendências mais antigas que a janela (o estado não cresce para sempre). */
function limparExpirados(pendentes, agora, janelaMs) {
  return Object.fromEntries(Object.entries(pendentes).filter(([, p]) => agora - p.incluidoEm < janelaMs));
}

/** Corpo do /novo (doc 2.4). */
function montarLead({ telefone, motivo, servico, quando }, { codCliente, origem }) {
  return {
    telefone1: telefone,
    codCliente,
    origem,
    info0: motivo,
    info1: servico || '',
    ...(quando ? { data0: quando } : {}),
    detalhes: `Cliente ligou na URA e não foi atendido (${motivo}).`,
  };
}

module.exports = {
  Acao, MOTIVOS, normalizarTelefone, codClienteDoRetorno, interpretarEncerramentoUra,
  jaTemRetorno, limparExpirados, montarLead,
};
