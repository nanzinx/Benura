import { afterEach, describe, expect, it, vi } from 'vitest';
import { pedir } from './api';

const responder = (status: number, corpo: string, tipo = 'text/html') => vi.stubGlobal('fetch', vi.fn(async () => new Response(corpo, { status, headers: { 'Content-Type': tipo } })));

describe('erros dos pedidos', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('com o motivo do servidor, mostra o motivo', async () => {
    responder(503, JSON.stringify({ erro: 'Robôs da URA fora do ar. No PC do BenURA: npx pm2 logs benura-robos' }), 'application/json');
    await expect(pedir('PUT', '/api/robos/modo', { modo: 'automatico' })).rejects.toThrow(/Robôs da URA fora do ar/);
  });

  it('sem motivo (a página de erro da Cloudflare): diz que o servidor não respondeu e onde olhar', async () => {
    responder(502, '<html>Bad gateway</html>');
    await expect(pedir('PUT', '/api/robos/modo', {})).rejects.toThrow('O servidor do BenURA não respondeu (HTTP 502). Veja a aba Serviços.');
    responder(500, '');
    await expect(pedir('GET', '/api/visao')).rejects.toThrow('HTTP 500');
  });
});
