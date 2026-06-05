---
"a2a-codex": minor
"@a2a-wrapper/core": patch
---

## a2a-codex: Initial release (0.1.0)

New package `a2a-codex` — an A2A protocol wrapper for the OpenAI Codex SDK.

Drop a `config.json` in, get a fully spec-compliant A2A server that routes tasks through Codex threads. Supports repository sandboxing (`read-only`, `workspace-write`, `danger-full-access`), MCP tools (stdio and http), streaming sideband events, multi-turn context continuity, AbortController cancellation, and multi-agent delegation via A2A sub-agents.

```sh
npx a2a-codex --config agents/example/config.json
```

Bundled example agents:
- `agents/example/` — workspace engineer (read + write)
- `agents/read-only-reviewer/` — code review (read-only)
- `agents/multi-agent/` — lead engineer with sub-agent delegation

## @a2a-wrapper/core: Add `publishTask` helper

Moves `publishTask` (registers a bare Task with the A2A result manager) into core so all wrappers can share it without local duplication.
