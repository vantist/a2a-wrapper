#!/usr/bin/env node
/**
 * A2A Sub-Agents Scenario — End-to-End Test
 * ==========================================
 *
 * This script exercises the full sub-agents pipeline:
 *
 *   1. Bootstrap  — validates config, writes bridge config, probes agents
 *   2. Bridge     — spawns the real a2a-mcp-skillmap bridge via npx
 *   3. MCP        — speaks MCP over stdio: initialize → tools/list → tool call
 *   4. Assert     — verifies each sub-agent's skills appear as MCP tools
 *                   and that calling a tool returns a real response
 *
 * Prerequisites
 * -------------
 *   • Node.js >= 20
 *   • Both sub-agents running:
 *       node agents/coding-agent.mjs    (port 4101)
 *       node agents/research-agent.mjs  (port 4102)
 *   • Internet access for npx to download a2a-mcp-skillmap (first run only)
 *
 * Run
 * ---
 *   node test/run-scenario.mjs
 *
 * Exit codes
 * ----------
 *   0  All assertions passed
 *   1  One or more assertions failed (details on stderr)
 */

import { spawn } from "node:child_process";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ─── Resolve @a2a-wrapper/core from the monorepo ─────────────────────────────
// Import directly from the built dist so this works both inside the monorepo
// and when the package is installed normally via npm.
import { bootstrapSubAgents } from "@a2a-wrapper/core";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const EXAMPLE_ROOT = path.resolve(__dirname, "..");

// ─── Configuration ────────────────────────────────────────────────────────────

const SUB_AGENTS = [
  {
    name: "coding",
    port: 4101,
    expectedTools: ["coding__review", "coding__explain"],
    toolToCall: "coding__review",
    toolInput: { message: "function add(a, b) { return a + b; }" },
  },
  {
    name: "research",
    port: 4102,
    expectedTools: ["research__search", "research__summarize"],
    toolToCall: "research__search",
    toolInput: { message: "A2A protocol multi-agent systems" },
  },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const PASS = "\x1b[32m✓\x1b[0m";
const FAIL = "\x1b[31m✗\x1b[0m";
const INFO = "\x1b[36mℹ\x1b[0m";
const BOLD = (s) => `\x1b[1m${s}\x1b[0m`;

let passed = 0;
let failed = 0;

function assert(condition, label, detail = "") {
  if (condition) {
    console.log(`  ${PASS} ${label}`);
    passed++;
  } else {
    console.error(`  ${FAIL} ${label}${detail ? `\n      ${detail}` : ""}`);
    failed++;
  }
}

// ─── MCP Client (minimal stdio JSON-RPC) ─────────────────────────────────────

function createMcpClient(child) {
  let buffer = "";
  const pending = new Map(); // id → { resolve, reject }

  child.stdout.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    let nl;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, nl).trim();
      buffer = buffer.slice(nl + 1);
      if (!line) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id != null && pending.has(msg.id)) {
          const { resolve } = pending.get(msg.id);
          pending.delete(msg.id);
          resolve(msg);
        }
      } catch {
        // non-JSON line from bridge (e.g. pino log) — ignore
      }
    }
  });

  function send(msg) {
    child.stdin.write(JSON.stringify(msg) + "\n");
  }

  function request(id, method, params = {}, timeoutMs = 30_000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`MCP request "${method}" (id=${id}) timed out after ${timeoutMs}ms`)),
        timeoutMs,
      );
      pending.set(id, {
        resolve: (msg) => {
          clearTimeout(timer);
          resolve(msg);
        },
        reject,
      });
      send({ jsonrpc: "2.0", id, method, params });
    });
  }

  function notify(method, params = {}) {
    send({ jsonrpc: "2.0", method, params });
  }

  return { request, notify };
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log();
  console.log(BOLD("A2A Sub-Agents Scenario — End-to-End Test"));
  console.log("─".repeat(50));
  console.log();

  // ── Step 1: Verify sub-agents are reachable ──────────────────────────────
  console.log(BOLD("Step 1: Verify sub-agents are reachable"));
  for (const sub of SUB_AGENTS) {
    try {
      const res = await fetch(`http://127.0.0.1:${sub.port}/.well-known/agent-card.json`);
      const card = await res.json();
      assert(
        res.ok && card.name === sub.name,
        `${sub.name} agent card reachable at :${sub.port}`,
        res.ok ? "" : `HTTP ${res.status}`,
      );
    } catch (err) {
      assert(false, `${sub.name} agent card reachable at :${sub.port}`, err.message);
    }
  }
  console.log();

  // ── Step 2: Bootstrap ────────────────────────────────────────────────────
  console.log(BOLD("Step 2: Bootstrap (validate → write bridge config → probe)"));

  const workspace = await mkdtemp(path.join(os.tmpdir(), "a2a-scenario-"));
  console.log(`  ${INFO} workspace: ${workspace}`);

  let bootstrapResult;
  try {
    bootstrapResult = await bootstrapSubAgents({
      subAgents: {
        agents: SUB_AGENTS.map((s) => ({
          name: s.name,
          agentCardUrl: `http://127.0.0.1:${s.port}/.well-known/agent-card.json`,
        })),
        options: { responseMode: "artifact", probeTimeoutMs: 5000, syncBudgetMs: 30000 },
      },
      workspaceDir: workspace,
      parentLogLevel: "info",
      existingMcpKeys: new Set(),
    });
  } catch (err) {
    console.error(`  ${FAIL} bootstrapSubAgents threw: ${err.message}`);
    process.exit(1);
  }

  assert(
    bootstrapResult.descriptor.command === "npx",
    "descriptor.command is 'npx'",
  );
  assert(
    bootstrapResult.descriptor.args[1].startsWith("a2a-mcp-skillmap@"),
    `descriptor uses pinned skillmap version (${bootstrapResult.descriptor.args[1]})`,
  );
  assert(
    path.isAbsolute(bootstrapResult.bridgeConfigPath),
    `bridge config written to absolute path`,
  );

  // Verify bridge config on disk contains both agents.
  const bridgeConfigRaw = await readFile(bootstrapResult.bridgeConfigPath, "utf-8");
  const bridgeConfig = JSON.parse(bridgeConfigRaw);
  assert(
    bridgeConfig.agents.length === SUB_AGENTS.length,
    `bridge config contains ${SUB_AGENTS.length} agents`,
  );
  assert(
    bridgeConfig.transport === "stdio",
    "bridge config transport is 'stdio'",
  );
  assert(
    bridgeConfig.syncBudgetMs === 30000,
    "bridge config syncBudgetMs is 30000",
  );

  for (const r of bootstrapResult.probeResults) {
    assert(r.ok, `probe: ${r.name} reachable (${r.durationMs}ms, HTTP ${r.status})`);
  }
  console.log();

  // ── Step 3: Spawn the bridge ─────────────────────────────────────────────
  console.log(BOLD("Step 3: Spawn a2a-mcp-skillmap bridge via npx"));
  console.log(`  ${INFO} command: ${bootstrapResult.descriptor.command} ${bootstrapResult.descriptor.args.join(" ")}`);

  const bridge = spawn(
    bootstrapResult.descriptor.command,
    bootstrapResult.descriptor.args,
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env } },
  );

  bridge.stderr.on("data", (chunk) => {
    // Uncomment to see bridge logs:
    // process.stderr.write(`  [bridge] ${chunk}`);
  });

  let bridgeExited = false;
  bridge.on("exit", (code, signal) => {
    bridgeExited = true;
    if (signal !== "SIGTERM") {
      console.log(`  ${INFO} bridge exited: code=${code} signal=${signal}`);
    }
  });

  // Give npx time to download and start the bridge.
  console.log(`  ${INFO} waiting 6s for bridge to start (npx download on first run)...`);
  await new Promise((r) => setTimeout(r, 6000));

  assert(!bridgeExited, "bridge process is still running after startup");
  console.log();

  // ── Step 4: MCP handshake ────────────────────────────────────────────────
  console.log(BOLD("Step 4: MCP initialize handshake"));

  const mcp = createMcpClient(bridge);

  let initResp;
  try {
    initResp = await mcp.request(1, "initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "a2a-scenario-test", version: "1.0.0" },
    }, 60_000);
  } catch (err) {
    assert(false, "initialize handshake succeeded", err.message);
    bridge.kill("SIGTERM");
    await cleanup(workspace);
    process.exit(1);
  }

  assert(!initResp.error, "initialize returned no error");
  assert(
    initResp.result?.serverInfo?.name === "a2a-mcp-skillmap",
    `server identified as a2a-mcp-skillmap (got: ${initResp.result?.serverInfo?.name})`,
  );

  mcp.notify("notifications/initialized");
  console.log();

  // ── Step 5: tools/list ───────────────────────────────────────────────────
  console.log(BOLD("Step 5: tools/list — verify sub-agent skills are exposed"));

  const toolsResp = await mcp.request(2, "tools/list", {}, 15_000);
  const tools = toolsResp.result?.tools ?? [];

  assert(tools.length > 0, `tools/list returned ${tools.length} tools`);

  for (const sub of SUB_AGENTS) {
    for (const expectedTool of sub.expectedTools) {
      const found = tools.find((t) => t.name === expectedTool);
      assert(!!found, `tool "${expectedTool}" is present`);
      if (found) {
        assert(
          typeof found.description === "string" && found.description.length > 0,
          `tool "${expectedTool}" has a description`,
        );
      }
    }
  }

  console.log();
  console.log(`  ${INFO} All tools exposed by the bridge:`);
  for (const t of tools) {
    console.log(`       ${t.name}`);
  }
  console.log();

  // ── Step 6: Call a tool ──────────────────────────────────────────────────
  console.log(BOLD("Step 6: Call a tool on each sub-agent"));

  let callId = 3;
  for (const sub of SUB_AGENTS) {
    const toolName = sub.toolToCall;
    console.log(`  ${INFO} calling ${toolName}...`);

    let callResp;
    try {
      callResp = await mcp.request(
        callId++,
        "tools/call",
        { name: toolName, arguments: sub.toolInput },
        30_000,
      );
    } catch (err) {
      assert(false, `${toolName} call succeeded`, err.message);
      continue;
    }

    assert(!callResp.error, `${toolName} returned no error`);

    const content = callResp.result?.content ?? [];
    const hasText = content.some((c) => c.type === "text" && c.text?.length > 0);
    assert(hasText, `${toolName} response contains text content`);

    if (hasText) {
      const preview = content.find((c) => c.type === "text")?.text?.slice(0, 100) ?? "";
      console.log(`       Response preview: "${preview}..."`);
    }
  }
  console.log();

  // ── Teardown ─────────────────────────────────────────────────────────────
  bridge.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 300));
  await cleanup(workspace);

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log("─".repeat(50));
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\x1b[32m${BOLD("PASS")} — ${passed}/${total} assertions passed\x1b[0m`);
    console.log();
  } else {
    console.error(`\x1b[31m${BOLD("FAIL")} — ${failed}/${total} assertions failed\x1b[0m`);
    console.log();
    process.exit(1);
  }
}

async function cleanup(workspace) {
  try {
    await rm(workspace, { recursive: true, force: true });
  } catch {
    // best-effort
  }
}

main().catch((err) => {
  console.error(`\n${FAIL} Unexpected error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
