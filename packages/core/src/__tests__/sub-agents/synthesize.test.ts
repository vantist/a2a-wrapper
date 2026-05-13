import { describe, it, expect } from "vitest";
import path from "node:path";

import { buildSynthesizedMcpEntry } from "../../sub-agents/synthesize.js";
import { SUBAGENTS_MCP_KEY } from "../../sub-agents/types.js";
import { SKILLMAP_PACKAGE_VERSION } from "../../sub-agents/version.js";

/**
 * Unit tests for the synthesize module.
 *
 * Validates Requirements 5.3, 5.4, 5.5, 9.2 by exercising
 * {@link buildSynthesizedMcpEntry}: the descriptor pins the
 * `a2a-mcp-skillmap` version, registers under the reserved
 * `a2a-subagents` MCP key, accepts absolute config paths, and
 * rejects relative paths fail-fast at synthesis time.
 */

const ABSOLUTE_CONFIG_PATH =
  process.platform === "win32"
    ? "C:\\workspace\\.a2a\\subagents-bridge.json"
    : "/workspace/.a2a/subagents-bridge.json";

// ─── buildSynthesizedMcpEntry ───────────────────────────────────────────────

describe("buildSynthesizedMcpEntry — descriptor shape", () => {
  // Requirement 9.2: skillmap version is pinned via SKILLMAP_PACKAGE_VERSION.
  it("pins the a2a-mcp-skillmap version in the args", () => {
    const descriptor = buildSynthesizedMcpEntry(ABSOLUTE_CONFIG_PATH);

    expect(descriptor.command).toBe("npx");
    expect(descriptor.args).toEqual([
      "-y",
      `a2a-mcp-skillmap@${SKILLMAP_PACKAGE_VERSION}`,
      "--config",
      ABSOLUTE_CONFIG_PATH,
    ]);
    // Defensive: the version embedded in args must match the constant
    // exactly so a stray hardcoded string in synthesize.ts would fail
    // here rather than only at runtime.
    const versionedArg = descriptor.args[1];
    expect(versionedArg).toContain(SKILLMAP_PACKAGE_VERSION);
    expect(versionedArg.startsWith("a2a-mcp-skillmap@")).toBe(true);
  });

  // Requirement 5.3, 5.4: descriptor key is the reserved sub-agents key.
  it("registers under the reserved SUBAGENTS_MCP_KEY", () => {
    const descriptor = buildSynthesizedMcpEntry(ABSOLUTE_CONFIG_PATH);

    expect(descriptor.key).toBe(SUBAGENTS_MCP_KEY);
    expect(descriptor.key).toBe("a2a-subagents");
  });

  // Requirement 5.3: absolute path is forwarded verbatim into args.
  it("forwards an absolute bridgeConfigPath into the --config arg", () => {
    const descriptor = buildSynthesizedMcpEntry(ABSOLUTE_CONFIG_PATH);

    expect(path.isAbsolute(ABSOLUTE_CONFIG_PATH)).toBe(true);
    const configFlagIndex = descriptor.args.indexOf("--config");
    expect(configFlagIndex).toBeGreaterThanOrEqual(0);
    expect(descriptor.args[configFlagIndex + 1]).toBe(ABSOLUTE_CONFIG_PATH);
  });
});

describe("buildSynthesizedMcpEntry — input validation", () => {
  // Requirement 5.5: relative paths are rejected fail-fast at synthesis time.
  it("throws TypeError when bridgeConfigPath is a relative path", () => {
    expect(() => buildSynthesizedMcpEntry("relative/path.json")).toThrow(
      TypeError,
    );
    expect(() => buildSynthesizedMcpEntry("./bridge.json")).toThrow(TypeError);
    expect(() => buildSynthesizedMcpEntry("../bridge.json")).toThrow(TypeError);
  });

  // Requirement 5.5: the empty string is not absolute and must be rejected.
  it("throws TypeError when bridgeConfigPath is the empty string", () => {
    expect(() => buildSynthesizedMcpEntry("")).toThrow(TypeError);
  });

  // Requirement 5.5: error message names the offending path so operators
  // can correlate it back to their config without spelunking.
  it("includes the offending path in the error message", () => {
    expect(() => buildSynthesizedMcpEntry("relative.json")).toThrow(
      /relative\.json/,
    );
  });
});
