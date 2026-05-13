/**
 * Sub-Agents Type Definitions
 *
 * Core TypeScript interfaces for the A2A Sub-Agents feature. These types
 * define the public shape of the `subAgents` config section, the
 * intermediate options and synthesized MCP descriptor passed between
 * core and each wrapper, and the reserved MCP key under which the
 * synthesized bridge entry is registered.
 *
 * The key design principle is **wrapper-agnostic core**: this module
 * does not depend on any wrapper-specific MCP type. Wrappers translate
 * the canonical {@link SynthesizedMcpDescriptor} into their own MCP
 * entry shape (e.g. `McpStdioServerConfig` for a2a-copilot,
 * `McpLocalServerConfig` for a2a-opencode). Adding a future wrapper
 * is therefore a one-file change.
 *
 * @see ../../../../.kiro/specs/a2a-subagents/design.md
 * @module sub-agents/types
 */

// ─── Reserved MCP Key ───────────────────────────────────────────────────────

/**
 * The reserved MCP map key under which the synthesized sub-agents bridge
 * entry is registered.
 *
 * The bootstrap pipeline injects a single MCP entry under this key into
 * the parent's resolved `mcp` map. If the operator has manually defined
 * an MCP server under the same key, startup fails with a descriptive
 * error instructing them to choose a different key.
 */
export const SUBAGENTS_MCP_KEY = "a2a-subagents";

// ─── Outbound Auth ──────────────────────────────────────────────────────────

/**
 * Outbound credentials the bridge presents when calling a remote A2A
 * sub-agent. Forwarded verbatim into the bridge config consumed by
 * `a2a-mcp-skillmap`.
 *
 * `mode: "none"` is equivalent to omitting the `auth` field entirely
 * and produces no auth block in the generated bridge config.
 *
 * For `mode: "api_key"`, the optional `headerName` defaults to whatever
 * `a2a-mcp-skillmap` uses (typically `X-API-Key`).
 *
 * Tokens may reference environment variables via `${VAR_NAME}` syntax;
 * the substitution happens during validation and missing variables
 * cause the auth block to be omitted with a warning.
 */
export type SubAgentAuthConfig =
  | { mode: "none" }
  | { mode: "bearer"; token: string }
  | { mode: "api_key"; token: string; headerName?: string };

// ─── Sub-Agent Config ───────────────────────────────────────────────────────

/**
 * One remote A2A agent the parent will expose as MCP tools via the
 * `a2a-mcp-skillmap` bridge.
 *
 * @example
 * ```json
 * {
 *   "name": "coding",
 *   "agentCardUrl": "https://coding.example.com/.well-known/agent-card.json",
 *   "auth": { "mode": "bearer", "token": "${CODING_AGENT_TOKEN}" }
 * }
 * ```
 */
export interface SubAgentConfig {
  /**
   * Stable identifier for this sub-agent. Becomes the prefix on
   * generated MCP tool names (`{name}__{skillId}`). Required.
   *
   * Allowed characters: ASCII letters, digits, hyphens, and underscores
   * (must match `/^[A-Za-z0-9_-]+$/`). Must be unique across all
   * entries in the `subAgents.agents` array.
   */
  name: string;

  /**
   * URL of the sub-agent's A2A agent card. Required.
   *
   * Typically `https://<host>/.well-known/agent-card.json`, but any
   * URL the bridge can probe is valid. Must use the `http:` or
   * `https:` protocol.
   */
  agentCardUrl: string;

  /**
   * Optional override for the URL the bridge probes. Useful when the
   * agent card declares an endpoint that differs from where the agent
   * is actually reachable (NAT, port-forward, internal vs external).
   *
   * When set, this URL is passed to the bridge instead of
   * {@link agentCardUrl}. The bridge still resolves a card from this
   * URL — point it at a card URL or a base URL it can probe under
   * `/.well-known/`. Must use the `http:` or `https:` protocol.
   */
  endpointUrlOverride?: string;

  /**
   * Outbound credentials the bridge presents when calling this
   * sub-agent. Forwarded verbatim into the bridge config.
   *
   * Omitting this field is equivalent to `{ mode: "none" }`.
   */
  auth?: SubAgentAuthConfig;
}

// ─── Sub-Agents Options ─────────────────────────────────────────────────────

/**
 * Optional knobs that apply to the bridge process as a whole, not to
 * any single sub-agent.
 */
export interface SubAgentsOptions {
  /**
   * Skillmap response shaping mode passed through to the bridge config.
   * Defaults to `"artifact"` when unset.
   *
   * @see https://www.npmjs.com/package/a2a-mcp-skillmap
   */
  responseMode?: "structured" | "compact" | "artifact" | "raw";

  /**
   * Probe timeout in milliseconds for the startup reachability check
   * the parent performs against each sub-agent. Defaults to `5000`
   * when unset.
   */
  probeTimeoutMs?: number;

  /**
   * Sync budget in milliseconds passed to `a2a-mcp-skillmap` via the
   * bridge config. Controls how long the bridge waits for an A2A agent
   * to respond before switching to async task-handle mode.
   *
   * When the budget expires the bridge immediately returns a `taskId`
   * to the MCP client; the A2A dispatch continues in the background.
   * The LLM can then poll via the built-in `task_result` / `task_status`
   * tools which actively re-query the remote agent before responding.
   *
   * - Set lower (e.g. `10000`) for interactive use where you want fast
   *   task-handle responses.
   * - Set to `0` to wait indefinitely (no async fallback).
   * - Defaults to `30000` (30 s) when unset — skillmap's own default.
   *
   * @see https://www.npmjs.com/package/a2a-mcp-skillmap
   */
  syncBudgetMs?: number;
}

// ─── Top-Level Sub-Agents Config ────────────────────────────────────────────

/**
 * Top-level shape of the `subAgents` field merged into the agent's
 * `BaseAgentConfig`.
 *
 * When this field is absent or `agents` is an empty array, the parent
 * skips every sub-agent code path with no side effects (no bridge
 * config written, no MCP entry injected).
 *
 * @example
 * ```json
 * {
 *   "subAgents": {
 *     "agents": [
 *       {
 *         "name": "coding",
 *         "agentCardUrl": "https://coding.example.com/.well-known/agent-card.json"
 *       }
 *     ],
 *     "options": { "responseMode": "artifact", "probeTimeoutMs": 5000 }
 *   }
 * }
 * ```
 */
export interface SubAgentsConfig {
  /** The list of remote A2A agents to expose as MCP tools. */
  agents: SubAgentConfig[];

  /** Optional bridge-wide knobs. */
  options?: SubAgentsOptions;
}

// ─── Synthesized MCP Descriptor ─────────────────────────────────────────────

/**
 * Canonical, wrapper-agnostic descriptor for the MCP entry the bootstrap
 * pipeline produces. Each wrapper translates this descriptor into its
 * own MCP entry shape before merging it into the resolved `mcp` map.
 *
 * Keeping this shape free of any wrapper-specific MCP type is what
 * lets `@a2a-wrapper/core` remain the single source of truth: adding
 * a future wrapper requires only writing a small adapter that maps
 * `{ command, args, env }` into that wrapper's MCP entry shape.
 */
export interface SynthesizedMcpDescriptor {
  /**
   * The reserved MCP map key under which this entry is registered.
   * Always equals {@link SUBAGENTS_MCP_KEY}.
   */
  key: string;

  /**
   * The executable to spawn. Always `"npx"` for the
   * `a2a-mcp-skillmap` bridge.
   */
  command: string;

  /**
   * Arguments to pass to {@link command}. Includes the pinned
   * skillmap version and the absolute path to the generated bridge
   * config file.
   */
  args: string[];

  /**
   * Optional environment variables to set on the spawned bridge
   * process. Currently unused by the bootstrap pipeline but reserved
   * for future expansion (e.g. propagating proxy settings).
   */
  env?: Record<string, string>;
}
