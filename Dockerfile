# BenURA em container: os quatro serviços (roteador, rodízio, rotinas e painel) no PM2,
# dentro de um container só (eles conversam pelo localhost, como no servidor).
# A produção continua no PM2 como serviço do Windows; isto é a alternativa pronta.
# README: "Docker (alternativa)".
FROM node:22-bookworm-slim

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
    ATUALIZADOR_LOCK_FILE=/run/benura/atualizador.lock

WORKDIR /app

# Só o necessário para instalar (o PM2 está nas devDependencies: precisa do npm ci completo).
COPY package.json package-lock.json ./
RUN npm ci --include=dev --no-audit --no-fund && npm cache clean --force

# O código (o .dockerignore deixa de fora .env, estado, logs, chaves e o painel-web).
COPY --chown=node:node . .

RUN mkdir -p /dados /run/benura && chown -R node:node /dados /run/benura /app
USER node

VOLUME ["/dados"]
# 3000 rodízio (webhooks da Argus) · 3001 roteador (webhook de venda) · 3003 rotinas · 3010 painel
EXPOSE 3000 3001 3003 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=40s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:3010/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

# pm2-runtime fica em primeiro plano (o container vive enquanto ele vive) e repassa o
# desligamento gracioso aos serviços. O painel usa o mesmo PM2 (npx pm2 stop/startOrRestart).
CMD ["node", "node_modules/pm2/bin/pm2-runtime", "ecosystem.config.js"]
