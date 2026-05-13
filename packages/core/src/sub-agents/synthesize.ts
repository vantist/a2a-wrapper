/**
 * Canonical Synthesized MCP Descriptor
 *
 * Produces the wrapper-agnostic {@link SynthesizedMcpDescriptor} that
 * each wrapper adapter translates into its own MCP entry shape (e.g.
 * `McpStdioServerConfig` for a2a-copilot, `McpLocalServerConfig` for
 * a2a-opencode). Centralizing the `command` / `args` shape here is
 * what lets `@a2a-wrapper/core` remain the single source of truth for
 * how the bridge child process is invoked — adding a future wrapper
 * is a one-file change because the descriptor is already correct.
 *
 * The descriptor invokes `npx` with the package name pinned via
 * {@link SKILLMAP_PACKAGE_VERSION}. Pinning ensures bridge behavior
 * is reproducible across deployments and that a future skillmap
 * release cannot silently change semantics for parents that depend
 * on this package. Bumping the pin is a deliberate, reviewable change
 * (see `version.ts`).
 *
 * @module sub-agents/synthesize
 */

import path from "node:path";

import { SUBAGENTS_MCP_KEY, type SynthesizedMcpDescriptor } from "./types.js";
import { SKILLMAP_PACKAGE_VERSION } from "./version.js";

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Build the canonical {@link SynthesizedMcpDescriptor} for the
 * sub-agents bridge.
 *
 * The returned descriptor invokes
 * `npx -y a2a-mcp-skillmap@<SKILLMAP_PACKAGE_VERSION> --config <bridgeConfigPath>`,
 * which is the contract every wrapper-side adapter relies on. The
 * `key` is set to {@link SUBAGENTS_MCP_KEY} so callers can merge the
 * adapted entry into the resolved `mcp` map without hardcoding the
 * reserved key themselves.
 *
 * @param bridgeConfigPath - Absolute filesystem path to the generated
 *   bridge config JSON file (typically the return value of
 *   `writeBridgeConfig`). The path **must** be absolute: relative
 *   paths would be resolved against whatever directory `npx` happens
 *   to be spawned in, which is brittle and operator-hostile. This
 *   function rejects non-absolute paths with a `TypeError` so the
 *   misconfiguration surfaces at synthesis time rather than as a
 *   confusing runtime "config not found" error from the bridge.
 * @returns The canonical descriptor ready for wrapper translation.
 * @throws {TypeError} When `bridgeConfigPath` is not an absolute path.
 */
export function buildSynthesizedMcpEntry(
  bridgeConfigPath: string,
): SynthesizedMcpDescriptor {
  if (!path.isAbsolute(bridgeConfigPath)) {
    throw new TypeError(
      `buildSynthesizedMcpEntry: bridgeConfigPath must be an absolute path, received ${JSON.stringify(
        bridgeConfigPath,
      )}`,
    );
  }

  return {
    key: SUBAGENTS_MCP_KEY,
    command: "npx",
    args: [
      "-y",
      `a2a-mcp-skillmap@${SKILLMAP_PACKAGE_VERSION}`,
      "--config",
      bridgeConfigPath,
    ],
  };
}
