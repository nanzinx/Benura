# Benura — Automações da discadora Argus

| Script | O que faz |
|---|---|
| `roteador-vendas.js` | Distribui vendedores entre **URA** e **Ativo** com base nas vendas da **API do Carrossel** |
| `cadastrar-operador.js` | Prepara e confere o cadastro de operadores na Argus a partir do login no **Vanguard** |
| `argus-automacao.js` | Rodízio Ativo ↔ URA por atendimento e liga/desliga dos robôs da URA (lógica em `src/rodizio/`) |

## Roteador de Vendas

### Regras de negócio
1. **Carga inicial** (primeiro ciclo do expediente): quem vendeu **mais** que `META_DIARIA` no dia útil anterior vai para a URA; os demais (inclusive quem não vendeu nada), para o Ativo — o grupo **do próprio supervisor**.
2. **Gatilho**: quem está no Ativo e faz qualquer venda hoje sobe para a URA e fica lá até o fim do dia.
3. **Reset**: no dia seguinte (no fuso `FUSO_HORARIO`) o ciclo recomeça.

### Como rodar
```bash
npm install
cp .env.example .env   # URL do Carrossel, token da Argus, GRUPO_URA_ID e GRUPOS_ATIVOS_IDS
npm start
```
Desenvolvimento sem rede: `npm run dev` (Carrossel e Argus simulados em memória).
Simulação completa com PM2: veja [Rodando com PM2](#rodando-com-pm2).
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
src/integrations/argus/            client HTTP → DiretorioOperadores (usuários) → DiscadoraService (isola a URA)
src/integrations/vanguard/         fonte de dados de funcionários (hoje: manual)
src/services/cadastro-operador.service.js  planejar / conferir cadastro de operador
src/repositories/                  estado diário, exceções de ramal, auditoria (JSONL)
src/rodizio/                       rodízio Ativo ↔ URA e robôs (regras puras em src/domain/rodizio.js)
src/utils/                         HTTP com retry, persistência atômica, trava de processo, laços periódicos
```

### Independência da URA
O `DiscadoraService` é a única porta para a Argus e segue estas regras:
- **A Argus é a fonte da verdade**: antes de transferir, consulta em que grupo o ramal está.
- **Idempotência**: se o ramal já está no destino (ex.: movido à mão), nada é enviado.
- **Grupos externos respeitados**: quem foi colocado manualmente em outro grupo (treinamento, supervisão…) não é puxado de volta (`RESPEITAR_GRUPOS_EXTERNOS=1`).
- **Sem reconciliação contínua**: o roteador só age em eventos (carga do dia, venda detectada), nunca "corrige" a URA periodicamente.
- **Falhas não derrubam nada**: transferências que falharam ficam pendentes e são re-tentadas (até 5×/dia).
- **Ativo = grupo do supervisor**: o Ativo são vários grupos (`GRUPOS_ATIVOS_IDS`), um por supervisor. Quem já está em qualquer um deles fica onde está; quem volta da URA vai para o grupo do próprio supervisor.

### API do Carrossel
Consome `GET {CARROSSEL_API_URL}/ranking/vendedores` do Carrosel-BenApi, que devolve
`{ hoje: [...], ontem: [...], semanal, mensal, ultimaExtracao, diaOntem }`.
- **Total vendido**: campo `CARROSSEL_METRICA` (padrão `vendaConcluida`) da linha `GERAL` de `performance`.
- **"Ontem"** é o dia útil anterior calculado pelo próprio Carrossel (pula fim de semana e feriados).
- **Atualização**: o Carrossel refaz o scraping a cada 6 min; um poll de 1 min é suficiente.
- Se o Carrossel responder `ultimaExtracao: "Erro"` ou vier sem vendas de ontem, a carga do dia é adiada e tentada de novo.
- Só `src/integrations/carrossel/carrossel.mapper.js` conhece esse formato.

### Vendedor do Carrossel → ramal da Argus (automático)
O Carrossel identifica vendedores **só pelo nome**; a Argus só entende **ramal**. A ponte é feita
automaticamente pelo `/listarusuarios` da Argus, que traz nome, login, ramal, grupo e supervisor de todos os usuários.
- Nomes são comparados sem acento, maiúsculas ou espaços extras.
- **Universo da carga**: operadores ativos que estão hoje na URA ou em algum grupo do Ativo. Quem não aparece no "ontem" do Carrossel vendeu R$ 0.
- **Grupo de cada supervisor**: inferido pelo grupo do Ativo onde está a maioria dos operadores dele (não depende do nome do grupo).
- **Exceções** (opcionais, relidas a quente):
  - `vendedores-ramais.json` — nome no Carrossel diferente do nome na Argus, ou homônimos: `{ "NOME NO CARROSSEL": "2266111" }`
  - `supervisores-grupos.json` — supervisor cujo grupo não é identificado: `{ "NOME DO SUPERVISOR": 12 }`

## Cadastro de operadores (Vanguard → Argus)

A **API da Argus não tem comando para criar usuários**, então o fluxo é semiautomático: o script
prepara tudo, a pessoa só copia a ficha no programa da Argus, e o script confere depois.

```bash
# 1. Gera a ficha (verifica duplicidade, descobre supervisor, grupo e campanha)
npm run cadastro -- planejar YASMIN.FERREIRA@36241 \
  --nome "YASMIN FERREIRA DE JESUS" --supervisor "MAYSA DE FATIMA SIQUEIRA DOS SANTOS CARNEIRO"

# 2. Argus › Config. › Usuários Operadores › Novo Usuário Operador — copiar a ficha

# 3. Confere grupo e supervisor; --corrigir transfere para o grupo certo pela API
npm run cadastro -- conferir YASMIN.FERREIRA@36241 \
  --supervisor "MAYSA DE FATIMA SIQUEIRA DOS SANTOS CARNEIRO" --corrigir
```

| Vanguard (Sistema Corban) | Argus |
|---|---|
| Usuário `YASMIN.FERREIRA@36241` | Login `YASMIN.FERREIRA` (sem o `@agência`) |
| Agência `36241 - MAYSA ...` | Supervisor MAYSA → grupo do Ativo dela |
| Perfil "Operador Call Center" | Usuário Operador |

**Planejar** retorna `PRONTO_PARA_CADASTRO`, `PENDENTE` (falta decidir supervisor/grupo), `JA_EXISTE`
(login já existe — se inativo, reative em vez de criar) ou `BLOQUEADO` (perfil não-operador, inativo no Vanguard, login inválido).
Também avisa sobre homônimos e sugere o próximo "Ramal Integração" livre.

**Conferir** retorna `OK`, `CORRIGIDO`, `DIVERGENTE`, `INCONCLUSIVO` ou `NAO_ENCONTRADO`. Nunca tira da URA
quem está lá (pode ser o rodízio). Supervisor errado vira pendência: a API não altera supervisor.

Toda execução vai para `auditoria-cadastro.jsonl` (uma linha JSON por evento, com quem executou).
Saída em JSON com `--json`; código de saída 0 = ok, 2 = precisa de atenção, 1 = erro.

**Dados do Vanguard**: por enquanto informados com `--nome`/`--supervisor`. Quando o Carrossel ganhar a rota
`GET /api/funcionarios/:login`, basta uma fonte nova com o mesmo contrato de `src/integrations/vanguard/fonte-manual.js`.

### Endpoints HTTP do roteador
| Método | Rota | Auth | Descrição |
|---|---|---|---|
| GET | `/health` | — | saúde do serviço |
| GET | `/status` | — | vendedores por fila, pendências |
| POST | `/recarregar` | token | refaz a carga inicial |
| POST | `/webhook/venda` | token | `{ "ramal": "1004", "valor": 1500 }` |

Token: `Authorization: Bearer <WEBHOOK_TOKEN>` ou `X-Webhook-Token: <WEBHOOK_TOKEN>`.

## Rodízio Ativo ↔ URA e robôs (`argus-automacao.js`)

### Regras
1. **Ativo → URA**: operador do Ativo que **atendeu** uma ligação e ficou **livre** vai para a URA. Se ficar offline antes, perde esse histórico.
2. **URA → Ativo**: depois de `TEMPO_MIN` minutos (fora de atendimento), ou na hora se ficar offline, volta ao **grupo de origem**.
   Só volta quem o próprio rodízio colocou na URA — quem já era da URA, ou foi colocado lá pelo roteador ou à mão, não é tocado.
3. **Robôs**: desligados quando ninguém na URA pode atender (todos ocupados/em pausa, URA vazia ou toda offline, ou a Argus sem responder);
   religados quando algum humano fica livre (após `MIN_ROBOS_OFF_MS`).
4. **Webhook** (`POST /webhook?token=...`): o início de atendimento chega antes do polling e desliga os robôs na hora.

### Testes de comportamento
`npm run test:cenarios` sobe uma Argus falsa e roda o rodízio de verdade em 15 cenários (ida, volta, robôs, webhook, correções).
A mesma suíte roda contra outra versão do script: `node test/rodizio/cenarios.js caminho/para/versao.js` — foi assim que a
refatoração foi comparada com o script original.

### Correções em relação ao script original
- **HTTP 403** (token inválido) era tratado como limite de requisições e o script pausava para sempre em silêncio; agora é um erro claro sobre o token. Limite de requisições de verdade é o **429**.
- **Trava órfã**: depois de uma queda abrupta, `argus.lock` impedia o reinício (o PM2 ficava em loop). Agora a trava guarda o PID e é reaproveitada se o processo dono não existe mais.
- **Webhook tipo 5**: a documentação da Argus escreve `FidConclusaoDerivacao` no exemplo; os dois nomes são aceitos.
- **Rodada lenta**: o alerta de ciclo lento nunca disparava; agora avisa quando uma rodada passa de 5 s.

### Mudança de configuração
A porta e os arquivos passaram a ter nomes próprios, para rodar ao lado do roteador com o mesmo `.env`:
`RODIZIO_PORT` (padrão 3000, antes `PORT`), `RODIZIO_STATE_FILE` (padrão `state.json`) e `RODIZIO_LOCK_FILE` (padrão `argus.lock`).
As demais variáveis continuam com o mesmo nome. O `state.json` existente é aproveitado.

## Rodando com PM2

O PM2 já vem como dependência de desenvolvimento: depois do `npm install`, os comandos abaixo funcionam
sem instalar nada global (Windows, Linux ou macOS). Requer Node.js 22 LTS ou superior.

### Simulação local (sem Carrossel nem Argus reais)

Sobe dois processos: `benura-mock` (imita as APIs do Carrossel e da Argus na porta 8081) e
`benura-roteador-sim` (o roteador de verdade, na porta 3001, apontando para o mock).
O `.env` **não** é lido nessa simulação, então um `.env` de produção na pasta não interfere.

```bash
npm install
npm run sim:iniciar              # sobe tudo (e limpa o estado da simulação anterior)
npm run sim:status               # quem está na URA e no Ativo
npm run sim:logs                 # acompanha os logs (Ctrl+C para sair)
npm run sim:venda -- 1006 2500   # simula uma venda do ramal 1006 via webhook
npm run sim:parar                # derruba tudo
```

O que acontece na simulação:
1. **Carga inicial**: quem vendeu mais de R$ 50 mil "ontem" vai para a URA (1001, 1002, 1003); os demais ficam no Ativo, cada um no grupo do seu supervisor.
2. **Após 2 min**: RICARDO MENDES (1004) vende no "Carrossel" e o roteador o sobe para a URA sozinho. **Após 5 min**: JULIANA ALVES (1005).
3. **Webhook**: `sim:venda` promove na hora quem estiver no Ativo.

Estado e logs da simulação ficam em `.simulacao/`. `npx pm2 monit` abre um painel com CPU, memória e logs.

### Produção

Usa o `.env` (copie de `.env.example`).

```bash
npm run pm2:iniciar      # sobe o benura-roteador e o benura-rodizio
npx pm2 start ecosystem.config.js --only benura-rodizio   # só um deles
npx pm2 logs
npm run pm2:parar
```

Sem configuração válida o roteador não sobe: o motivo aparece em `logs/roteador.err.log` e o PM2 tenta de novo com espera crescente.
O desligamento é gracioso (o estado do dia é salvo antes de sair), inclusive no Windows.
Para iniciar junto com o sistema: `npx pm2 save` e `npx pm2 startup` (Linux/macOS); no Windows, use o pacote `pm2-installer`.

