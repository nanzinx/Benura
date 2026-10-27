import { describe, expect, it } from 'vitest';
import { crc32, criarXlsx, letraDaColuna } from './planilha';

/** Lê um zip "stored" (sem compressão), como o criarXlsx grava: nome → texto. */
function lerZip(bytes: Uint8Array): Record<string, string> {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const arquivos: Record<string, string> = {};
  let i = 0;
  while (v.getUint32(i, true) === 0x04034b50) {
    const metodo = v.getUint16(i + 8, true);
    const crc = v.getUint32(i + 14, true);
    const tamanho = v.getUint32(i + 18, true);
    const nomeLen = v.getUint16(i + 26, true);
    const extraLen = v.getUint16(i + 28, true);
    const nome = new TextDecoder().decode(bytes.subarray(i + 30, i + 30 + nomeLen));
    const dados = bytes.subarray(i + 30 + nomeLen + extraLen, i + 30 + nomeLen + extraLen + tamanho);
    expect(metodo).toBe(0);
    expect(crc32(dados)).toBe(crc);
    arquivos[nome] = new TextDecoder().decode(dados);
    i += 30 + nomeLen + extraLen + tamanho;
  }
  expect(v.getUint32(i, true)).toBe(0x02014b50); // depois dos arquivos, o diretório central
  return arquivos;
}

describe('planilha (.xlsx)', () => {
  it('CRC-32 padrão', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
  });

  it('colunas A, Z, AA', () => {
    expect([letraDaColuna(0), letraDaColuna(25), letraDaColuna(26), letraDaColuna(27)]).toEqual(['A', 'Z', 'AA', 'AB']);
  });

  it('cada aba vira uma planilha; texto escapado, número como número, cabeçalho em negrito', () => {
    const zip = lerZip(criarXlsx([
      { nome: 'Relatório do dia', linhas: [['Hora', 'Leads'], ['08h', 12], ['<Total> & "fim"', 12.5]] },
      { nome: 'Por atendente', linhas: [['Nome'], ['Ana']] },
    ]));
    expect(Object.keys(zip)).toEqual(expect.arrayContaining(['[Content_Types].xml', '_rels/.rels', 'xl/workbook.xml', 'xl/styles.xml', 'xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml']));
    expect(zip['xl/workbook.xml']).toContain('name="Relatório do dia"');
    const s1 = zip['xl/worksheets/sheet1.xml']!;
    expect(s1).toContain('<c r="B2"><v>12</v></c>');
    expect(s1).toContain('&lt;Total&gt; &amp; &quot;fim&quot;');
    expect(s1).toMatch(/<c r="A1" t="inlineStr" s="1">/);
  });

  it('nome de aba inválido no Excel é limpo e cortado em 31', () => {
    const zip = lerZip(criarXlsx([{ nome: 'Dia 27/10: [manhã]? e mais um texto longo', linhas: [] }]));
    const nome = /name="([^"]+)"/.exec(zip['xl/workbook.xml']!)![1]!;
    expect(nome.length).toBeLessThanOrEqual(31);
    expect(nome).not.toMatch(/[\\/?*[\]:]/);
  });
});
