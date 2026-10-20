'use strict';
/**
 * Painel da supervisão — funções puras que leem as linhas dos logs do dia
 * (logs/AAAA-MM-DD/*.txt, veja utils/logs-em-arquivo.js). Sem I/O.
 *
 *  - rodizio.txt   "08:42:18 [INFO] [rodizio] URA: livres 2→1 | humanos 5 | robôs ligados 10 (alvo 7)..."
 *                  → linha do tempo dos livres e dos robôs;
 *  - callbacks.txt "09:46:20 [AVISO] [callbacks] CALLBACK 09:46:13 Oper Virtual 7, 12 s | conclusão | ..."
 *                  → callbacks do dia com o raio-x;
 *  - avisos.txt    "08:42:18 [rodizio] [AVISO] [robos] ..." → últimos avisos e erros.
 */

const MUDANCA_DE_LIVRES = /^(\d{2}:\d{2}:\d{2}) .*?URA: livres \S+→(\d+) \| humanos (\d+) \| robôs ligados (\d+|\?)/;
const CALLBACK = /^(\d{2}:\d{2}:\d{2}) .*?\bCALLBACK (\d{2}:\d{2}:\d{2})(?: ([^,|]+?))?, (\d+) s(?: \| (.*))?$/;
const AVISO = /^(\d{2}:\d{2}:\d{2}) \[([^\]]+)\] (?:\[(AVISO|ERRO)\] )?(?:\[[^\]]*\] )?(.*)$/;

/** @returns {{ hora: string, livres: number, humanos: number, robos: number|null }|null} */
function lerMudancaDeLivres(linha) {
  const m = MUDANCA_DE_LIVRES.exec(linha);
  if (!m) return null;
  return { hora: m[1], livres: Number(m[2]), humanos: Number(m[3]), robos: m[4] === '?' ? null : Number(m[4]) };
}

/**
 * @returns {{ hora: string, robo: string|null, duracaoSeg: number, conclusao: string|null, detalhes: string[] }|null}
 *          `hora` é a do início da ligação do robô
 */
function lerCallback(linha) {
  const m = CALLBACK.exec(linha);
  if (!m) return null;
  const [conclusao = null, ...detalhes] = (m[5] || '').split(' | ').map((p) => p.trim()).filter(Boolean);
  return { hora: m[2], robo: m[3]?.trim() || null, duracaoSeg: Number(m[4]), conclusao, detalhes };
}

/** @returns {{ hora: string, servico: string, nivel: 'AVISO'|'ERRO', texto: string }|null} */
function lerAviso(linha) {
  const m = AVISO.exec(linha);
  if (!m) return null;
  return { hora: m[1], servico: m[2], nivel: m[3] === 'ERRO' ? 'ERRO' : 'AVISO', texto: m[4].trim() };
}

/** "08:42:18" → segundos desde a meia-noite. */
const segundosDoDia = (hora) => {
  const [h, m, s] = hora.split(':').map(Number);
  return h * 3600 + m * 60 + s;
};

/**
 * A Argus está aceitando o token? Olha os avisos: "recusou o token" nos últimos
 * `janelaSeg` segundos (e nenhum ciclo bom depois, que o chamador confere) = não.
 */
function tokenRecusadoRecentemente(avisos, agoraSeg, janelaSeg = 15 * 60) {
  return avisos.some((a) => /recusou o token/i.test(a.texto) && agoraSeg - segundosDoDia(a.hora) <= janelaSeg && agoraSeg >= segundosDoDia(a.hora));
}

module.exports = { lerMudancaDeLivres, lerCallback, lerAviso, segundosDoDia, tokenRecusadoRecentemente };
