FROM node:20-bookworm-slim AS deps
WORKDIR /app
COPY frontend/package*.json ./
RUN npm ci

FROM node:20-bookworm-slim AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
# Rewrites in next.config.ts read this at build time; without it, /api proxies to localhost inside the image.
ARG API_BACKEND_URL=http://localhost:3001
ENV API_BACKEND_URL=${API_BACKEND_URL}
COPY --from=deps /app/node_modules ./node_modules
COPY frontend/ .
RUN npm run build

FROM node:20-bookworm-slim AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/next.config.ts ./next.config.ts

EXPOSE 3000
CMD ["/bin/sh", "-ec", "npm run start -- --port ${PORT:-3000}"]
