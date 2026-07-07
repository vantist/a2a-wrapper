## 1. Config — sessionMapFile 設定欄位
> files: a2a-opencode/src/config/types.ts, a2a-opencode/src/config/defaults.ts
> depends: none

- [x] 1.1 在 `SessionConfig` 介面加入 `sessionMapFile?: string` 欄位 (R1)
  - Acceptance: GIVEN `types.ts` 的 `SessionConfig` WHEN 型別檢查 THEN 可以設定 `session.sessionMapFile` 字串值，且未設定時型別允許 `undefined`
  - Test: `a2a-opencode/src/__tests__/config-schema.test.ts`（驗證欄位存在於 schema）

- [x] 1.2 `DEFAULTS` 中 `session` 區塊不加 `sessionMapFile`，維持預設 `undefined`（即停用）(R1)
  - Acceptance: GIVEN `defaults.ts` 的 `DEFAULTS.session` WHEN 直接存取 THEN `sessionMapFile` 為 `undefined`，不存在於 frozen 物件中
  - Test: `a2a-opencode/src/__tests__/config-schema.test.ts`（確認 defaults 不含此欄位）

## 2. CLI — --session-map-file 旗標
> files: a2a-opencode/src/cli.ts
> depends: 1

- [x] 2.1 在 `parseArgs` options 加入 `"session-map-file": { type: "string" }` (R1)
  - Acceptance: GIVEN CLI 以 `--session-map-file /tmp/session-map.json` 啟動 WHEN `parseCliArgs` 執行 THEN `values["session-map-file"]` 為該字串值
  - Test: 手動驗證（unit test for cli parsing is not in scope; covered by TS4 manual check）

- [x] 2.2 在 `parseCliArgs` 將 `--session-map-file` 對應到 `overrides.session.sessionMapFile` (R1)
  - Acceptance: GIVEN `--session-map-file /tmp/map.json` 傳入 WHEN `parseCliArgs` 回傳 THEN `overrides.session.sessionMapFile === "/tmp/map.json"`
  - Test: 同 2.1

- [x] 2.3 在 `printUsage()` 說明文字加入 `--session-map-file <path>` 選項說明 (R1)
  - Acceptance: GIVEN `--help` 執行 THEN 輸出包含 `--session-map-file <path>` 一行
  - Test: 手動驗證

## 3. SessionManager — 映射持久化（P1）
> files: a2a-opencode/src/opencode/session-manager.ts, a2a-opencode/src/__tests__/session-manager.test.ts
> depends: 1

- [x] 3.1 建構子加入 `sessionMapFile` 讀取：啟動時從檔案還原 `contextMap`（不存在 = 空 map；解析失敗 = log error + 空 map） (R1)
  - Acceptance: GIVEN `sessionMapFile` 指向有效 JSON 檔（`{"conv-123": {"sessionId":"ses_abc","lastUsed":1750000000000}}`）且 `SessionManager` 建構 THEN `contextMap.get("conv-123")?.sessionId === "ses_abc"`
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「loads existing map on construction」

- [x] 3.2 建構子：若 `sessionMapFile` 未設定，保持純 in-memory 行為（不讀寫任何檔案） (R1)
  - Acceptance: GIVEN `sessionMapFile` 為 `undefined` WHEN 建構及所有操作 THEN 不呼叫任何 fs API
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「no sessionMapFile — no fs calls」

- [x] 3.3 建構子：parse 失敗時 log error + 空 map 起跑，不 throw (R1)
  - Acceptance: GIVEN `sessionMapFile` 指向無效 JSON WHEN 建構 THEN `log.error` 呼叫一次，`contextMap` 為空，建構完成不 throw
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「corrupt map file — logs error and starts empty」

- [x] 3.4 加入私有 `persistMap(): void` 方法：以整檔覆寫方式同步寫入 `sessionMapFile`；寫失敗僅 log error，不 throw (R1, R2)
  - Acceptance: GIVEN `sessionMapFile` 設定且 `contextMap` 有 2 個 entries WHEN `persistMap()` THEN 檔案內容為 `{"<ctx1>":{"sessionId":"...","lastUsed":<n>},"<ctx2>":{"sessionId":"...","lastUsed":<n>}}`
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「persistMap writes correct JSON」

- [x] 3.5 `persistMap()` 寫入失敗時 log error + 繼續，不中斷任何呼叫端邏輯 (R2)
  - Acceptance: GIVEN 檔案不可寫（mock `fs.writeFileSync` throw EACCES）WHEN `persistMap()` THEN `log.error` 呼叫，方法回傳（不 throw），現有 in-memory map 不受影響
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「persistMap write failure logs error」

- [x] 3.6 `getOrCreate` set entry 後呼叫 `persistMap()`；驗活失敗 delete entry 後呼叫 `persistMap()` (R1)
  - Acceptance: GIVEN `sessionMapFile` 設定 WHEN `getOrCreate` 建立新 session THEN 檔案包含新 entry；WHEN 驗活失敗清 entry THEN 檔案不含該 entry
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「persists on getOrCreate set」、「persists on stale entry removal」

- [x] 3.7 TTL cleanup 刪 entry 後呼叫 `persistMap()`（持久化同步移除） (R3)
  - Acceptance: GIVEN `sessionMapFile` 設定、`ttl > 0`、某 entry `lastUsed` 已超 TTL WHEN cleanup timer 觸發 THEN 該 entry 從檔案移除
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「cleanup syncs removal to file」

## 4. SessionManager — TTL 停用（P1 TTL 修正）
> files: a2a-opencode/src/opencode/session-manager.ts, a2a-opencode/src/__tests__/session-manager.test.ts
> depends: none

- [x] 4.1 修正 `startCleanup` 的 TTL 清理條件：`ttl <= 0` 時 skip（不刪任何 entry） (R3)
  - Acceptance: GIVEN `session.ttl = 0` WHEN cleanup timer 觸發（模擬 `Date.now()` 足夠大） THEN `contextMap` 不清任何 entry
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「ttl=0 disables cleanup」

- [x] 4.2 TTL > 0 時清理行為不變：`now - entry.lastUsed > ttl` 則刪 entry (R3)
  - Acceptance: GIVEN `session.ttl = 1000`、entry `lastUsed` 為 `now - 2000` WHEN cleanup timer 觸發 THEN 該 entry 被清除，log 包含 `count: 1`
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「ttl>0 cleanup works as before」

## 5. SessionManager — sessionExists（P2 前置）
> files: a2a-opencode/src/opencode/session-manager.ts, a2a-opencode/src/__tests__/session-manager.test.ts
> depends: 3

- [x] 5.1 加入 `async sessionExists(contextId: string): Promise<boolean>` 方法 (R4)
  - Acceptance: GIVEN `reuseByContext: false` WHEN `sessionExists(any)` THEN 回傳 `false`（不建 session）
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「sessionExists returns false when reuseByContext off」

- [x] 5.2 `sessionExists`：mapping 存在且 `sessionGet` 成功 → `true` (R4)
  - Acceptance: GIVEN mapping `conv-123 → ses_abc` 存在且 `client.sessionGet("ses_abc")` resolve WHEN `sessionExists("conv-123")` THEN `true`
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「sessionExists true when alive」

- [x] 5.3 `sessionExists`：mapping 存在但 `sessionGet` 失敗 → 清 entry（含 `persistMap()`）→ `false` (R4)
  - Acceptance: GIVEN mapping `conv-123 → ses_abc` 存在且 `client.sessionGet` throw WHEN `sessionExists("conv-123")` THEN entry 從 `contextMap` 刪除、`persistMap()` 呼叫、回傳 `false`
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「sessionExists clears stale and returns false」

- [x] 5.4 `sessionExists`：無 mapping → `false`（不建 session、不呼叫 `sessionGet`） (R4)
  - Acceptance: GIVEN 無 `conv-999` mapping WHEN `sessionExists("conv-999")` THEN 回傳 `false`，`client.sessionGet` 不呼叫
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「sessionExists false when no mapping」

## 6. Server — GET /session-status 端點（P2）
> files: a2a-opencode/src/server/index.ts, a2a-opencode/src/__tests__/session-status.test.ts
> depends: 5

- [x] 6.1 在 `createA2AServer` 加入 `GET /session-status` route，`sessionManager` 透過 `executor` 存取 (R4)
  - Acceptance: GIVEN server 啟動且 executor 已 initialize WHEN `GET /session-status?contextId=conv-123` 且 `sessionExists("conv-123")` 回 `true` THEN response `200 {"exists":true}`
  - Test: `a2a-opencode/src/__tests__/session-status.test.ts`「GET /session-status returns exists:true」

- [x] 6.2 `sessionExists` 回 `false` → `200 {"exists":false}` (R4)
  - Acceptance: GIVEN `sessionExists("conv-456")` 回 `false` WHEN `GET /session-status?contextId=conv-456` THEN `200 {"exists":false}`
  - Test: `a2a-opencode/src/__tests__/session-status.test.ts`「GET /session-status returns exists:false」

- [x] 6.3 缺 `contextId` 參數 → `400` (R4)
  - Acceptance: GIVEN `GET /session-status`（無 query param）THEN response `400`
  - Test: `a2a-opencode/src/__tests__/session-status.test.ts`「GET /session-status 400 when contextId missing」

- [x] 6.4 `executor` 暴露 `sessionExists(contextId)` public method，供 `server/index.ts` 呼叫（若 `sessionManager` 目前為 private） (R4)
  - Acceptance: GIVEN `executor.sessionExists("conv-123")` WHEN `sessionManager` 已 init THEN delegate 至 `sessionManager.sessionExists("conv-123")`
  - Test: 單元測試或 6.1/6.2 覆蓋

## 7. SessionManager + Executor — getOrCreate 回傳 created flag（P3）
> files: a2a-opencode/src/opencode/session-manager.ts, a2a-opencode/src/opencode/executor.ts, a2a-opencode/src/__tests__/session-manager.test.ts
> depends: 3

- [x] 7.1 `getOrCreate` 回傳型別改為 `{ sessionId: string; created: boolean }` (R5)
  - Acceptance: GIVEN 新 session 建立（無 mapping 或驗活失敗）WHEN `getOrCreate` THEN `created === true`；既有 session 續用 THEN `created === false`
  - Test: `a2a-opencode/src/__tests__/session-manager.test.ts`「getOrCreate created=true on new session」、「getOrCreate created=false on reuse」

- [x] 7.2 `executor.ts` 中接收 `{ sessionId, created }` 解構 (R5)
  - Acceptance: GIVEN `getOrCreate` 新回傳物件 WHEN `executor` 中的呼叫點（原 `const sessionId = await ...`）THEN 解構為 `const { sessionId, created } = await ...`，後續 `sessionId` 用法不變
  - Test: TypeScript 型別檢查通過

## 8. event-publisher + Executor — publishTask metadata（P3）
> files: a2a-opencode/src/opencode/event-publisher.ts, a2a-opencode/src/opencode/executor.ts, a2a-opencode/src/__tests__/session-manager.test.ts
> depends: 7

- [x] 8.1 `publishTask` 簽章加入 optional `metadata?: Record<string, unknown>` 參數，合入 Task event 物件 (R5)
  - Acceptance: GIVEN `publishTask(bus, taskId, contextId, { sessionCreated: true })` WHEN Task event 發佈 THEN `event.metadata.sessionCreated === true`；不傳 metadata 時 Task event 不含 `metadata` 欄位
  - Test: `a2a-opencode/src/__tests__/event-publisher.test.ts`（新增）

- [x] 8.2 調整 `executor.ts` 中 `publishTask` 與 `getOrCreate` 呼叫順序：先 `getOrCreate`（取得 `created`），再 `publishTask` 帶 `metadata: { sessionCreated: created }` (R5)
  - Acceptance: GIVEN `getOrCreate` 回 `created: true` WHEN 初始 Task 事件發佈 THEN Task event `metadata.sessionCreated === true`；`created: false` 時不帶 metadata（或 `sessionCreated: false`）
  - Test: `a2a-opencode/src/__tests__/session-status.test.ts` 或新增整合測試觀察 SSE stream 中 Task event 的 metadata

- [x] 8.3 確認前移 `publishTask` 至 `getOrCreate` 之後不破壞 `@a2a-js/sdk` ResultManager 預期（Task event 需先於 status-update/artifact-update） (R5)
  - Acceptance: GIVEN `publishTask` 在 `publishStatus("submitted")` 之前 THEN `publishTask` 仍是第一個發佈的事件（現有 `smoke.test.ts` 觀察 SSE stream 事件順序通過）
  - Test: `a2a-opencode/src/__tests__/smoke.test.ts`（現有，確保不迴歸）

## 9. 端對端手動驗證清單（TS4）
> files: a2a-opencode/src/__tests__/MANUAL_E2E_CHECKLIST.md（新增）
> depends: 3, 4, 5, 6, 7, 8

- [x] 9.1 建立手動驗證清單文件，涵蓋：重啟還原、TTL 停用放置 >1hr、`curl` 探測端點、SSE 觀察 `sessionCreated` (R1, R3, R4, R5)
  - Acceptance: 文件存在，每項有具體操作步驟與預期觀察值
  - Test: 文件本身即驗證清單，非自動測試
