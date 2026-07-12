# Dockerfile for Codebase Memory V2
# Provides a containerized cbm-v2 CLI + MCP server + Graph UI.
#
# R168.2: fixed to build graph-ui and embed its assets in the package,
# so the UI is served from the installed module, not from process.cwd().

# ── Stage 1: Build graph-ui ────────────────────────────────────────
FROM node:20-slim AS ui-builder

WORKDIR /graph-ui

COPY graph-ui/package.json graph-ui/package-lock.json ./
RUN npm ci

COPY graph-ui/ ./
RUN npm run build

# ── Stage 2: Build v2 backend ──────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /app

COPY v2/package.json v2/package-lock.json ./
RUN npm ci

COPY v2/ ./
RUN npm run build

# Copy graph-ui dist into v2/dist/ui so the runtime serves it from
# the installed module location (import.meta.url resolution).
COPY --from=ui-builder /graph-ui/dist ./dist/ui

# ── Runtime image ──────────────────────────────────────────────────
FROM node:20-slim AS runtime

WORKDIR /app

# Install only production dependencies
COPY v2/package.json v2/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy built files from builder (includes dist/ui from graph-ui)
COPY --from=builder /app/dist ./dist

# Create a volume for the cache directory (SQLite DBs)
RUN useradd -m -u 1000 cbm
USER cbm
VOLUME ["/home/cbm/.cache/codebase-memory-mcp"]

# Default entrypoint — can be overridden for MCP mode
ENTRYPOINT ["node", "dist/cli/index.js"]
CMD ["--help"]

# Labels for metadata
LABEL org.opencontainers.image.title="Codebase Memory V2"
LABEL org.opencontainers.image.description="Codebase Memory V2 — hybrid code intelligence (native WASM indexer + human memory graph + Obsidian sync + Graph UI)"
LABEL org.opencontainers.image.licenses="MIT"
LABEL org.opencontainers.image.source="https://github.com/Cheurteenyt/codebase-mirror"
