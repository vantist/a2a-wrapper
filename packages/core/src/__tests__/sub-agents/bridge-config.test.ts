import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  buildBridgeConfig,
  resolveBridgeConfigPath,
  writeBridgeConfig,
} from "../../sub-agents/bridge-config.js";
import type { SubAgentConfig, SubAgentsOptions } from "../../sub-agents/types.js";

/**
 * Unit tests for the bridge-config module.
 *
 * Validates Requirements 2.1, 2.2, 4.1–4.6, 10.1, 10.2 by exercising
 * {@link buildBridgeConfig}, {@link resolveBridgeConfigPath}, and
 * {@link writeBridgeConfig}.
 */

const DEFAULT_OPTIONS: Required<SubAgentsOptions> = {
  responseMode: "artifact",
  probeTimeoutMs: 5000,
};

// ─── buildBridgeConfig ──────────────────────────────────────────────────────

describe("buildBridgeConfig — agent entry shape", () => {
  // Requirement 4.1, 4.5: stdio transport, no http block.
  it("produces a single-agent stdio config with no auth and no http block", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
      },
    ];

    const result = buildBridgeConfig({
      agents,
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result).toEqual({
      agents: [
        { url: "https://coding.example.com/.well-known/agent-card.json" },
      ],
      transport: "stdio",
      responseMode: "artifact",
      logging: { level: "info" },
    });
    // Defensive: no `http` block ever appears in the output.
    expect(Object.keys(result)).not.toContain("http");
  });

  // Requirement 3.1: bearer auth is forwarded verbatim.
  it("preserves bearer auth when present", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
        auth: { mode: "bearer", token: "secret-token-1" },
      },
    ];

    const result = buildBridgeConfig({
      agents,
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result.agents).toEqual([
      {
        url: "https://coding.example.com/.well-known/agent-card.json",
        auth: { mode: "bearer", token: "secret-token-1" },
      },
    ]);
  });

  // Requirement 3.2: api_key auth is forwarded with optional headerName.
  it("preserves api_key auth with optional headerName", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
        auth: { mode: "api_key", token: "key-abc", headerName: "X-Api-Key" },
      },
    ];

    const result = buildBridgeConfig({
      agents,
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result.agents[0].auth).toEqual({
      mode: "api_key",
      token: "key-abc",
      headerName: "X-Api-Key",
    });
  });

  it("preserves api_key auth and omits headerName when not set", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
        auth: { mode: "api_key", token: "key-abc" },
      },
    ];

    const result = buildBridgeConfig({
      agents,
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result.agents[0].auth).toEqual({
      mode: "api_key",
      token: "key-abc",
    });
    expect(Object.keys(result.agents[0].auth ?? {})).not.toContain("headerName");
  });

  // Requirement 3.3: mode "none" results in no auth block.
  it("omits the auth block when mode is `none`", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
        auth: { mode: "none" },
      },
    ];

    const result = buildBridgeConfig({
      agents,
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result.agents).toEqual([
      { url: "https://coding.example.com/.well-known/agent-card.json" },
    ]);
    expect(result.agents[0].auth).toBeUndefined();
  });

  it("omits the auth block when token is an empty string", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
        auth: { mode: "bearer", token: "" },
      },
    ];

    const result = buildBridgeConfig({
      agents,
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result.agents[0].auth).toBeUndefined();
  });

  // Requirement 2.1: endpointUrlOverride takes precedence over agentCardUrl.
  it("uses endpointUrlOverride as the agent's url when set", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "research",
        agentCardUrl: "https://research.example.com/.well-known/agent-card.json",
        endpointUrlOverride: "https://internal.local/research/card.json",
      },
    ];

    const result = buildBridgeConfig({
      agents,
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result.agents[0].url).toBe("https://internal.local/research/card.json");
  });

  // Requirement 2.2: agentCardUrl is used when no override is set.
  it("falls back to agentCardUrl when endpointUrlOverride is absent", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "research",
        agentCardUrl: "https://research.example.com/.well-known/agent-card.json",
      },
    ];

    const result = buildBridgeConfig({
      agents,
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result.agents[0].url).toBe(
      "https://research.example.com/.well-known/agent-card.json",
    );
  });
});

describe("buildBridgeConfig — top-level shape", () => {
  // Requirement 4.4: responseMode defaults to "artifact" but is overridable.
  it("defaults responseMode to `artifact` when options provide it", () => {
    const result = buildBridgeConfig({
      agents: [],
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result.responseMode).toBe("artifact");
  });

  it.each(["structured", "compact", "raw"] as const)(
    "passes through responseMode `%s` from options",
    (mode) => {
      const result = buildBridgeConfig({
        agents: [],
        options: { ...DEFAULT_OPTIONS, responseMode: mode },
        parentLogLevel: "info",
      });

      expect(result.responseMode).toBe(mode);
    },
  );

  // Requirement 4.6: logging.level matches the parent's level.
  it.each(["debug", "info", "warn", "error"])(
    "propagates parentLogLevel `%s` into logging.level",
    (level) => {
      const result = buildBridgeConfig({
        agents: [],
        options: DEFAULT_OPTIONS,
        parentLogLevel: level,
      });

      expect(result.logging).toEqual({ level });
    },
  );

  it("always sets transport to `stdio`", () => {
    const result = buildBridgeConfig({
      agents: [],
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result.transport).toBe("stdio");
  });

  it("emits an empty agents array when no sub-agents are provided", () => {
    const result = buildBridgeConfig({
      agents: [],
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result.agents).toEqual([]);
  });
});

describe("buildBridgeConfig — representative input combinations (snapshot-style)", () => {
  it("matches the expected shape with one bearer-auth agent and no override", () => {
    const result = buildBridgeConfig({
      agents: [
        {
          name: "coding",
          agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
          auth: { mode: "bearer", token: "tok-1" },
        },
      ],
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result).toEqual({
      agents: [
        {
          url: "https://coding.example.com/.well-known/agent-card.json",
          auth: { mode: "bearer", token: "tok-1" },
        },
      ],
      transport: "stdio",
      responseMode: "artifact",
      logging: { level: "info" },
    });
  });

  it("matches the expected shape with endpointUrlOverride and no auth", () => {
    const result = buildBridgeConfig({
      agents: [
        {
          name: "research",
          agentCardUrl: "https://research.example.com/.well-known/agent-card.json",
          endpointUrlOverride: "https://internal.local/research/card.json",
        },
      ],
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result).toEqual({
      agents: [
        { url: "https://internal.local/research/card.json" },
      ],
      transport: "stdio",
      responseMode: "artifact",
      logging: { level: "info" },
    });
  });

  it("matches the expected shape with custom responseMode", () => {
    const result = buildBridgeConfig({
      agents: [
        {
          name: "coding",
          agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
        },
      ],
      options: { responseMode: "compact", probeTimeoutMs: 5000 },
      parentLogLevel: "debug",
    });

    expect(result).toEqual({
      agents: [
        { url: "https://coding.example.com/.well-known/agent-card.json" },
      ],
      transport: "stdio",
      responseMode: "compact",
      logging: { level: "debug" },
    });
  });

  // Mixed sub-agents: one with bearer auth + override, one without auth.
  it("matches the expected shape with mixed sub-agents (one with auth, one without)", () => {
    const result = buildBridgeConfig({
      agents: [
        {
          name: "coding",
          agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
          endpointUrlOverride: "https://internal.local/coding/card.json",
          auth: { mode: "bearer", token: "tok-coding" },
        },
        {
          name: "research",
          agentCardUrl: "https://research.example.com/.well-known/agent-card.json",
        },
      ],
      options: DEFAULT_OPTIONS,
      parentLogLevel: "info",
    });

    expect(result).toEqual({
      agents: [
        {
          url: "https://internal.local/coding/card.json",
          auth: { mode: "bearer", token: "tok-coding" },
        },
        {
          url: "https://research.example.com/.well-known/agent-card.json",
        },
      ],
      transport: "stdio",
      responseMode: "artifact",
      logging: { level: "info" },
    });
  });
});

// ─── resolveBridgeConfigPath ────────────────────────────────────────────────

describe("resolveBridgeConfigPath", () => {
  // Requirement 4.2: workspace path uses <workspace>/.a2a/subagents-bridge.json.
  it("returns <workspace>/.a2a/subagents-bridge.json when workspaceDir is an absolute path", () => {
    const workspace = path.resolve(os.tmpdir(), "my-workspace");
    const expected = path.join(workspace, ".a2a", "subagents-bridge.json");

    expect(resolveBridgeConfigPath(workspace)).toBe(expected);
  });

  it("resolves a relative workspaceDir against process.cwd()", () => {
    const result = resolveBridgeConfigPath("relative-workspace");
    const expected = path.resolve(
      process.cwd(),
      "relative-workspace",
      ".a2a",
      "subagents-bridge.json",
    );

    expect(result).toBe(expected);
    expect(path.isAbsolute(result)).toBe(true);
  });

  // Requirement 4.3: tmpdir fallback when workspace is missing.
  it("falls back to <tmpdir>/a2a-subagents-<pid>/subagents-bridge.json when workspaceDir is undefined", () => {
    const expected = path.join(
      os.tmpdir(),
      `a2a-subagents-${process.pid}`,
      "subagents-bridge.json",
    );

    expect(resolveBridgeConfigPath(undefined)).toBe(expected);
  });

  it("falls back to the tmpdir path when workspaceDir is an empty string", () => {
    const expected = path.join(
      os.tmpdir(),
      `a2a-subagents-${process.pid}`,
      "subagents-bridge.json",
    );

    expect(resolveBridgeConfigPath("")).toBe(expected);
  });
});

// ─── writeBridgeConfig ──────────────────────────────────────────────────────

describe("writeBridgeConfig", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "bridge-config-test-"));
  });

  afterEach(async () => {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  });

  // Requirement 10.2: parent directory is created with mkdir -p semantics.
  it("creates intermediate directories that do not exist", async () => {
    const target = path.join(tmpRoot, "nested", "deep", "subagents-bridge.json");
    const config = { transport: "stdio", agents: [] };

    const written = await writeBridgeConfig(config, target);

    expect(written).toBe(path.resolve(target));
    const stat = await fs.stat(target);
    expect(stat.isFile()).toBe(true);

    const onDisk = await fs.readFile(target, "utf-8");
    expect(JSON.parse(onDisk)).toEqual(config);
  });

  // Requirement 10.1: existing file is overwritten on each start.
  it("overwrites an existing file with the new contents", async () => {
    const target = path.join(tmpRoot, "subagents-bridge.json");

    await writeBridgeConfig({ marker: "first" }, target);
    const firstRead = await fs.readFile(target, "utf-8");
    expect(JSON.parse(firstRead)).toEqual({ marker: "first" });

    await writeBridgeConfig({ marker: "second", more: [1, 2, 3] }, target);
    const secondRead = await fs.readFile(target, "utf-8");
    expect(JSON.parse(secondRead)).toEqual({ marker: "second", more: [1, 2, 3] });
  });

  it("returns an absolute path even when given a relative target", async () => {
    const relTarget = path.relative(
      process.cwd(),
      path.join(tmpRoot, "rel-bridge.json"),
    );
    const written = await writeBridgeConfig({ agents: [] }, relTarget);

    expect(path.isAbsolute(written)).toBe(true);
    expect(written).toBe(path.resolve(relTarget));
  });

  it("writes pretty-printed JSON with a trailing newline", async () => {
    const target = path.join(tmpRoot, "subagents-bridge.json");
    const config = { agents: [{ url: "https://example.com/" }] };

    await writeBridgeConfig(config, target);

    const onDisk = await fs.readFile(target, "utf-8");
    expect(onDisk.endsWith("\n")).toBe(true);
    // Pretty-printed output uses two-space indentation.
    expect(onDisk).toContain('\n  "agents":');
  });

  // Requirement 4.2: file is written with mode 0600.
  // POSIX permission bits are not enforced on Windows; chmod is a no-op there.
  if (process.platform !== "win32") {
    it("sets file mode to 0600 on creation", async () => {
      const target = path.join(tmpRoot, "subagents-bridge.json");
      await writeBridgeConfig({ agents: [] }, target);

      const stat = await fs.stat(target);
      // Mask off the file type bits and keep only the permission bits.
      expect(stat.mode & 0o777).toBe(0o600);
    });

    it("re-applies 0600 mode when overwriting an existing file with looser permissions", async () => {
      const target = path.join(tmpRoot, "subagents-bridge.json");

      // Pre-create the file with a looser mode so we can confirm chmod runs
      // on the overwrite path (writeFile's `mode` only applies on creation).
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, "stale", { mode: 0o644 });
      const before = await fs.stat(target);
      expect(before.mode & 0o777).toBe(0o644);

      await writeBridgeConfig({ agents: [] }, target);

      const after = await fs.stat(target);
      expect(after.mode & 0o777).toBe(0o600);
    });
  }
});
