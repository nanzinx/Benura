# BenURA em container: os quatro serviços (roteador, rodízio, rotinas e painel) no PM2,
# dentro de um container só (eles conversam pelo localhost, como no servidor).
# A produção continua no PM2 como serviço do Windows; isto é a alternativa pronta.
# README: "Docker (alternativa)".
#
# [NOVO] Endurecido (o compose completa com read_only, cap_drop e no-new-privileges):
#  - duas etapas: a instalação (npm ci) fica fora da imagem final;
#  - o código é do root e só de leitura para o usuário "node", que roda tudo: um invasor
#    não consegue trocar o BenURA nem plantar código. Só /dados (volume), /run/benura e
#    /tmp (tmpfs) aceitam escrita;
#  - pacotes do sistema atualizados na construção.

# --- 1. Instalação das dependências ---
FROM node:22-bookworm-slim AS dependencias
WORKDIR /app
COPY package.json package-lock.json ./
# O PM2 é a única devDependency (e é preciso para rodar): npm ci completo, sem scripts de pacotes.
RUN npm ci --include=dev --ignore-scripts --no-audit --no-fund && npm cache clean --force

# --- 2. Imagem final ---
FROM node:22-bookworm-slim
RUN apt-get update && apt-get upgrade -y --no-install-recommends && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    TZ=America/Sao_Paulo \
    # Estado, chaves e logs no volume /dados (sobrevivem a recriar o container).
    DADOS_DIR=/dados \
    LOGS_DIR=/dados/logs \
    # Travas de instância única fora do volume: num container novo os PIDs se repetem e uma
    # trava velha com o PID de outro serviço impediria a subida (no compose, /run/benura é tmpfs).
    RODIZIO_LOCK_FILE=/run/benura/argus.lock \
    ROTEADOR_LOCK_FILE=/run/benura/roteador.lock \
    ROTINAS_LOCK_FILE=/run/benura/rotinas.lock \
    ATUALIZADOR_LOCK_FILE=/run/benura/atualizador.lock \
    # [NOVO] Com o disco só de leitura: o PM2 e o npx escrevem só nos tmpfs.
    PM2_HOME=/run/benura/pm2 \
    NPM_CONFIG_CACHE=/tmp/npm \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NO_UPDATE_NOTIFIER=1

WORKDIR /app
# O código e as dependências ficam do root (o usuário "node" só lê).
COPY --from=dependencias /app/node_modules ./node_modules
COPY . .
RUN chmod -R a-w /app \
 && mkdir -p /dados /run/benura \
 && chown node:node /dados /run/benura
USER node

VOLUME ["/dados"]
# 3000 rodízio (webhooks da Argus) · 3001 roteador (webhook de venda) · 3003 rotinas · 3010 painel
EXPOSE 3000 3001 3003 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3010/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# pm2-runtime fica em primeiro plano (o container vive enquanto ele vive) e repassa o
# desligamento gracioso aos serviços. O painel usa o mesmo PM2 (npx pm2 stop/startOrRestart).
CMD ["node", "node_modules/pm2/bin/pm2-runtime", "ecosystem.config.js"]
