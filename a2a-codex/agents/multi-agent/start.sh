#!/usr/bin/env bash
###############################################################################
# Multi-Agent Lead Engineer — start / stop / status / logs
#
# Demonstrates the `subAgents` config — a Codex lead engineer that delegates
# specialist tasks to remote A2A sub-agents (security, test-engineer).
#
# Sub-agents must be running before starting this agent:
#   # Start the specialist sub-agents first (on ports 3010 and 3011), then:
#   ./start.sh start
#
# Update agentCardUrl values in config.json to match your deployed sub-agent
# addresses before starting.
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
#   WORKSPACE_DIR    Git repository path (defaults to workspace/ below)
###############################################################################

set -euo pipefail

AGENT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${AGENT_DIR}/../.." && pwd)"

export CONFIG_FILE="${AGENT_DIR}/config.json"
export WORKSPACE_DIR="${WORKSPACE_DIR:-${AGENT_DIR}/workspace}"

exec "${ROOT_DIR}/server.sh" "$@"
