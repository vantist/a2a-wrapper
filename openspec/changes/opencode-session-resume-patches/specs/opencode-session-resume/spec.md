## ADDED Requirements

### Requirement: Session map persists across wrapper restarts
`SessionManager` SHALL support an optional `sessionMapFile` configuration (config key `session.sessionMapFile`, CLI `--session-map-file <path>`). When set, the `contextId → sessionId` mapping SHALL be persisted to that file and reloaded on startup, so a wrapper restart does not break session resume. When `sessionMapFile` is not set, behavior SHALL remain exactly the same as the current in-memory-only implementation.

#### Scenario: Mapping restored after restart
- **WHEN** the wrapper is started with `sessionMapFile` configured, the `contextMap` accumulates entries during operation, and the wrapper is then restarted
- **THEN** all `contextId → sessionId` entries are restored from the file on startup, and the same `contextId` continues to reuse its original `sessionId`

#### Scenario: No sessionMapFile configured — unchanged behavior
- **WHEN** the wrapper is started without `sessionMapFile` set (config absent, CLI flag absent)
- **THEN** the `contextMap` behaves purely in-memory, identical to current behavior, and no file is read or written

#### Scenario: Missing or unparseable map file on startup
- **WHEN** `sessionMapFile` is configured but the file does not exist, or exists but fails to parse
- **THEN** `SessionManager` starts with an empty map, logs an error if parsing failed, and does not crash

##### Example: Persisted map file format
```json
{
  "conv-123": { "sessionId": "ses_abc", "lastUsed": 1750000000000 }
}
```

### Requirement: Session map write failures do not interrupt service
Writes to `sessionMapFile` SHALL be best-effort. When a write fails (e.g. permission denied, disk full), `SessionManager` SHALL log the error, fall back to continuing in-memory, and SHALL NOT interrupt or fail the in-flight task.

#### Scenario: Write failure falls back to in-memory
- **WHEN** the map file is not writable (permission error or disk full) and the mapping is updated (new session created, stale entry deleted, or TTL cleanup deletes an entry)
- **THEN** the error is logged, the in-memory `contextMap` update proceeds normally, and the current task completes as if the write had succeeded

### Requirement: TTL cleanup can be disabled
The session cleanup timer SHALL treat `session.ttl <= 0` as "TTL disabled": no entry is evicted regardless of `lastUsed` age. This corrects the current behavior where `ttl = 0` causes the `now - lastUsed > ttl` check to evict every entry on every cleanup pass. Behavior for `ttl > 0` SHALL be unchanged, including synchronized removal from the persisted map file when `sessionMapFile` is configured.

#### Scenario: ttl <= 0 disables cleanup
- **GIVEN** `session.ttl` is configured as `0` or a negative value
- **WHEN** the cleanup timer fires
- **THEN** no entries are evicted from `contextMap`, regardless of how old `lastUsed` is

#### Scenario: ttl > 0 behavior unchanged
- **GIVEN** `session.ttl` is configured as a positive value
- **WHEN** the cleanup timer fires and an entry's `now - lastUsed > ttl`
- **THEN** that entry is evicted from `contextMap`, and if `sessionMapFile` is configured, the same entry is removed from the persisted file

### Requirement: Session existence probe endpoint
The server SHALL expose `GET /session-status?contextId=<id>`, allowing a consumer to check — before sending a message — whether a resumable session exists for a given `contextId`, reusing the same "look up map → verify liveness via `sessionGet` → clear stale entry on failure" logic as `getOrCreate`, but without creating a new session.

#### Scenario: Mapping exists and session is alive
- **WHEN** `GET /session-status?contextId=<id>` is called and a mapping exists for `<id>` and `sessionGet` succeeds
- **THEN** the response is `200 {"exists": true}`

#### Scenario: Mapping exists but session is dead
- **WHEN** `GET /session-status?contextId=<id>` is called and a mapping exists for `<id>` but `sessionGet` fails
- **THEN** the stale entry is cleared (including from the persisted map file, if configured) and the response is `200 {"exists": false}`

#### Scenario: No mapping exists
- **WHEN** `GET /session-status?contextId=<id>` is called and no mapping exists for `<id>`
- **THEN** the response is `200 {"exists": false}`

#### Scenario: Missing contextId parameter
- **WHEN** `GET /session-status` is called without a `contextId` query parameter
- **THEN** the response is `400`

#### Scenario: reuseByContext disabled
- **WHEN** the server config has `reuseByContext: false` and `GET /session-status?contextId=<id>` is called
- **THEN** the response is always `200 {"exists": false}`, regardless of any prior mapping

### Requirement: New-session creation is flagged on the initial Task event
When `getOrCreate` creates a new opencode session (no existing mapping, or liveness check failed), the initial Task event published via `publishTask` SHALL include `metadata.sessionCreated === true`. When an existing session is reused, the Task event SHALL either omit this field or set it to `false`.

#### Scenario: New session created
- **WHEN** `getOrCreate` falls through to `sessionCreate` (no mapping found, or `sessionGet` liveness check failed)
- **THEN** the initial Task event published via `publishTask` has `metadata.sessionCreated === true`

#### Scenario: Existing session reused
- **WHEN** `getOrCreate` finds a live existing mapping and reuses it (no `sessionCreate` call)
- **THEN** the initial Task event either omits `metadata.sessionCreated` or sets it to `false`

#### Scenario: reuseByContext disabled
- **WHEN** the server config has `reuseByContext: false`
- **THEN** every request creates a new session and its initial Task event has `metadata.sessionCreated === true`
