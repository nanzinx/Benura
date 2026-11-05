import { describe, expect, it } from 'vitest';
import { abaDoEndereco, CAMINHOS, definirTitulo, tituloDaAba } from './rotas';

describe('endereços das abas, sem #', () => {
  it('cada aba tem o seu caminho; a visão geral é a raiz', () => {
    expect(CAMINHOS).toEqual({ visao: '/', relatorios: '/relatorios', receptivo: '/receptivo', ura: '/robos', esteira: '/esteira', servicos: '/servicos', ajuda: '/ajuda' });
  });

  it('lê a aba do caminho (com ou sem barra no fim, maiúsculas)', () => {
    expect(abaDoEndereco('/')).toBe('visao');
    expect(abaDoEndereco('/receptivo')).toBe('receptivo');
    expect(abaDoEndereco('/robos/')).toBe('ura');
    expect(abaDoEndereco('/Ajuda')).toBe('ajuda');
    expect(abaDoEndereco('/relatorios')).toBe('relatorios');
    expect(abaDoEndereco('/nao-existe')).toBe('visao');
  });

  it('os links antigos com # ainda abrem a aba certa', () => {
    expect(abaDoEndereco('/', '#servicos')).toBe('servicos');
    expect(abaDoEndereco('/', '#ura')).toBe('ura');
    expect(abaDoEndereco('/', '#visao')).toBe('visao');
    expect(abaDoEndereco('/esteira', '#lixo')).toBe('esteira');
  });

  it('o título da guia do navegador diz a aba', () => {
    expect(tituloDaAba('visao')).toBe('BenURA · Visão geral');
    expect(tituloDaAba('ura')).toBe('BenURA · URA e robôs');
  });

  it('trocar de aba não apaga o aviso de cliente de risco, e o aviso não volta a aba antiga', () => {
    const doc = { title: '' };
    (globalThis as { document?: unknown }).document = doc;
    definirTitulo({ aba: 'servicos' });
    expect(doc.title).toBe('BenURA · Serviços');
    definirTitulo({ risco: true });
    expect(doc.title).toBe('⚠ Cliente de risco · BenURA · Serviços');
    definirTitulo({ aba: 'receptivo' });
    expect(doc.title, 'o aviso fica').toBe('⚠ Cliente de risco · BenURA · Receptivo URA');
    definirTitulo({ risco: false });
    expect(doc.title, 'e sai sem voltar a aba antiga').toBe('BenURA · Receptivo URA');
    delete (globalThis as { document?: unknown }).document;
  });
});
