# Manual E2E Verification Checklist

Tasks: R1 (mapping persistence), R3 (TTL disable), R4 (session-status probe), R5 (sessionCreated flag)

## Prerequisites

- OpenCode server running: `opencode serve`
- a2a-opencode wrapper running with map file:
  ```bash
  npx a2a-opencode --session-map-file /tmp/a2a-session-map.json
  ```

---

## TS1 — Session map persists across wrapper restarts (R1)

**Steps:**

1. Start wrapper with `--session-map-file /tmp/a2a-session-map.json`
2. Send a `message/stream` request with `contextId = "conv-restart-test"` via A2A REST or JSON-RPC
3. Observe wrapper starts, answer arrives, `/tmp/a2a-session-map.json` exists and contains entry for `conv-restart-test`
4. Stop the wrapper (`Ctrl+C`)
5. Restart wrapper with the same `--session-map-file`
6. Send another message with same `contextId = "conv-restart-test"`
7. Observe wrapper does NOT call `sessionCreate` (log: no "Session ready" with new sessionId) — session is resumed

**Expected:**
- Step 3: file contains `{"conv-restart-test": {"sessionId": "ses_...", "lastUsed": <epoch>}}`
- Step 7: same `sessionId` reused, OpenCode session context retained

---

## TS2 — TTL disable — entry survives after >1 hr idle (R3)

**Steps:**

1. Start wrapper with `--session-map-file /tmp/a2a-session-map.json` and no TTL override (default 1h TTL → set ttl=0 in config or env)
   ```json
   { "session": { "ttl": 0 } }
   ```
2. Send one message, confirm entry written to file
3. Wait >5 minutes (cleanup interval fires)
4. Inspect `/tmp/a2a-session-map.json` — entry must still be present
5. Send another message with same `contextId`

**Expected:**
- Step 4: file still has entry (cleanup skipped due to `ttl=0`)
- Step 5: session resumed, not recreated

---

## TS3 — curl probe: GET /session-status (R4)

**Steps:**

1. Start wrapper
2. With no prior session, probe: `curl "http://localhost:3000/session-status?contextId=conv-probe-test"`
   - Expected: `{"exists":false}` HTTP 200
3. Send a message with `contextId = "conv-probe-test"` to create a session
4. Probe again: `curl "http://localhost:3000/session-status?contextId=conv-probe-test"`
   - Expected: `{"exists":true}` HTTP 200
5. Probe without contextId: `curl "http://localhost:3000/session-status"`
   - Expected: HTTP 400

**Expected:**
- Step 2: `{"exists":false}`
- Step 4: `{"exists":true}`
- Step 5: HTTP 400 with error message

---

## TS4 — SSE stream: observe sessionCreated on Task event (R5)

**Steps:**

1. Start wrapper
2. Open SSE stream manually:
   ```bash
   curl -N -H "Accept: text/event-stream" \
     -H "Content-Type: application/json" \
     -X POST http://localhost:3000/a2a/rest/message/stream \
     -d '{"message":{"kind":"message","messageId":"m1","role":"user","parts":[{"kind":"text","text":"Hello"}],"contextId":"conv-sse-test"}}'
   ```
3. Observe the first SSE event (kind: "task") in the stream
4. Repeat with the same `contextId` in a new request

**Expected:**
- Step 3 (new session): Task event contains `"metadata":{"sessionCreated":true}`
- Step 4 (resumed session): Task event does NOT contain `metadata.sessionCreated` (or is `false`)
