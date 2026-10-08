'use strict';
/**
 * Leitura de arquivos JSON de configuração que podem ser editados com o
 * processo rodando (ex.: exceções de ramal e de supervisor).
 */

const fs = require('fs');

/** @returns {{ stat?: fs.Stats, erro?: NodeJS.ErrnoException }} */
function statSeguro(caminho) {
  try {
    return { stat: fs.statSync(caminho) };
  } catch (erro) {
    return { erro };
  }
}

/** @returns {{ dados?: *, erro?: Error }} */
function lerJson(caminho) {
  try {
    return { dados: JSON.parse(fs.readFileSync(caminho, 'utf8')) };
  } catch (erro) {
    return { erro };
  }
}

/**
 * Observa um arquivo JSON e só o relê quando ele muda no disco.
 *
 * `verificar()` devolve o que aconteceu desde a última chamada:
 *   - 'inalterado'  nada mudou (ou continua ausente);
 *   - 'ausente'     o arquivo deixou de existir ou não pode ser acessado;
 *   - 'invalido'    mudou, mas o conteúdo não é JSON válido;
 *   - 'atualizado'  mudou e `dados` traz o conteúdo novo.
 *
 * Um arquivo inválido não é relido até mudar de novo, então quem chama pode
 * manter a última versão boa sem repetir o erro a cada ciclo.
 */
class ArquivoJsonObservado {
  constructor(caminho) {
    this.caminho = caminho;
    this.mtimeMs = null; // null = nunca verificado; 0 = ausente
  }

  /** @returns {{ estado: 'inalterado'|'ausente'|'invalido'|'atualizado', dados?: *, erro?: Error }} */
  verificar() {
    if (!this.caminho) return { estado: 'inalterado' };

    const { stat, erro } = statSeguro(this.caminho);
    if (!stat) return this.marcarAusente(erro);
    if (stat.mtimeMs === this.mtimeMs) return { estado: 'inalterado' };

    this.mtimeMs = stat.mtimeMs;
    const lido = lerJson(this.caminho);
    if (lido.erro) return { estado: 'invalido', erro: lido.erro };
    return { estado: 'atualizado', dados: lido.dados };
  }

  marcarAusente(erro) {
    if (this.mtimeMs === 0) return { estado: 'inalterado' };
    this.mtimeMs = 0;
    return { estado: 'ausente', erro: erro?.code === 'ENOENT' ? undefined : erro };
  }
}

module.exports = { ArquivoJsonObservado, lerJson };
