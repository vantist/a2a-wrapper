#!/usr/bin/env bash
###############################################################################
# Read-Only Reviewer Agent — start / stop / status / logs
#
# Code review and repository analysis agent backed by OpenAI Codex.
# Codex is restricted to read-only access — it cannot modify any files.
# Safe to point at any repository without risk of accidental changes.
#
# Usage:
#   ./start.sh start        — Start the agent in the background
#   ./start.sh stop         — Stop the running agent
#   ./start.sh restart      — Stop then start
#   ./start.sh status       — Show running / stopped status
#   ./start.sh logs         — Tail the agent log
#   ./start.sh foreground   — Run in the foreground (useful for debugging)
#
# Required environment:
#   OPENAI_API_KEY   Your OpenAI API key
#
# Point at any repository with WORKSPACE_DIR:
#   WORKSPACE_DIR=/path/to/repo ./start.sh start
###############################################################################

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${AGENT_DIR}/../.." && pwd)"

export CONFIG_FILE="${AGENT_DIR}/config.json"
export WORKSPACE_DIR="${WORKSPACE_DIR:-${AGENT_DIR}/workspace}"

exec "${ROOT_DIR}/server.sh" "$@"
