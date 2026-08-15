# ============================================================
# Engram MCP server — built from this repository's source
# ============================================================
# Debian slim, NOT Alpine: sqlite-vec ships prebuilt glibc binaries and has
# no musl build. On Alpine the extension fails to load and Engram silently
# degrades to non-vector search (see src/store.ts).

FROM node:22-bookworm-slim AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/

RUN npm run build && npm prune --omit=dev

# ------------------------------------------------------------

FROM node:22-bookworm-slim

LABEL org.opencontainers.image.title="engram-mcp"
LABEL org.opencontainers.image.description="Universal memory layer for AI agents — MCP server"
LABEL org.opencontainers.image.source="https://github.com/ackstorm/engram"
LABEL org.opencontainers.image.licenses="MIT"

WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY package.json ./

RUN useradd --system --create-home --uid 10001 engram \
 && mkdir -p /data \
 && chown -R engram:engram /data /app

USER engram

ENV NODE_ENV=production
ENV ENGRAM_DB_PATH=/data/engram.db
ENV ENGRAM_MCP_HOST=0.0.0.0
ENV ENGRAM_MCP_PORT=3801

VOLUME ["/data"]
EXPOSE 3801

# ENGRAM_AUTH_TOKEN is mandatory in HTTP mode — the container will refuse
# to start without it. Supply it via compose or `docker run -e`.
ENTRYPOINT ["node", "dist/mcp.js"]
CMD ["--http"]
