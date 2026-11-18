# ---- build ---------------------------------------------------------------
FROM node:24-bookworm-slim AS build
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

# Árvore de produção separada: a runtime não precisa de tsx/tsc/eslint.
RUN mkdir -p /tmp/prod && cp package.json package-lock.json /tmp/prod/ \
    && cd /tmp/prod && npm ci --omit=dev --no-audit --no-fund

COPY tsconfig.json ./
COPY src ./src
RUN npm run build

COPY dashboard/package.json dashboard/package-lock.json ./dashboard/
RUN cd dashboard && npm ci --no-audit --no-fund
COPY dashboard ./dashboard
RUN cd dashboard && npm run build

# Chromium para auditoria de design (os binários são copiados para a runtime).
RUN npx playwright install chromium

# ---- runtime -------------------------------------------------------------
FROM node:24-bookworm-slim AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4310 \
    DATA_DIR=/app/data \
    PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright

COPY package.json package-lock.json ./
COPY --from=build /tmp/prod/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dashboard/dist ./dashboard/dist
COPY --from=build /root/.cache/ms-playwright /root/.cache/ms-playwright

# Bibliotecas do sistema necessárias ao Chromium headless.
RUN npx playwright install-deps chromium && rm -rf /var/lib/apt/lists/*

RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 4310

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD node -e "fetch('http://127.0.0.1:4310/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/cli/index.js", "serve"]
