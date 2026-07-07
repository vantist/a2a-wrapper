## Context

`a2a-opencode` 服務 GAI Agent（C# 後端）的 opencode resume 功能。消費端以 A2A `message/stream` 送訊息，`contextId` 固定 = conversationId；隔一段時間後重新對話時，需接回同一 opencode session（上下文延續）。上游設計來源：`gai-agent/.spex/plans/2026-07-07-brainstorm-opencode-session-resume.md`（消費端 plan，本檔為其 TS1 的 fork 端規格）。

斷鏈根因（本 repo 實碼確認），位於 `a2a-opencode/src/opencode/session-manager.ts`：
1. `contextMap`（contextId → sessionId）為 in-memory `Map`，wrapper 重啟即遺失（`session-manager.ts:44`）。
2. TTL 清理：`startCleanup` 每 5 分鐘掃描，`lastUsed` 超過 `ttl`（預設 1 小時，`config/defaults.ts:56-57`）即刪 entry——不重啟也會斷鏈，極可能是實際觀察到的主因。

既有可利用機制：`getOrCreate`（`session-manager.ts:87-116`）已內建驗活自癒——`client.sessionGet(sessionId)` 失敗 → 清 entry → `sessionCreate` 建新。驗活 API 不需另找。opencode session 本身落地磁碟，跨 opencode 重啟存活；只要映射不丟，resume 即成立。

相關落點：
- `src/opencode/session-manager.ts` — 映射生命週期（P1 主場）。
- `src/server/index.ts` — HTTP server（P2 新端點落點）。
- `src/opencode/event-publisher.ts:25 publishTask` / `src/opencode/executor.ts:379,387` — Task 事件發佈與 `getOrCreate` 呼叫點（P3 落點）。
- config：`src/config/types.ts:122-128`、`src/config/defaults.ts:54-57`（`SessionConfig`）。

消費端行為（wire contract 對象）：送訊息前先打 P2 端點探測；`exists=false` 時自帶歷史 preamble 重建，wrapper 無需理會重建內容。探測失敗 fail-open。

## Goals / Non-Goals

**Goals:**
- 映射權威放 wrapper（非消費端 DB），讓 GAI Agent 端多 agent 類型時保持 agent-agnostic，`contextId` 為唯一通用契約。
- 提供消費端事前探測端點（而非只靠事後旗標）——旗標隨 Task 回來時該輪已無上下文回答完；消費端需要送出前的確定性。
- TTL 停用而非調長——`getOrCreate` 驗活已提供 stale entry 自癒，TTL 淘汰對 resume 是純害處；保留 config 讓上游行為預設不變。

**Non-Goals:**
- 多實例共享映射（Redis 等）——單實例 JSON 檔即可。
- A2A endpoint 認證、permission 透傳——上游既有限制，另案。
- `a2a-codex` / `a2a-copilot` 同步套用——僅 `a2a-opencode`。
- 消費端重建（preamble）邏輯——在 GaiAgent 端，見上游 plan。
- 回饋 upstream PR——先自用，穩定後再議。

## Decisions

### Wire contract（與 GaiAgent C# 端的共同契約，兩邊不可各自改）

| 項目 | 形狀 |
|---|---|
| 探測 | `GET /session-status?contextId=<id>` → `200 {"exists": boolean}`；缺參數 `400` |
| 旗標 | 初始 Task 事件 `metadata.sessionCreated: true`（僅建新時） |
| 設定 | CLI `--session-map-file <path>`（對應 config `session.sessionMapFile`） |

### P1 映射持久化（`session-manager.ts`）

- `SessionConfig` 加 `sessionMapFile?: string`（`config/types.ts`；defaults 不設 = 關閉）。
- `SessionManager` 建構時載入檔案（不存在 = 空 map；解析失敗 = log error + 空 map 起跑，不 crash）。
- 寫入時機：`getOrCreate` set entry、驗活失敗 delete entry、TTL cleanup delete；整檔覆寫（entries 量小），失敗 log + 繼續（對應 R2）。
- 檔案格式：`{ "<contextId>": { "sessionId": "...", "lastUsed": <epoch_ms> } }`（沿用既有 `SessionEntry` 形狀）。
- 選擇整檔覆寫而非 append-only log：entries 量小（單一 wrapper instance 服務的 conversation 數量有限），整檔覆寫實作簡單、無需額外 compaction 邏輯。

### P2 session-status（`server/index.ts` + `session-manager.ts`）

- `SessionManager` 加 `async sessionExists(contextId: string): Promise<boolean>`——複用 `getOrCreate` 的「查 map → `sessionGet` 驗活 → 失敗清 entry」前半段，但不建新 session。
- `server/index.ts` 加 route，parse query → 呼叫 `sessionExists` → JSON 回應。
- 選擇獨立 `sessionExists` 方法而非讓 `getOrCreate` 加 `dryRun` 參數：避免既有呼叫點（`executor.ts`）誤用旗標導致意外建立 session；獨立方法語意明確、呼叫點不會混淆。

### P3 sessionCreated（`session-manager.ts` + `executor.ts` + `event-publisher.ts`）

- `getOrCreate` 回傳型別改為 `{ sessionId: string, created: boolean }`；`executor.ts:387` 接收。
- 時序調整：`publishTask`（`executor.ts:379`）現時序在 `getOrCreate`（:387）之前，需調整為先 `getOrCreate` 再 `publishTask` 帶 metadata。前移風險：需確認 A2A 客戶端（`@a2a-js/sdk`）對「Task 事件先於一切」無強制假設；若有風險則改為在後續事件補 metadata（設計層面保留此後備方案，TS3 實作時實測決定）。
- `publishTask` 簽章加 optional `metadata` 參數，向後相容既有無 metadata 呼叫點。

### 邊界情況

- `reuseByContext: false` 時：P1/P2 無意義——`sessionExists` 一律回 `false`（消費端每輪重建，行為一致不炸）；P3 每輪 `created: true`。
- TTL 與持久化並用：cleanup 刪 entry 需同步寫檔（對應 R3）。

## Risks / Trade-offs

- [Risk] `publishTask` 前移至 `getOrCreate` 之後，若 A2A 客戶端依賴「Task 事件必須先於其他一切事件送出」的時序假設，可能造成消費端狀態機異常 → Mitigation：TS3 實作時以 `@a2a-js/sdk` 實測驗證；若前移不可行，改為在後續事件補 `metadata.sessionCreated`（不動 `publishTask` 呼叫順序）。
- [Risk] 映射檔整檔覆寫在高並發寫入下可能有 race condition（多個 request 同時觸發 `getOrCreate` 寫檔）→ Mitigation：本次不做並發鎖，僅記錄於 Open Questions；單實例場景下寫入頻率低（每次 session 建立/驗活失敗/TTL 清理），可接受風險。
- [Risk] fork 基準版本落差（本 repo 1.6.1 vs. 前案調查/pin 目標 1.7.0）可能導致落點行號或既有邏輯不符 → Mitigation：開工前（TS1 開始前）確認 1.6.1 → 1.7.0 差異是否影響本次 patch 落點；若有落差，以本 repo 實際程式碼為準調整落點。
- [Trade-off] TTL 停用（`ttl <= 0`）而非調長：放棄「短期 TTL 仍可自動清理長期不用的 entry」的效果，換取 resume 穩定性；因 `getOrCreate` 驗活自癒已能處理 stale session，TTL 對 resume 場景是純害處。

## Migration Plan

- 純新增/修正行為，無需資料遷移；`sessionMapFile` 未設定時完全維持現行 in-memory 行為（無 breaking change）。
- 部署後首次啟動：若指定 `sessionMapFile` 但檔案不存在，以空 map 起跑，行為等同純 in-memory 直到有映射寫入。
- Rollback：移除 `--session-map-file` CLI 參數或 config 即回退純 in-memory 行為；TTL 若需回退可設回 `> 0` 值。

## Open Questions

- fork 基準版本落差：本 repo `a2a-opencode` package 為 1.6.1（HEAD `6d2d315`），前案調查與 pin 目標為 1.7.0——開工前同步 upstream 至 1.7.0 對應 tag/commit，或確認 1.6.1→1.7.0 差異不影響 patch 落點。
- `publishTask` 前移至 `getOrCreate` 之後是否影響 A2A 客戶端對「Task 事件先於一切」的預期（`@a2a-js/sdk` 行為）——TS3 實作時實測。
