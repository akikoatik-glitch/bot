FROM node:22-slim

WORKDIR /app

# Copy bot code
COPY telegram-bot/package*.json ./
COPY telegram-bot/src ./src
COPY telegram-bot/test ./test
COPY telegram-bot/README.md ./
COPY telegram-bot/.env.example ./

# Copy the parent site's dixon_coles.js (re-used by the bot engine)
COPY scripts/dixon_coles.js ../scripts/dixon_coles.js

RUN npm ci --omit=dev

# Healthcheck
HEALTHCHECK --interval=60s --timeout=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:' + (process.env.WEB_PORT||8080) + '/healthz', r => process.exit(r.statusCode===200?0:1)).on('error', () => process.exit(1))"

ENV NODE_ENV=production
EXPOSE 8080

CMD ["node", "src/index.js"]
