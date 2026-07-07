## Why

`a2a-opencode` wrapper 目前以 in-memory `Map` 保存 `contextId → sessionId` 映射（`session-manager.ts:44`），wrapper 重啟即遺失；且 TTL 清理（預設 1 小時，`config/defaults.ts:56-57`）會在不重啟的情況下也刪除 entry，導致消費端（GaiAgent）無法接回同一 opencode session，上下文延續中斷。opencode session 本身落地磁碟、可跨重啟存活，只要映射不丟即可 resume——目前缺的是映射持久化與消費端事前探測機制。

## What Changes

- 映射持久化：`SessionManager` 支援選用 `sessionMapFile`（JSON 檔），wrapper 重啟後還原 `contextId → sessionId` 映射；未設定時行為與現行完全相同（純 in-memory）。
- 寫入失敗容錯：映射檔寫入失敗（權限/磁碟滿）僅 log error 並 fallback in-memory 繼續運作，不中斷任務執行。
- TTL 可停用：`session.ttl <= 0` 時 cleanup timer 不清任何 entry（修正現行 `ttl=0` 等同全清的錯誤行為）；`ttl > 0` 行為不變（含持久化檔同步移除）。
- 新增 `GET /session-status?contextId=<id>` 探測端點：消費端送訊息前可先確認映射是否存在且驗活成功，決定是否需自帶歷史 preamble 重建；缺 `contextId` 回 `400`。
- 建新 session 時，初始 Task 事件 `metadata.sessionCreated === true`；續用既有 session 時無此欄位或為 `false`，讓消費端可辨識本輪是否為全新 session。
- 僅修改 `a2a-opencode` 套件，不影響 `a2a-codex`、`a2a-copilot`。

## Non-Goals

- 多實例共享映射（Redis 等）——單實例 JSON 檔即可。
- A2A endpoint 認證、permission 透傳——上游既有限制，另案處理。
- `a2a-codex` / `a2a-copilot` 同步套用——僅 `a2a-opencode`。
- 消費端（GaiAgent）重建 preamble 邏輯——在消費端實作，見上游 plan `gai-agent/.spex/plans/2026-07-07-brainstorm-opencode-session-resume.md`。
- 回饋 upstream PR——先自用，穩定後再議。

## Capabilities

### New Capabilities
- `opencode-session-resume`: `a2a-opencode` wrapper 的 session 映射持久化、TTL 停用、session 存在探測端點、以及 session 建立旗標，讓消費端能跨 wrapper 重啟接回同一 opencode session。

### Modified Capabilities
(none — 本次不修改既有已定義 capability，`opencode-session-resume` 為新引入)

## Impact

- Modified:
  - `a2a-opencode/src/opencode/session-manager.ts`（P1 持久化、`sessionExists`、`getOrCreate` 回傳 `created`、TTL<=0 停用）
  - `a2a-opencode/src/server/index.ts`（P2 route）
  - `a2a-opencode/src/opencode/executor.ts`（P3 順序調整 + metadata 傳遞）
  - `a2a-opencode/src/opencode/event-publisher.ts`（`publishTask` metadata 參數）
  - `a2a-opencode/src/config/types.ts` 與 `a2a-opencode/src/config/defaults.ts`（`sessionMapFile` 設定）
  - `a2a-opencode/src/cli.ts`（`--session-map-file` CLI 選項）
  - `a2a-opencode/src/__tests__/`（對應測試）
- New: 無（映射檔為執行期產物，非程式碼檔）
- Removed: 無

## Source

Derived from brainstorm plan: `.spex/plans/2026-07-07-brainstorm-session-resume-patches.md`

## Implementation Approach

Testing strategy: TDD — spex-apply enforces red→green per task.
