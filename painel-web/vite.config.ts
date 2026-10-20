import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * O build vai direto para src/painel/publico (servido pelo benura-painel) e entra
 * no git: o PC do BenURA não precisa compilar nada. Nomes fixos (sem hash) deixam
 * o diff legível; o painel manda no-store, então não há cache velho.
 *
 * `npm run dev`: abre em http://localhost:5173 e manda /api para o painel em 3010.
 */
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../src/painel/publico',
    emptyOutDir: true,
    assetsDir: '',
    assetsInlineLimit: 0,
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        entryFileNames: 'painel.js',
        chunkFileNames: '[name].js',
        assetFileNames: (asset) => (asset.names?.some((n) => n.endsWith('.css')) ? 'painel.css' : '[name][extname]'),
      },
    },
  },
  server: { proxy: { '/api': 'http://localhost:3010' } },
  test: { environment: 'node' },
});
