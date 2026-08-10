FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci
COPY tsconfig.egress.json ./
COPY src ./src
RUN npm run build:egress

FROM node:22-bookworm-slim AS runtime
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates libxml2-utils openssl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /opt/turnkey
ENV NODE_ENV=production \
    EGRESS_HOST=127.0.0.1 \
    EGRESS_PORT=8788 \
    TURNKEY_XSD_ROOT=/opt/turnkey/schemas/xsd
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev
COPY --from=build /app/dist/egress ./dist/egress
COPY schemas ./schemas
USER node
CMD ["node", "dist/egress/egress/server.js"]
