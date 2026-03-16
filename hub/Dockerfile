# ── Stage 1: build TypeScript ─────────────────────────────────────────────────
FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ── Stage 2: runtime ──────────────────────────────────────────────────────────
FROM node:22-alpine
WORKDIR /app

COPY package*.json ./
RUN npm ci --omit=dev

COPY --from=builder /app/dist ./dist

# Cloud Run / reverse proxy: single port, WebSocket shares HTTP server (no WS_PORT)
# Pi/local dual-port: set WS_PORT=3001 and expose both
EXPOSE 8080

CMD ["node", "dist/index.js"]
