/**
 * Bridge Config Generation and Write
 *
 * Builds the JSON document consumed by the `a2a-mcp-skillmap` child process
 * and writes it to disk under the parent's workspace (with a `os.tmpdir()`
 * fallback when no workspace is configured).
 *
 * The shape produced by {@link buildBridgeConfig} matches skillmap's
 * `BridgeConfigSchema` for stdio transport. There is intentionally no
 * `http` block — stdio mode does not use it, and emitting one would
 * either be ignored by skillmap or trip its schema validation.
 *
 * The on-disk file is written with mode `0600` so that auth tokens
 * inlined into the document (after env-var substitution) are not
 * world-readable. The parent never deletes this file on shutdown — it
 * is overwritten on the next start, and leaving it on disk aids
 * debugging between runs.
 *
 * @module sub-agents/bridge-config
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SubAgentConfig, SubAgentsOptions } from "./types.js";

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * Inputs to {@link buildBridgeConfig}. The caller is responsible for
 * having already run {@link validateSubAgents} so `agents` is the
 * env-substituted, fully-validated list.
 */
export interface BridgeConfigSource {
  /** Validated, env-substituted sub-agents. */
  agents: SubAgentConfig[];
  /**
   * Bridge-wide options. `responseMode` and `probeTimeoutMs` are
   * required (callers fill in defaults before calling); `syncBudgetMs`
   * is optional — when absent the key is omitted from the bridge config
   * so skillmap uses its own default (30 000 ms).
   */
  options: Required<Pick<SubAgentsOptions, "responseMode" | "probeTimeoutMs">> &
    Pick<SubAgentsOptions, "syncBudgetMs">;
  /** The parent agent's `logging.level`, propagated into the bridge. */
  parentLogLevel: string;
}

/**
 * One agent entry in the generated bridge config. Exported for test
 * convenience and for documentation; the actual type written to disk
 * is the JSON serialization of {@link BridgeConfig}.
 */
export interface BridgeConfigAgentEntry {
  /** The URL skillmap will probe for this sub-agent. */
  url: string;
  /**
   * Outbound credentials skillmap will present when calling this
   * sub-agent. Omitted entirely when the source `auth` was missing,
   * `mode: "none"`, or had an empty/unresolved token.
   */
  auth?: { mode: "bearer"; token: string } | { mode: "api_key"; token: string; headerName?: string };
}

/**
 * The full bridge config document written to disk for skillmap. The
 * shape conforms to skillmap's `BridgeConfigSchema` for stdio mode.
 */
export interface BridgeConfig {
  agents: BridgeConfigAgentEntry[];
  transport: "stdio";
  responseMode: NonNullable<SubAgentsOptions["responseMode"]>;
  syncBudgetMs?: number;
  logging: { level: string };
}

// ─── Internal Constants ─────────────────────────────────────────────────────

/**
 * Default response shaping mode used when the operator has not set
 * `subAgents.options.responseMode`. The `Required<SubAgentsOptions>`
 * shape on {@link BridgeConfigSource} means callers normally supply a
 * value, but the `??` fallback below preserves the documented default
 * even if a caller passes through an `undefined`.
 */
const DEFAULT_RESPONSE_MODE: NonNullable<SubAgentsOptions["responseMode"]> = "artifact";

/** Filename under `<workspace>/.a2a/` (or the tmpdir fallback). */
const BRIDGE_CONFIG_FILENAME = "subagents-bridge.json";

/** Subdirectory of `<workspace>/` (or the tmpdir fallback) housing the file. */
const WORKSPACE_SUBDIR = ".a2a";

/** File mode applied to the written bridge config. */
const BRIDGE_CONFIG_FILE_MODE = 0o600;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Produce a JSON-serializable bridge config object for skillmap.
 *
 * Each agent entry's `url` is taken from {@link SubAgentConfig.endpointUrlOverride}
 * when set, otherwise from {@link SubAgentConfig.agentCardUrl}. The
 * `auth` block is included verbatim only when the source auth is in
 * `bearer` or `api_key` mode and the resolved token is non-empty —
 * `validateSubAgents` is responsible for env-var substitution and for
 * stripping invalid auth, so callers can rely on `agents[i].auth`
 * already reflecting the operator's intent.
 *
 * The document layout (key ordering and absence of an `http` block)
 * is stable so snapshot tests stay deterministic across runs.
 */
export function buildBridgeConfig(src: BridgeConfigSource): BridgeConfig {
  const responseMode = src.options.responseMode ?? DEFAULT_RESPONSE_MODE;

  const agents: BridgeConfigAgentEntry[] = src.agents.map((agent) => {
    const url =
      agent.endpointUrlOverride !== undefined && agent.endpointUrlOverride !== null
        ? agent.endpointUrlOverride
        : agent.agentCardUrl;

    const entry: BridgeConfigAgentEntry = { url };

    // The validator already drops mode === "none" and empty/unresolved
    // tokens. Defensive guards here keep the output shape correct even
    // if a caller bypasses validation.
    if (
      agent.auth !== undefined &&
      agent.auth.mode !== "none" &&
      typeof agent.auth.token === "string" &&
      agent.auth.token.length > 0
    ) {
      if (agent.auth.mode === "bearer") {
        entry.auth = { mode: "bearer", token: agent.auth.token };
      } else {
        // mode === "api_key" — preserve optional headerName when present.
        const apiKeyAuth: NonNullable<BridgeConfigAgentEntry["auth"]> = {
          mode: "api_key",
          token: agent.auth.token,
        };
        if (agent.auth.headerName !== undefined) {
          apiKeyAuth.headerName = agent.auth.headerName;
        }
        entry.auth = apiKeyAuth;
      }
    }

    return entry;
  });

  // Build the config object. syncBudgetMs is only emitted when the
  // operator has explicitly set it (including 0 to disable the budget).
  // When unset (undefined), we omit the key entirely so skillmap uses
  // its own default (30 000 ms), keeping the bridge config minimal.
  const config: BridgeConfig = {
    agents,
    transport: "stdio",
    responseMode,
    logging: { level: src.parentLogLevel },
  };

  const syncBudgetMs = src.options.syncBudgetMs;
  if (typeof syncBudgetMs === "number" && Number.isFinite(syncBudgetMs) && syncBudgetMs >= 0) {
    config.syncBudgetMs = syncBudgetMs;
  }

  return config;
}

/**
 * Resolve the absolute path the bridge config will be written to.
 *
 * - When `workspaceDir` is a non-empty string, returns
 *   `<workspaceDir>/.a2a/subagents-bridge.json`.
 * - Otherwise, falls back to
 *   `<os.tmpdir()>/a2a-subagents-<pid>/subagents-bridge.json` so the
 *   parent can still operate when the operator has not configured a
 *   workspace (e.g. CI sanity runs).
 *
 * Relative `workspaceDir` values are resolved against `process.cwd()`
 * via {@link path.resolve}. The returned path is always absolute and
 * normalized.
 */
export function resolveBridgeConfigPath(workspaceDir: string | undefined): string {
  if (typeof workspaceDir === "string" && workspaceDir.length > 0) {
    return path.resolve(workspaceDir, WORKSPACE_SUBDIR, BRIDGE_CONFIG_FILENAME);
  }
  const fallbackDir = path.join(os.tmpdir(), `a2a-subagents-${process.pid}`);
  return path.join(fallbackDir, BRIDGE_CONFIG_FILENAME);
}

/**
 * Write the bridge config object to `targetPath` as JSON, creating
 * intermediate directories as needed and applying mode `0600`.
 *
 * Behavior:
 * - Parent directory is created with `mkdir -p` semantics.
 * - The file is written with mode `0600` on creation. If the file
 *   already exists, `fs.writeFile`'s `mode` option does not retroact,
 *   so an explicit `fs.chmod` follows the write to enforce the bit
 *   pattern. Platforms (notably Windows) where `chmod` is a no-op
 *   silently absorb the call.
 * - Output is pretty-printed with two-space indentation so operators
 *   can inspect or diff the file by hand. A trailing newline is
 *   appended for POSIX-friendly editors and `cat` output.
 *
 * @returns The absolute path the file was written to.
 */
export async function writeBridgeConfig(
  configObject: unknown,
  targetPath: string,
): Promise<string> {
  const absolutePath = path.resolve(targetPath);
  const parentDir = path.dirname(absolutePath);

  await fs.mkdir(parentDir, { recursive: true });

  const json = `${JSON.stringify(configObject, null, 2)}\n`;
  await fs.writeFile(absolutePath, json, {
    encoding: "utf-8",
    mode: BRIDGE_CONFIG_FILE_MODE,
  });

  // Enforce mode 0600 even when the file already existed (writeFile's
  // mode option only applies on creation). chmod is a no-op on Windows,
  // so we swallow EPERM/ENOTSUP to keep cross-platform tests happy.
  try {
    await fs.chmod(absolutePath, BRIDGE_CONFIG_FILE_MODE);
  } catch (err: unknown) {
    if (!isExpectedChmodError(err)) {
      throw err;
    }
  }

  return absolutePath;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Recognize the platform-dependent errors that `fs.chmod` may throw on
 * filesystems that do not support POSIX permission bits (Windows, some
 * mounted volumes). Any other error is re-raised.
 */
function isExpectedChmodError(err: unknown): boolean {
  if (!(err instanceof Error) || !("code" in err)) {
    return false;
  }
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOTSUP" || code === "EPERM" || code === "EINVAL";
}
