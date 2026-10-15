'use strict';
/**
 * Tudo o que um serviço imprime também vai para arquivos de texto, um por dia:
 *
 *   logs/AAAA-MM-DD/<servico>.txt   tudo, em ordem, com a hora local (08:42:18)
 *   logs/AAAA-MM-DD/avisos.txt      só AVISO e ERRO, de todos os serviços
 *   logs/AAAA-MM-DD/callbacks.txt   só o raio-x de cada callback (linhas "CALLBACK")
 *
 * Copia o stdout e o stderr do processo (o que o logger, os scripts e um erro
 * fatal escrevem), sem mudar a saída: o PM2 continua com os arquivos dele.
 * Os segredos informados (token da Argus, WEBHOOK_TOKEN...) viram *** nos arquivos.
 * Pastas mais antigas que `dias` são apagadas na partida e na virada do dia.
 */

const fs = require('fs');
const path = require('path');

const PASTA_DO_DIA = /^\d{4}-\d{2}-\d{2}$/;
/** Timestamp ISO que o logger põe no começo da linha (vira a hora local). */
const ISO_NO_INICIO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\s*/;
const EH_AVISO = /\[(AVISO|ERRO)\]/;
const EH_CALLBACK = /\bCALLBACK\b/;

/** Data (AAAA-MM-DD) e hora (HH:MM:SS) no fuso. */
function relogioLocal(fuso) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: fuso, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
  return (data) => {
    const p = Object.fromEntries(fmt.formatToParts(data).map(({ type, value }) => [type, value]));
    return { dia: `${p.year}-${p.month}-${p.day}`, hora: `${p.hour}:${p.minute}:${p.second}` };
  };
}

/** Apaga as pastas de dia anteriores a `dias` dias antes de `hoje` (AAAA-MM-DD). */
function apagarAntigos(pasta, hoje, dias) {
  if (!(dias > 0)) return [];
  const limite = new Date(`${hoje}T12:00:00Z`);
  limite.setUTCDate(limite.getUTCDate() - dias);
  const corte = limite.toISOString().slice(0, 10);
  let nomes = [];
  try {
    nomes = fs.readdirSync(pasta);
  } catch {
    return [];
  }
  const antigos = nomes.filter((n) => PASTA_DO_DIA.test(n) && n < corte);
  for (const n of antigos) fs.rmSync(path.join(pasta, n), { recursive: true, force: true });
  return antigos;
}

/** Troca cada segredo (com 4+ caracteres) por ***. */
const mascarar = (segredos) => {
  const lista = segredos.filter((s) => typeof s === 'string' && s.length >= 4);
  return (texto) => lista.reduce((t, s) => t.split(s).join('***'), texto);
};

/**
 * @param {object} opcoes
 * @param {string} opcoes.servico - nome do arquivo do serviço (rodizio, roteador...)
 * @param {string} opcoes.pasta - pasta dos logs (LOGS_DIR)
 * @param {string} opcoes.fuso - FUSO_HORARIO
 * @param {number} [opcoes.dias] - LOGS_DIAS (0 = não apaga)
 * @param {string[]} [opcoes.segredos]
 * @param {string} [opcoes.cabecalho] - primeira linha (scripts: "=== execução ===")
 * @param {() => Date} [opcoes.agora]
 * @param {{ stdout: object, stderr: object }} [opcoes.saidas] - para os testes
 * @returns {{ parar(): void }} devolve o stdout/stderr originais e fecha os arquivos
 */
function gravarLogsEmArquivo({
  servico, pasta, fuso, dias = 30, segredos = [], cabecalho = '', agora = () => new Date(),
  saidas = { stdout: process.stdout, stderr: process.stderr },
}) {
  const relogio = relogioLocal(fuso);
  const limpar = mascarar(segredos);
  const abertos = new Map(); // arquivo → WriteStream do dia atual
  let diaAtual = null;

  const virarDia = (dia) => {
    if (dia === diaAtual) return;
    for (const s of abertos.values()) s.end();
    abertos.clear();
    diaAtual = dia;
    fs.mkdirSync(path.join(pasta, dia), { recursive: true });
    apagarAntigos(pasta, dia, dias);
  };
  const escrever = (arquivo, linha) => {
    if (!abertos.has(arquivo)) {
      const stream = fs.createWriteStream(path.join(pasta, diaAtual, arquivo), { flags: 'a' });
      stream.on('error', () => {}); // disco cheio ou arquivo aberto: o serviço não pode cair por causa do log
      abertos.set(arquivo, stream);
    }
    abertos.get(arquivo).write(`${linha}\n`);
  };

  const gravarLinha = (bruta, doStderr) => {
    if (!bruta.trim()) return;
    const { dia, hora } = relogio(agora());
    virarDia(dia);
    const texto = limpar(bruta.replace(ISO_NO_INICIO, ''));
    escrever(`${servico}.txt`, `${hora} ${texto}`);
    if (doStderr || EH_AVISO.test(texto)) escrever('avisos.txt', `${hora} [${servico}] ${texto}`);
    if (EH_CALLBACK.test(texto)) escrever('callbacks.txt', `${hora} ${texto}`);
  };

  const originais = [];
  for (const [nome, doStderr] of [['stdout', false], ['stderr', true]]) {
    const saida = saidas[nome];
    const original = saida.write;
    let resto = '';
    saida.write = function escreverTambemNoArquivo(pedaco, ...args) {
      try {
        const linhas = (resto + (Buffer.isBuffer(pedaco) ? pedaco.toString('utf8') : String(pedaco))).split(/\r?\n/);
        resto = linhas.pop();
        for (const linha of linhas) gravarLinha(linha, doStderr);
      } catch {
        /* o log em arquivo nunca derruba o serviço */
      }
      return original.call(this, pedaco, ...args);
    };
    originais.push(() => {
      saida.write = original;
      if (resto) gravarLinha(resto, doStderr);
    });
  }

  if (cabecalho) gravarLinha(`=== ${cabecalho} ===`, false);

  return {
    parar() {
      for (const restaurar of originais) restaurar();
      for (const s of abertos.values()) s.end();
      abertos.clear();
    },
  };
}

/**
 * Liga os arquivos de log de um serviço a partir da configuração (cfg.logs).
 * @returns {{ parar(): void }|null} null se LOGS_ARQUIVOS=0
 */
function ativarLogsEmArquivo(cfg, servico, extras = {}) {
  if (!cfg.logs?.arquivos) return null;
  return gravarLogsEmArquivo({
    servico,
    pasta: cfg.logs.pasta,
    fuso: cfg.agenda.fusoHorario,
    dias: cfg.logs.dias,
    segredos: [cfg.argus?.token, cfg.http?.tokenAdmin, cfg.carrossel?.token],
    ...extras,
  });
}

module.exports = { gravarLogsEmArquivo, ativarLogsEmArquivo, apagarAntigos };
