# Build stage
FROM node:20-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Deploy stage
FROM node:20-bookworm-slim

RUN apt-get update && apt-get install -y ca-certificates procps && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY --from=builder /app/dist ./dist

CMD ["sh", "-c", "node dist/generate-api-creds.js && node dist/index.js"]
