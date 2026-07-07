# a2a-opencode session resume patches（P1–P3）

<!-- Brainstorm plan. Next: /spex-propose (new change) or /spex-ingest (existing change).
     Simple plans may be implemented directly — but NEVER via /spex-apply, which requires a prior proposal. -->

## Context

- 本 fork 服務 GAI Agent（C# 後端）的 opencode resume 功能。上游設計來源：
  `gai-agent/.spex/plans/2026-07-07-brainstorm-opencode-session-resume.md`（消費端 plan，本檔為其 TS1 的 fork 端規格）。
- 消費端（GaiAgent）以 A2A `message/stream` 送訊息，`contextId` 固定 = conversationId；隔一段時間後重新對話時，需接回同一 opencode session（上下文延續）。
- **斷鏈根因（本 repo 實碼確認）**，位於 `a2a-opencode/src/opencode/session-manager.ts`：
  1. `contextMap`（contextId → sessionId）為 in-memory `Map`，wrapper 重啟即遺失（`session-manager.ts:44`）。
  2. **TTL 清理**：`startCleanup` 每 5 分鐘掃描，`lastUsed` 超過 `ttl`（預設 **1 小時**，`config/defaults.ts:56-57`）即刪 entry——不重啟也會斷鏈，極可能是實際觀察到的主因。
- **既有可利用機制**：`getOrCreate`（`session-manager.ts:87-116`）已內建驗活自癒——`client.sessionGet(sessionId)` 失敗 → 清 entry → `sessionCreate` 建新。驗活 API 不需另找。
- opencode session 本身落地磁碟，跨 opencode 重啟存活；只要映射不丟，resume 即成立。
- 相關落點：
  - `src/opencode/session-manager.ts` — 映射生命週期（P1 主場）。
  - `src/server/index.ts` — HTTP server（P2 新端點落點）。
  - `src/opencode/event-publisher.ts:25 publishTask` / `src/opencode/executor.ts:379,387` — Task 事件發佈與 `getOrCreate` 呼叫點（P3 落點）。
  - config：`src/config/types.ts:122-128`、`src/config/defaults.ts:54-57`（`SessionConfig`）。
- 消費端行為（wire contract 對象）：送訊息前先打 P2 端點探測；`exists=false` 時自帶歷史 preamble 重建，wrapper 無需理會重建內容。探測失敗 fail-open。

## Decision

三個 patch：P1 映射持久化（JSON 檔 + TTL 可停用）、P2 `GET /session-status` 探測端點、P3 Task metadata `sessionCreated` 旗標。僅動 `a2a-opencode` 套件，不碰 a2a-codex/a2a-copilot。

## Rationale

- 映射權威放 wrapper（非消費端 DB）：GAI Agent 端多 agent 類型時保持 agent-agnostic，`contextId` 為唯一通用契約——消費端已定案。
- TTL 停用而非調長：`getOrCreate` 驗活已提供 stale entry 自癒，TTL 淘汰對 resume 是純害處；保留 config 讓上游行為預設不變。
- 事前探測端點（而非只靠事後旗標）：旗標隨 Task 回來時該輪已無上下文回答完；消費端需要送出前的確定性。

## Requirements

- **R1**: 映射持久化，wrapper 重啟後還原
  - Acceptance: GIVEN 以 `sessionMapFile`（config，CLI `--session-map-file <path>`）啟動且 contextMap 有 entries WHEN wrapper 重啟 THEN 全部 contextId→sessionId 自檔案還原，同 contextId 續用原 session；未設定 `sessionMapFile` 時行為與現行完全相同（純 in-memory）
- **R2**: 映射檔寫入失敗不中斷服務
  - Acceptance: GIVEN 檔案不可寫（權限/磁碟滿） WHEN 映射更新 THEN log error、fallback in-memory 繼續運作，任務照常執行
- **R3**: TTL 可停用
  - Acceptance: GIVEN config `session.ttl <= 0` WHEN cleanup timer 觸發 THEN 不清任何 entry（現行 `now - lastUsed > ttl` 在 ttl=0 時等於全清，需修）；TTL > 0 時行為不變（含持久化檔同步移除）
- **R4**: `GET /session-status?contextId=<id>` 探測端點
  - Acceptance: GIVEN 映射存在且 `sessionGet` 成功 WHEN 呼叫端點 THEN `200 {"exists":true}`；GIVEN 映射存在但 `sessionGet` 失敗 THEN 清 entry（含檔案）並回 `{"exists":false}`；GIVEN 無映射 THEN `{"exists":false}`；GIVEN 缺 `contextId` 參數 THEN `400`
- **R5**: 建新 session 時 Task metadata 標示 `sessionCreated`
  - Acceptance: GIVEN `getOrCreate` 走到 `sessionCreate`（無映射或驗活失敗） WHEN 初始 Task 事件（`publishTask`）發佈 THEN Task `metadata.sessionCreated === true`；續用既有 session 時 THEN 無此欄位或為 `false`

## Non-Goals

- 多實例共享映射（Redis 等）——單實例 JSON 檔即可。
- A2A endpoint 認證、permission 透傳——上游既有限制，另案。
- a2a-codex / a2a-copilot 同步套用——僅 a2a-opencode。
- 消費端重建（preamble）邏輯——在 GaiAgent 端，見上游 plan。
- 回饋 upstream PR——先自用，穩定後再議。

## Design Notes

### Wire contract（與 GaiAgent C# 端的共同契約，兩邊不可各自改）

| 項目 | 形狀 |
|---|---|
| 探測 | `GET /session-status?contextId=<id>` → `200 {"exists": boolean}`；缺參數 `400` |
| 旗標 | 初始 Task 事件 `metadata.sessionCreated: true`（僅建新時） |
| 設定 | CLI `--session-map-file <path>`（對應 config `session.sessionMapFile`） |

### P1 映射持久化（`session-manager.ts`）

- `SessionConfig` 加 `sessionMapFile?: string`（`config/types.ts`；defaults 不設 = 關閉）。
- `SessionManager` 建構時載入檔案（不存在 = 空 map；解析失敗 = log error + 空 map 起跑，不 crash）。
- 寫入時機：`getOrCreate` set entry、驗活失敗 delete entry、TTL cleanup delete；整檔覆寫（entries 量小），失敗 log + 繼續（R2）。
- 檔案格式：`{ "<contextId>": { "sessionId": "...", "lastUsed": <epoch_ms> } }`（沿用 `SessionEntry` 形狀）。

### P2 session-status（`server/index.ts` + `session-manager.ts`）

- `SessionManager` 加 `async sessionExists(contextId: string): Promise<boolean>`——複用 `getOrCreate` 的「查 map → `sessionGet` 驗活 → 失敗清 entry」前半段，**但不建新 session**。
- `server/index.ts` 加 route，parse query → 呼叫 `sessionExists` → JSON 回應。

### P3 sessionCreated（`session-manager.ts` + `executor.ts` + `event-publisher.ts`）

- `getOrCreate` 回傳型別改 `{ sessionId: string, created: boolean }`（或加 out 參數，實作時定）；`executor.ts:387` 接收。
- 時序注意：`publishTask`（`executor.ts:379`）在 `getOrCreate`（:387）**之前**——需調整順序（先 getOrCreate 再 publishTask 帶 metadata）或改為在後續事件補 metadata；前者為佳，實作時確認 publishTask 前移無副作用。
- `publishTask` 簽章加 optional `metadata`。

### 邊界

- `reuseByContext: false` 時：P1/P2 無意義——`sessionExists` 一律回 `false`（消費端每輪重建，行為一致不炸）；P3 每輪 `created:true`。
- TTL 與持久化並用：cleanup 刪 entry 需同步寫檔（R3）。

## Impact

- Modified:
  - `a2a-opencode/src/opencode/session-manager.ts`（P1 持久化、sessionExists、getOrCreate 回傳 created、TTL<=0 停用）
  - `a2a-opencode/src/server/index.ts`（P2 route）
  - `a2a-opencode/src/opencode/executor.ts`（P3 順序調整 + metadata 傳遞）
  - `a2a-opencode/src/opencode/event-publisher.ts`（publishTask metadata 參數）
  - `a2a-opencode/src/config/types.ts` + `src/config/defaults.ts`（sessionMapFile）
  - `a2a-opencode/src/cli.ts`（`--session-map-file`）
  - `a2a-opencode/src/__tests__/`（對應測試）
- New: 無（映射檔為執行期產物）
- Removed: 無

## Task Seeds

- **TS1** (R1, R2, R3) — `SessionManager` 持久化：sessionMapFile config/CLI、載入/寫入/失敗 fallback、TTL<=0 停用 + 測試（載入還原、寫入失敗、ttl=0 不清）；files: `session-manager.ts`, `config/types.ts`, `config/defaults.ts`, `cli.ts`, tests; depends: none
- **TS2** (R4) — `sessionExists` + `GET /session-status` route + 測試（exists true/false/驗活失敗清 entry/400）；files: `session-manager.ts`, `server/index.ts`, tests; depends: TS1（共用檔案，序列化）
- **TS3** (R5) — `getOrCreate` 回傳 created + publishTask 順序調整與 metadata + 測試；files: `session-manager.ts`, `executor.ts`, `event-publisher.ts`, tests; depends: TS1
- **TS4** (R1–R5) — 端對端手動驗證（與 GaiAgent 會合前的 fork 端自檢）：重啟還原、TTL 停用放置 >1hr、curl 探測、SSE 觀察 sessionCreated；files: 驗證清單（README 或 docs）; depends: TS1–TS3

## Open Questions

- fork 基準版本落差：本 repo `a2a-opencode` package 為 **1.6.1**（HEAD `6d2d315`），前案調查與 pin 目標為 **1.7.0**——開工前同步 upstream 至 1.7.0 對應 tag/commit，或確認 1.6.1→1.7.0 差異不影響 patch 落點。
- `publishTask` 前移至 `getOrCreate` 之後是否影響 A2A 客戶端對「Task 事件先於一切」的預期（@a2a-js/sdk 行為）——TS3 實作時實測。

## Coverage Check

| Requirement | Task Seeds | Acceptance concrete? |
|-------------|------------|----------------------|
| R1 | TS1, TS4 | yes |
| R2 | TS1 | yes |
| R3 | TS1, TS4 | yes |
| R4 | TS2, TS4 | yes |
| R5 | TS3, TS4 | yes |
