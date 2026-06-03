/**
 * Smoke tests — a2a-opencode
 *
 * Cover the pure, dependency-free modules so CI always has something
 * to run. Expand these as the project grows.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── DEFAULTS ───────────────────────────────────────────────────────────────

import { DEFAULTS } from "../config/defaults.js";

describe("DEFAULTS", () => {
  it("has the expected protocol version", () => {
    expect(DEFAULTS.agentCard.protocolVersion).toBe("0.3.0");
  });

  it("defaults to port 3000", () => {
    expect(DEFAULTS.server.port).toBe(3000);
  });

  it("defaults to hostname 0.0.0.0", () => {
    expect(DEFAULTS.server.hostname).toBe("0.0.0.0");
  });

  it("defaults to advertiseHost localhost", () => {
    expect(DEFAULTS.server.advertiseHost).toBe("localhost");
  });

  it("defaults to OpenCode base URL http://localhost:4096", () => {
    expect(DEFAULTS.opencode.baseUrl).toBe("http://localhost:4096");
  });

  it("enables auto-approve permissions by default", () => {
    expect(DEFAULTS.features.autoApprovePermissions).toBe(true);
  });

  it("enables auto-answer questions by default", () => {
    expect(DEFAULTS.features.autoAnswerQuestions).toBe(true);
  });

  it("disables streamArtifactChunks by default", () => {
    expect(DEFAULTS.features.streamArtifactChunks).toBe(false);
  });

  it("enables polling fallback by default", () => {
    expect(DEFAULTS.features.enablePollingFallback).toBe(true);
  });

  it("enables session reuse by default", () => {
    expect(DEFAULTS.session.reuseByContext).toBe(true);
  });
});

// ─── Logger ─────────────────────────────────────────────────────────────────

import { Logger, LogLevel } from "../utils/logger.js";

describe("Logger", () => {
  it("parseLevel returns INFO for unknown strings", () => {
    expect(Logger.parseLevel("unknown")).toBe(LogLevel.INFO);
  });

  it("parseLevel handles all known levels", () => {
    expect(Logger.parseLevel("debug")).toBe(LogLevel.DEBUG);
    expect(Logger.parseLevel("info")).toBe(LogLevel.INFO);
    expect(Logger.parseLevel("warn")).toBe(LogLevel.WARN);
    expect(Logger.parseLevel("warning")).toBe(LogLevel.WARN);
    expect(Logger.parseLevel("error")).toBe(LogLevel.ERROR);
  });

  it("child logger is a Logger instance", () => {
    const log = new Logger("test");
    expect(log.child("sub")).toBeInstanceOf(Logger);
  });
});

// ─── loadConfigFile ──────────────────────────────────────────────────────────

import { loadConfigFile } from "../config/loader.js";

describe("loadConfigFile", () => {
  it("parses a valid JSON config file", () => {
    const tmp = join(tmpdir(), `a2a-opencode-test-${Date.now()}.json`);
    writeFileSync(tmp, JSON.stringify({ agentCard: { name: "Test Agent" } }));
    try {
      const cfg = loadConfigFile(tmp);
      expect(cfg.agentCard?.name).toBe("Test Agent");
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("throws a descriptive error for a missing file", () => {
    expect(() => loadConfigFile("/nonexistent/path/config.json")).toThrow(
      /config.*load|ENOENT|no such file/i,
    );
  });

  it("throws a descriptive error for invalid JSON", () => {
    const tmp = join(tmpdir(), `a2a-opencode-bad-${Date.now()}.json`);
    writeFileSync(tmp, "{ not valid json }");
    try {
      expect(() => loadConfigFile(tmp)).toThrow();
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});

// ─── resolveConfig — MCP env-token substitution ─────────────────────────────

import { resolveConfig } from "../config/loader.js";

describe("resolveConfig — MCP env-token substitution", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
  });

  afterEach(() => {
    process.env = OLD_ENV;
  });

  function writeMcpConfig(mcp: Record<string, unknown>): string {
    const tmp = join(tmpdir(), `a2a-opencode-mcp-tokens-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(tmp, JSON.stringify({ agentCard: { name: "Test" }, mcp }));
    return tmp;
  }

  it("substitutes ${VAR} in remote headers", () => {
    process.env["LINEAR_API_KEY"] = "secret-123";
    const tmp = writeMcpConfig({
      linear: {
        type: "remote",
        url: "https://mcp.linear.app/sse",
        headers: { Authorization: "Bearer ${LINEAR_API_KEY}" },
      },
    });
    try {
      const cfg = resolveConfig(tmp);
      const srv = cfg.mcp!.linear as { headers?: Record<string, string> };
      expect(srv.headers?.Authorization).toBe("Bearer secret-123");
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("substitutes ${VAR} in local environment values", () => {
    process.env["GH_PAT"] = "ghp_xxx";
    const tmp = writeMcpConfig({
      github: {
        type: "local",
        command: ["npx", "-y", "@some/mcp-server"],
        environment: { GITHUB_TOKEN: "${GH_PAT}" },
      },
    });
    try {
      const cfg = resolveConfig(tmp);
      const srv = cfg.mcp!.github as { environment?: Record<string, string> };
      expect(srv.environment?.GITHUB_TOKEN).toBe("ghp_xxx");
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("substitutes bare $VAR in local command (backward compatible)", () => {
    process.env["WORKSPACE_DIR"] = "/tmp/ws";
    const tmp = writeMcpConfig({
      fs: {
        type: "local",
        command: ["npx", "-y", "@modelcontextprotocol/server-filesystem", "$WORKSPACE_DIR"],
      },
    });
    try {
      const cfg = resolveConfig(tmp);
      const srv = cfg.mcp!.fs as { command?: string[] };
      expect(srv.command?.[3]).toBe("/tmp/ws");
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  it("leaves unresolved tokens unchanged", () => {
    delete process.env["DOES_NOT_EXIST"];
    const tmp = writeMcpConfig({
      svc: {
        type: "remote",
        url: "https://example.com/sse",
        headers: { Authorization: "Bearer ${DOES_NOT_EXIST}" },
      },
    });
    try {
      const cfg = resolveConfig(tmp);
      const srv = cfg.mcp!.svc as { headers?: Record<string, string> };
      expect(srv.headers?.Authorization).toBe("Bearer ${DOES_NOT_EXIST}");
    } finally {
      rmSync(tmp, { force: true });
    }
  });
});
