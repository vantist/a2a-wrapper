/**
 * a2a-codex — Public API
 *
 * Re-exports the executor, config types, and backend constants for
 * programmatic use without importing subdirectory modules directly.
 */

export { CodexExecutor } from "./codex/executor.js";
export { SessionManager } from "./codex/session-manager.js";
export { EventMapper } from "./codex/event-mapper.js";
export { CODEX_BACKEND_PATHS } from "./codex/backend-paths.js";
export { CODEX_CAPABILITIES } from "./codex/capabilities.js";
export { createCodexClient } from "./codex/client-factory.js";
export type {
  CodexClientLike,
  CodexThreadLike,
  ThreadEventLike,
  ThreadItemLike,
} from "./codex/client-factory.js";
export type {
  AgentConfig,
  CodexConfig,
  FeatureFlags,
  McpStdioServerConfig,
  McpHttpServerConfig,
  McpServerConfig,
} from "./config/types.js";
export { DEFAULTS } from "./config/defaults.js";
export { resolveConfig, loadConfigFile, loadEnvOverrides } from "./config/loader.js";
export { createA2AServer } from "./server/index.js";
export type { ServerHandle } from "./server/index.js";
