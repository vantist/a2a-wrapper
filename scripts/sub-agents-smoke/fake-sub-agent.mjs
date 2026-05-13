#!/usr/bin/env node
/**
 * Fake A2A sub-agent for the sub-agents smoke test.
 *
 * Serves a minimal but realistic agent card at /.well-known/agent-card.json
 * plus a JSON-RPC endpoint that responds to message/send so the
 * a2a-mcp-skillmap bridge can resolve a card and (optionally) be invoked
 * end-to-end.
 *
 * Usage:
 *   node fake-sub-agent.mjs <port> <agentName>
 */
import http from "node:http";

const port = Number(process.argv[2] ?? 4101);
const name = process.argv[3] ?? "fake-coding";

const baseUrl = `http://127.0.0.1:${port}`;

const agentCard = {
  protocolVersion: "0.3.0",
  name,
  description: `Fake ${name} sub-agent for the smoke test.`,
  version: "1.0.0",
  url: `${baseUrl}/a2a/jsonrpc`,
  preferredTransport: "JSONRPC",
  defaultInputModes: ["text"],
  defaultOutputModes: ["text"],
  capabilities: { streaming: false, pushNotifications: false },
  skills: [
    {
      id: "echo",
      name: "Echo",
      description: "Echo back whatever the caller sends. Useful for smoke tests.",
      tags: ["smoke", "echo"],
    },
    {
      id: "summarize",
      name: "Summarize",
      description: "Summarize the input text in one sentence.",
      tags: ["smoke", "summary"],
    },
  ],
};

const server = http.createServer((req, res) => {
  // Log every request so the test harness can assert on traffic.
  console.log(`[fake-sub-agent ${name}] ${req.method} ${req.url}`);

  if (req.method === "GET" && req.url === "/.well-known/agent-card.json") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(agentCard));
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    res.statusCode = 200;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ status: "ok", agent: name }));
    return;
  }

  if (req.method === "POST" && req.url === "/a2a/jsonrpc") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.statusCode = 400;
        res.end("bad json");
        return;
      }
      // Minimal JSON-RPC echo: respond with a fake task id and the request method.
      res.statusCode = 200;
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: parsed.id ?? null,
          result: {
            taskId: `fake-task-${Date.now()}`,
            agent: name,
            echoMethod: parsed.method,
          },
        }),
      );
    });
    return;
  }

  res.statusCode = 404;
  res.end("not found");
});

server.listen(port, "127.0.0.1", () => {
  console.log(
    `[fake-sub-agent ${name}] listening on ${baseUrl} (card at /.well-known/agent-card.json)`,
  );
});
