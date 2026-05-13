import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import http, { type IncomingMessage, type ServerResponse } from "node:http";
import net, { type AddressInfo, type Socket } from "node:net";
import os from "node:os";
import path from "node:path";

import { bootstrapSubAgents } from "../../sub-agents/bootstrap.js";
import {
  SUBAGENTS_MCP_KEY,
  type SubAgentsConfig,
} from "../../sub-agents/types.js";
import { SubAgentValidationError } from "../../sub-agents/validate.js";
import { SKILLMAP_PACKAGE_VERSION } from "../../sub-agents/version.js";

/**
 * Integration tests for the sub-agents bootstrap orchestrator.
 *
 * Validates Requirements 1.1, 1.2, 7.4, 11.1–11.4 by exercising
 * {@link bootstrapSubAgents} end-to-end against a fresh temp workspace
 * and a real HTTP server (rather than mocking the filesystem). The
 * temp directory is created via `os.mkdtemp` and removed after each
 * test; HTTP probes hit a `http.createServer` helper modeled on the
 * probe.test.ts fixture.
 *
 * Coverage focus:
 * - Happy path: bridge config written to the workspace, file shape
 *   matches what skillmap consumes, and the synthesized descriptor
 *   is wired to the pinned skillmap version.
 * - Validation failures abort before any filesystem writes (the
 *   .a2a/ subdirectory must not appear on disk).
 * - Probe failures (5xx, connection refused) never abort: the
 *   bootstrap still returns a usable descriptor and a written
 *   bridge config so the bridge can serve tools as sub-agents come
 *   back online (Requirement 7.4).
 */

// ─── HTTP Server Fixtures ───────────────────────────────────────────────────

interface ServerFixture {
  url: string;
  port: number;
  close: () => Promise<void>;
}

async function startServer(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<ServerFixture> {
  const server = http.createServer(handler);
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${address.port}/`,
    port: address.port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        for (const socket of sockets) {
          socket.destroy();
        }
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

/**
 * Reserve a TCP port and immediately release it so the assigned
 * number can be used for a "nothing listens here" connection-refusal
 * test. The kernel may eventually re-assign this port, but for the
 * lifetime of a single test that race is vanishingly rare on
 * loopback.
 */
async function reserveUnusedPort(): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    const sock = net.createServer();
    sock.unref();
    sock.listen(0, "127.0.0.1", () => {
      const port = (sock.address() as AddressInfo).port;
      sock.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

// ─── Temp Workspace Fixture ─────────────────────────────────────────────────

let workspaceDir: string;

beforeEach(async () => {
  workspaceDir = await fs.mkdtemp(
    path.join(os.tmpdir(), "subagents-bootstrap-test-"),
  );
});

afterEach(async () => {
  await fs.rm(workspaceDir, { recursive: true, force: true });
});

const NO_RESERVED: ReadonlySet<string> = new Set();

// ─── Tests ──────────────────────────────────────────────────────────────────

describe("bootstrapSubAgents — happy path", () => {
  let fixture: ServerFixture;

  beforeEach(async () => {
    fixture = await startServer((_req, res) => {
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ name: "ok" }));
    });
  });

  afterEach(async () => {
    await fixture.close();
  });

  // Requirement 1.1, 11.1: parses sub-agents and writes a bridge config
  // summary line; the returned bridgeConfigPath is the workspace path.
  it("writes the bridge config to <workspace>/.a2a/subagents-bridge.json with the expected shape", async () => {
    const subAgents: SubAgentsConfig = {
      agents: [
        {
          name: "alpha",
          agentCardUrl: fixture.url,
        },
      ],
    };

    const result = await bootstrapSubAgents({
      subAgents,
      workspaceDir,
      parentLogLevel: "info",
      existingMcpKeys: NO_RESERVED,
    });

    const expectedPath = path.join(
      workspaceDir,
      ".a2a",
      "subagents-bridge.json",
    );
    expect(result.bridgeConfigPath).toBe(expectedPath);

    // File exists and contains the bridge config skillmap consumes.
    const onDisk = await fs.readFile(expectedPath, "utf-8");
    const parsed = JSON.parse(onDisk);
    expect(parsed).toEqual({
      agents: [{ url: fixture.url }],
      transport: "stdio",
      responseMode: "artifact",
      logging: { level: "info" },
    });
  });

  it("returns a descriptor wired to the pinned skillmap version and the bridge config path", async () => {
    const subAgents: SubAgentsConfig = {
      agents: [{ name: "alpha", agentCardUrl: fixture.url }],
    };

    const result = await bootstrapSubAgents({
      subAgents,
      workspaceDir,
      parentLogLevel: "info",
      existingMcpKeys: NO_RESERVED,
    });

    expect(result.descriptor.key).toBe(SUBAGENTS_MCP_KEY);
    expect(result.descriptor.command).toBe("npx");
    expect(result.descriptor.args).toEqual([
      "-y",
      `a2a-mcp-skillmap@${SKILLMAP_PACKAGE_VERSION}`,
      "--config",
      result.bridgeConfigPath,
    ]);
    // The task explicitly calls out args[3] as the config path.
    expect(result.descriptor.args[3]).toBe(result.bridgeConfigPath);
    expect(path.isAbsolute(result.descriptor.args[3])).toBe(true);
  });

  it("returns one ProbeResult per sub-agent in input order", async () => {
    const subAgents: SubAgentsConfig = {
      agents: [
        { name: "first", agentCardUrl: fixture.url },
        { name: "second", agentCardUrl: fixture.url },
      ],
    };

    const result = await bootstrapSubAgents({
      subAgents,
      workspaceDir,
      parentLogLevel: "info",
      existingMcpKeys: NO_RESERVED,
    });

    expect(result.probeResults).toHaveLength(2);
    expect(result.probeResults.map((r) => r.name)).toEqual(["first", "second"]);
    expect(result.probeResults[0].ok).toBe(true);
    expect(result.probeResults[0].status).toBe(200);
    expect(result.probeResults[1].ok).toBe(true);
    expect(result.probeResults[1].status).toBe(200);
  });

  // Requirement 4.6, 11.2: parent log level propagates into the bridge
  // config file written to disk.
  it("propagates parentLogLevel into the on-disk bridge config", async () => {
    const subAgents: SubAgentsConfig = {
      agents: [{ name: "alpha", agentCardUrl: fixture.url }],
    };

    await bootstrapSubAgents({
      subAgents,
      workspaceDir,
      parentLogLevel: "debug",
      existingMcpKeys: NO_RESERVED,
    });

    const onDisk = await fs.readFile(
      path.join(workspaceDir, ".a2a", "subagents-bridge.json"),
      "utf-8",
    );
    expect(JSON.parse(onDisk).logging).toEqual({ level: "debug" });
  });
});

describe("bootstrapSubAgents — validation failures abort before filesystem writes", () => {
  // Requirement 1.1, 11.4: validation failures throw before any I/O so
  // the .a2a/ directory should not appear on disk afterward.
  it("throws on duplicate sub-agent names without creating the bridge config", async () => {
    const subAgents: SubAgentsConfig = {
      agents: [
        {
          name: "coding",
          agentCardUrl: "https://a.example.com/.well-known/agent-card.json",
        },
        {
          name: "coding",
          agentCardUrl: "https://b.example.com/.well-known/agent-card.json",
        },
      ],
    };

    await expect(
      bootstrapSubAgents({
        subAgents,
        workspaceDir,
        parentLogLevel: "info",
        existingMcpKeys: NO_RESERVED,
      }),
    ).rejects.toBeInstanceOf(SubAgentValidationError);

    // The .a2a/ subdir must not have been created by the aborted run.
    const a2aDir = path.join(workspaceDir, ".a2a");
    await expect(fs.access(a2aDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws on a reserved-key collision without creating the bridge config", async () => {
    const subAgents: SubAgentsConfig = {
      agents: [
        {
          name: "coding",
          agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
        },
      ],
    };

    await expect(
      bootstrapSubAgents({
        subAgents,
        workspaceDir,
        parentLogLevel: "info",
        existingMcpKeys: new Set([SUBAGENTS_MCP_KEY]),
      }),
    ).rejects.toBeInstanceOf(SubAgentValidationError);

    const a2aDir = path.join(workspaceDir, ".a2a");
    await expect(fs.access(a2aDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("throws on an invalid agentCardUrl without creating the bridge config", async () => {
    const subAgents: SubAgentsConfig = {
      agents: [
        {
          name: "coding",
          agentCardUrl: "not-a-url",
        },
      ],
    };

    await expect(
      bootstrapSubAgents({
        subAgents,
        workspaceDir,
        parentLogLevel: "info",
        existingMcpKeys: NO_RESERVED,
      }),
    ).rejects.toBeInstanceOf(SubAgentValidationError);

    const a2aDir = path.join(workspaceDir, ".a2a");
    await expect(fs.access(a2aDir)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

describe("bootstrapSubAgents — probe failures do not abort", () => {
  // Requirement 7.4: even when every sub-agent probe fails, the bridge
  // entry is still registered so tools appear when the sub-agents come
  // back online. Bootstrap must therefore return a usable descriptor
  // and bridge config in this scenario.

  it("returns a valid descriptor and bridgeConfigPath when the probe gets a 500 response", async () => {
    const fixture = await startServer((_req, res) => {
      res.statusCode = 500;
      res.end("server is sad");
    });

    try {
      const subAgents: SubAgentsConfig = {
        agents: [{ name: "down", agentCardUrl: fixture.url }],
      };

      const result = await bootstrapSubAgents({
        subAgents,
        workspaceDir,
        parentLogLevel: "info",
        existingMcpKeys: NO_RESERVED,
      });

      // The descriptor still exists and points at the pinned skillmap.
      expect(result.descriptor.command).toBe("npx");
      expect(result.descriptor.args[1]).toBe(
        `a2a-mcp-skillmap@${SKILLMAP_PACKAGE_VERSION}`,
      );

      // The bridge config was still written to disk.
      const expectedPath = path.join(
        workspaceDir,
        ".a2a",
        "subagents-bridge.json",
      );
      expect(result.bridgeConfigPath).toBe(expectedPath);
      const onDisk = await fs.readFile(expectedPath, "utf-8");
      expect(JSON.parse(onDisk).agents).toEqual([{ url: fixture.url }]);

      // The probe failure is reported in probeResults but did not abort.
      expect(result.probeResults).toHaveLength(1);
      expect(result.probeResults[0].ok).toBe(false);
      expect(result.probeResults[0].status).toBe(500);
    } finally {
      await fixture.close();
    }
  });

  it("returns a valid descriptor and bridgeConfigPath when the probe is connection-refused", async () => {
    const port = await reserveUnusedPort();
    const url = `http://127.0.0.1:${port}/`;
    const subAgents: SubAgentsConfig = {
      agents: [{ name: "refused", agentCardUrl: url }],
    };

    const result = await bootstrapSubAgents({
      subAgents,
      workspaceDir,
      parentLogLevel: "info",
      existingMcpKeys: NO_RESERVED,
    });

    expect(result.descriptor.command).toBe("npx");
    expect(result.descriptor.args[1]).toBe(
      `a2a-mcp-skillmap@${SKILLMAP_PACKAGE_VERSION}`,
    );
    expect(result.descriptor.args[3]).toBe(result.bridgeConfigPath);

    const expectedPath = path.join(
      workspaceDir,
      ".a2a",
      "subagents-bridge.json",
    );
    expect(result.bridgeConfigPath).toBe(expectedPath);
    const stat = await fs.stat(expectedPath);
    expect(stat.isFile()).toBe(true);

    expect(result.probeResults).toHaveLength(1);
    expect(result.probeResults[0].ok).toBe(false);
    expect(result.probeResults[0].status).toBeUndefined();
    expect(typeof result.probeResults[0].error).toBe("string");
    expect(result.probeResults[0].error).not.toBe("");
  });

  it("returns a valid descriptor when only some sub-agents are reachable", async () => {
    const okFixture = await startServer((_req, res) => {
      res.statusCode = 200;
      res.end();
    });
    const port = await reserveUnusedPort();
    const refusedUrl = `http://127.0.0.1:${port}/`;

    try {
      const subAgents: SubAgentsConfig = {
        agents: [
          { name: "up", agentCardUrl: okFixture.url },
          { name: "down", agentCardUrl: refusedUrl },
        ],
      };

      const result = await bootstrapSubAgents({
        subAgents,
        workspaceDir,
        parentLogLevel: "info",
        existingMcpKeys: NO_RESERVED,
      });

      expect(result.probeResults).toHaveLength(2);
      expect(result.probeResults[0].ok).toBe(true);
      expect(result.probeResults[1].ok).toBe(false);

      // Descriptor and config are still produced.
      expect(result.descriptor.args[3]).toBe(result.bridgeConfigPath);
      const onDisk = await fs.readFile(result.bridgeConfigPath, "utf-8");
      expect(JSON.parse(onDisk).agents).toEqual([
        { url: okFixture.url },
        { url: refusedUrl },
      ]);
    } finally {
      await okFixture.close();
    }
  });
});
