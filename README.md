# Benura — Automações da discadora Argus

| Script | O que faz |
|---|---|
| `roteador-vendas.js` | Distribui vendedores entre **URA** e **Ativo** com base nas vendas da **API do Carrossel** |
| `argus-automacao.js` | Rodízio Ativo ↔ URA por atendimento e liga/desliga dos robôs da URA |

## Roteador de Vendas

### Regras de negócio
1. **Carga inicial** (primeiro ciclo do expediente): quem vendeu **mais** que `META_DIARIA` no dia útil anterior vai para a URA; os demais (inclusive quem não vendeu nada), para o Ativo.
2. **Gatilho**: quem está no Ativo e faz qualquer venda hoje sobe para a URA e fica lá até o fim do dia.
3. **Reset**: no dia seguinte (no fuso `FUSO_HORARIO`) o ciclo recomeça.

### Como rodar
```bash
npm install
cp .env.example .env   # ajuste URL do Carrossel, token da Argus e IDs de grupo
cp vendedores-ramais.example.json vendedores-ramais.json   # nome → ramal de cada vendedor
npm start
```
Desenvolvimento sem rede: `npm run dev` (dados mock + DRY_RUN).
Com mock HTTP de Carrossel + Argus: `npm run mock` e veja `.env.example`.
Testes: `npm test`.

### Arquitetura
```
roteador-vendas.js                 ponto de entrada
src/app.js                         composition root + ciclo de vida
src/config/                        variáveis de ambiente (dotenv) + validação
src/http/server.js, controllers.js rotas → controladores (sem regra de negócio)
src/services/roteamento.service.js casos de uso: carga inicial, monitoramento, webhook
src/services/agendador.js          loop único, sem sobreposição, respeita expediente
src/domain/                        regras puras (meta, gatilho)
src/integrations/carrossel/        client HTTP → mapper (anti-corrupção) → service (fallback)
src/integrations/argus/            client HTTP → DiscadoraService (isola a URA)
src/repositories/                  estado diário (JSON atômico + .bak) e cadastro nome → ramal
```

### Independência da URA
O `DiscadoraService` é a única porta para a Argus e segue estas regras:
- **A Argus é a fonte da verdade**: antes de transferir, consulta em que grupo o ramal está.
- **Idempotência**: se o ramal já está no destino (ex.: movido à mão), nada é enviado.
- **Grupos externos respeitados**: quem foi colocado manualmente em outro grupo (treinamento, supervisão…) não é puxado de volta (`RESPEITAR_GRUPOS_EXTERNOS=1`).
- **Sem reconciliação contínua**: o roteador só age em eventos (carga do dia, venda detectada), nunca "corrige" a URA periodicamente.
- **Falhas não derrubam nada**: transferências que falharam ficam pendentes e são re-tentadas (até 5×/dia).

### API do Carrossel
Consome `GET {CARROSSEL_API_URL}/ranking/vendedores` do Carrosel-BenApi, que devolve
`{ hoje: [...], ontem: [...], semanal, mensal, ultimaExtracao, diaOntem }`.
- **Total vendido**: campo `CARROSSEL_METRICA` (padrão `vendaConcluida`) da linha `GERAL` de `performance`.
- **"Ontem"** é o dia útil anterior calculado pelo próprio Carrossel (pula fim de semana e feriados).
- **Atualização**: o Carrossel refaz o scraping a cada 6 min; um poll de 1 min é suficiente.
- Se o Carrossel responder `ultimaExtracao: "Erro"` ou vier sem vendas de ontem, a carga do dia é adiada e tentada de novo.
- Só `src/integrations/carrossel/carrossel.mapper.js` conhece esse formato.

### Cadastro nome → ramal (`vendedores-ramais.json`)
O Carrossel identifica vendedores **só pelo nome**; a Argus só entende **ramal**. O arquivo faz a ponte:
```json
{ "ANA CLARA SOUZA": "1001", "RICARDO MENDES": "1004" }
```
- Nomes devem ser os mesmos do Carrossel (coluna *Agente*); acento, maiúsculas e espaços extras são ignorados.
- Só quem está no cadastro é roteado. Quem aparece no Carrossel sem cadastro gera um aviso no log e é ignorado.
- Quem está no cadastro e não aparece no "ontem" do Carrossel vendeu R$ 0 e vai para o Ativo.
- O arquivo é relido automaticamente quando muda; se ficar inválido, a versão anterior continua valendo.

### Endpoints HTTP
| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/health` | — | saúde do serviço |
| GET | `/status` | — | vendedores por fila, pendências |
| POST | `/recarregar` | token | refaz a carga inicial |
| POST | `/webhook/venda` | token | `{ "ramal": "1004", "valor": 1500 }` |

Token: `Authorization: Bearer <WEBHOOK_TOKEN>` ou `X-Webhook-Token: <WEBHOOK_TOKEN>`.
