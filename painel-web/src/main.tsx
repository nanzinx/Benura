import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { SemSessao } from './api';
import { App, sessaoAcabou } from './App';
import { ProvedorDeRetorno } from './ui/retorno';
import './index.css';

// Qualquer 401 (sessão vencida ou senha trocada) volta para a entrada.
const aoErrar = (e: Error) => { if (e instanceof SemSessao) sessaoAcabou(); };
const cliente = new QueryClient({
  queryCache: new QueryCache({ onError: aoErrar }),
  mutationCache: new MutationCache({ onError: aoErrar }),
  defaultOptions: { queries: { retry: (n, e) => !(e instanceof SemSessao) && n < 1, staleTime: 2000 } },
});

createRoot(document.getElementById('raiz')!).render(
  <StrictMode>
    <QueryClientProvider client={cliente}>
      <ProvedorDeRetorno>
        <App />
      </ProvedorDeRetorno>
    </QueryClientProvider>
  </StrictMode>,
);
