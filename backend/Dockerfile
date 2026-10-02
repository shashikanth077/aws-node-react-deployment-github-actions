# syntax=docker/dockerfile:1

# ---- Stage 1: install production dependencies only ----
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# ---- Stage 2: small runtime image ----
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app

# Amazon RDS CA bundle, so the MySQL connection can be encrypted AND verified (DB_SSL=true)
ADD https://truststore.pki.rds.amazonaws.com/global/global-bundle.pem /app/certs/rds-global-bundle.pem

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY db ./db

# Never run as root inside the container
RUN chown -R node:node /app
USER node

EXPOSE 3000

# Used by `docker run` / docker compose. ECS ignores this and uses the task definition's healthCheck.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health || exit 1

CMD ["node", "src/server.js"]
