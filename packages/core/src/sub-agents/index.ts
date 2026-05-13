/**
 * Sub-Agents Module
 *
 * Barrel exports for the A2A sub-agents feature. Provides types,
 * constants, validation, bridge config generation, reachability
 * probing, MCP descriptor synthesis, and the bootstrap orchestrator.
 *
 * @module sub-agents
 */

// ─── Types ──────────────────────────────────────────────────────────────────

export type {
  SubAgentConfig,
  SubAgentAuthConfig,
  SubAgentsOptions,
  SubAgentsConfig,
  SynthesizedMcpDescriptor,
} from "./types.js";

export type {
  ValidationOutcome,
  SubAgentValidationReason,
  SubAgentValidationErrorDetails,
} from "./validate.js";

export type {
  BridgeConfigSource,
  BridgeConfigAgentEntry,
  BridgeConfig,
} from "./bridge-config.js";

export type { ProbeResult } from "./probe.js";

export type { BootstrapInput, BootstrapResult } from "./bootstrap.js";

// ─── Constants ──────────────────────────────────────────────────────────────

export { SUBAGENTS_MCP_KEY } from "./types.js";
export { SKILLMAP_PACKAGE_VERSION } from "./version.js";

// ─── Functions ──────────────────────────────────────────────────────────────

export { validateSubAgents, SubAgentValidationError } from "./validate.js";
export {
  buildBridgeConfig,
  resolveBridgeConfigPath,
  writeBridgeConfig,
} from "./bridge-config.js";
export { probeSubAgents } from "./probe.js";
export { buildSynthesizedMcpEntry } from "./synthesize.js";
export { bootstrapSubAgents } from "./bootstrap.js";
