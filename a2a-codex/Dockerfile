# =============================================================================
# a2a-codex — OpenAI Codex A2A Wrapper
# =============================================================================
#
# Multi-stage build: TypeScript compile → lean runtime image.
#
# Build:
#   docker build -t a2a-codex:latest .
#
# Run (with an agent config):
#   docker run -p 3020:3020 \
#     -e OPENAI_API_KEY=<your-key> \
#     -e WORKSPACE_DIR=/workspace \
#     -v /host/path/to/repo:/workspace \
#     a2a-codex:latest --config agents/example/config.json
#
# Override the agent config at runtime via the CMD or by mounting a volume:
#   docker run -p 3020:3020 \
#     -e OPENAI_API_KEY=<your-key> \
#     -v /host/path/my-agent:/app/agents/my-agent \
#     -v /host/path/to/repo:/workspace \
#     a2a-codex:latest --config agents/my-agent/config.json
#
# Environment variables:
#   OPENAI_API_KEY   OpenAI API key (required)
#   WORKSPACE_DIR    Absolute path to the Git repository inside the container (required)
#   CODEX_MODEL      Override the model (e.g. o4-mini, o3, gpt-4o)
#   PORT             A2A server port (default: from config, fallback 3020)
#   LOG_LEVEL        debug | info | warn | error (default: info)
#   ADVERTISE_HOST   Hostname embedded in agent card URLs (default: localhost)
# =============================================================================

# ---------------------------------------------------------------------------
# Stage 1 — Builder: compile TypeScript to JavaScript
# ---------------------------------------------------------------------------
FROM node:20-slim AS builder

WORKDIR /app

# Install dependencies before copying source so this layer is cached
# unless package.json / package-lock.json change.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# ---------------------------------------------------------------------------
# Stage 2 — Runtime: minimal production image
# ---------------------------------------------------------------------------
FROM node:20-slim

LABEL org.opencontainers.image.title="A2A OpenAI Codex Wrapper" \
      org.opencontainers.image.description="A2A protocol wrapper for the OpenAI Codex SDK" \
      org.opencontainers.image.version="0.1.0" \
      org.opencontainers.image.licenses="MIT"

WORKDIR /app

# Copy only the build output and production dependencies from the builder.
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Bundle the example agents so the image is runnable out of the box.
COPY agents/ ./agents/

COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# Make local node_modules binaries available.
ENV PATH="/app/node_modules/.bin:$PATH"

# Run as a non-root user for security.
# If you are running on OpenShift (arbitrary UIDs), remove this line and
# ensure the /app directory is group-writable (chgrp 0 /app && chmod g=u /app).
USER node

ENTRYPOINT ["/app/entrypoint.sh"]

# Default: start the example workspace engineer agent.
# Override by passing --config <path> as CMD arguments.
CMD ["--config", "agents/example/config.json"]
