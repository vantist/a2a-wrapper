#!/usr/bin/env node
/**
 * Sub-agents smoke test driver.
 *
 * Exercises the production bootstrap path end-to-end:
 *   1. Run `bootstrapSubAgents` (validate → write bridge config → probe → synthesize).
 *   2. Spawn the real `a2a-mcp-skillmap` bridge with the generated config.
 *   3. Speak MCP to the bridge over stdio: initialize handshake, then
 *      tools/list, then assert tools for every sub-agent appear.
 *
 * Exit code 0 → smoke test passed. Non-zero → diagnostic on stderr.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { bootstrapSubAgents } from "@a2a-wrapper/core";

const SUB_AGENT_PORTS = [
  { port: 4101, name: "coding" },
  { port: 4102, name: "research" },
];

async function main() {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "a2a-subagents-smoke-"));
  console.log(`[smoke] workspace: ${workspace}`);

  // 1. Bootstrap.
  const result = await bootstrapSubAgents({
    subAgents: {
      agents: SUB_AGENT_PORTS.map((s) => ({
        name: s.name,
        agentCardUrl: `http://127.0.0.1:${s.port}/.well-known/agent-card.json`,
      })),
    },
    workspaceDir: workspace,
    parentLogLevel: "info",
    existingMcpKeys: new Set(),
  });

  console.log("[smoke] bootstrap descriptor:", JSON.stringify(result.descriptor, null, 2));
  console.log("[smoke] bridge config path:", result.bridgeConfigPath);
  console.log("[smoke] probe results:", JSON.stringify(result.probeResults, null, 2));

  for (const r of result.probeResults) {
    if (!r.ok) {
      throw new Error(`probe failed for ${r.name}: ${r.error ?? `status ${r.status}`}`);
    }
  }

  // 2. Spawn the bridge.
  const child = spawn(result.descriptor.command, result.descriptor.args, {
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, FASTMCP_LOG_LEVEL: "INFO" },
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[bridge stderr] ${chunk}`);
  });

  child.on("exit", (code, signal) => {
    console.log(`[smoke] bridge exited: code=${code} signal=${signal}`);
  });

  // npx needs time to download/spawn the bridge before we send anything.
  console.log("[smoke] waiting 6s for bridge to start...");
  await new Promise((r) => setTimeout(r, 6000));

  // 3. Speak MCP to the bridge.
  let stdoutBuffer = "";
  const pendingMessages = [];
  let resolveNext = null;

  child.stdout.on("data", (chunk) => {
    stdoutBuffer += chunk.toString("utf-8");
    let nlIdx;
    while ((nlIdx = stdoutBuffer.indexOf("\n")) !== -1) {
      const line = stdoutBuffer.slice(0, nlIdx).trim();
      stdoutBuffer = stdoutBuffer.slice(nlIdx + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        pendingMessages.push(msg);
        if (resolveNext) {
          const r = resolveNext;
          resolveNext = null;
          r();
        }
      } catch (e) {
        process.stderr.write(`[bridge stdout (non-JSON)] ${line}\n`);
      }
    }
  });

  function send(msg) {
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  async function waitForResponse(id, timeoutMs = 10_000) {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const idx = pendingMessages.findIndex((m) => m.id === id);
      if (idx !== -1) {
        return pendingMessages.splice(idx, 1)[0];
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`timeout waiting for response id ${id}`);
      }
      await new Promise((r) => {
        const t = setTimeout(r, remaining);
        resolveNext = () => {
          clearTimeout(t);
          r();
        };
      });
    }
  }

  try {
    // 3a. initialize
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2024-11-05",
        capabilities: {},
        clientInfo: { name: "smoke-test", version: "1.0.0" },
      },
    });
    const initResp = await waitForResponse(1, 60_000);
    console.log("[smoke] initialize response:", JSON.stringify(initResp.result?.serverInfo ?? initResp, null, 2));

    // initialized notification
    send({ jsonrpc: "2.0", method: "notifications/initialized" });

    // 3b. tools/list
    send({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const toolsResp = await waitForResponse(2, 15_000);
    const tools = toolsResp.result?.tools ?? [];
    console.log(`[smoke] tools/list returned ${tools.length} tools:`);
    for (const t of tools) {
      console.log(`  - ${t.name} :: ${t.description ?? ""}`);
    }

    // Assert each sub-agent has at least one tool prefixed with its name.
    for (const sub of SUB_AGENT_PORTS) {
      const matches = tools.filter((t) => t.name.startsWith(sub.name));
      if (matches.length === 0) {
        throw new Error(
          `expected at least one tool prefixed with "${sub.name}" but found none. tool names: ${tools
            .map((t) => t.name)
            .join(", ")}`,
        );
      }
      console.log(
        `[smoke] ✓ sub-agent "${sub.name}" exposed ${matches.length} tool(s): ${matches
          .map((m) => m.name)
          .join(", ")}`,
      );
    }

    console.log("[smoke] PASS");
  } finally {
    child.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 200));
    await rm(workspace, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error("[smoke] FAIL:", err.message);
  console.error(err.stack);
  process.exit(1);
});
