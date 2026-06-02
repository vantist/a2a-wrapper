#!/usr/bin/env bash
###############################################################################
# Ollama Agent — start / stop / status / logs
#
# Runs entirely locally using Ollama instead of GitHub Copilot.
# No GitHub account or Copilot subscription required.
#
# Prerequisites:
#   1. Install Ollama: https://ollama.com
#   2. Pull a model:   ollama pull qwen2.5-coder:7b
#   3. Start Ollama:   ollama serve
#
# Usage:
#   ./start.sh start        — Start the agent in the background
#   ./start.sh stop         — Stop the running agent
#   ./start.sh restart      — Stop then start
#   ./start.sh status       — Show running / stopped status
#   ./start.sh logs         — Tail the agent log
#   ./start.sh foreground   — Run in the foreground (useful for debugging)
#
# To use a different model:
#   ollama pull llama3.2
#   COPILOT_MODEL=llama3.2 ./start.sh start
###############################################################################

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${AGENT_DIR}/../.." && pwd)"

export CONFIG_FILE="${AGENT_DIR}/config.json"
export WORKSPACE_DIR="${WORKSPACE_DIR:-${AGENT_DIR}/workspace}"

exec "${ROOT_DIR}/server.sh" "$@"
