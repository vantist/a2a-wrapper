/**
 * Sub-Agents Bootstrap Orchestrator
 *
 * Single entry point a wrapper calls during executor initialization to wire
 * up the sub-agents bridge. Coordinates the full sequence:
 *
 *   1. {@link validateSubAgents} — fail-fast checks against the operator's
 *      `subAgents.agents` array and the parent's existing `mcp` map.
 *   2. {@link buildBridgeConfig} + {@link writeBridgeConfig} — produce and
 *      persist the JSON document the `a2a-mcp-skillmap` child process
 *      consumes.
 *   3. {@link probeSubAgents} — parallel reachability probes against each
 *      sub-agent's effective URL, surfaced via structured log lines.
 *   4. {@link buildSynthesizedMcpEntry} — canonical, wrapper-agnostic
 *      `{ command, args }` descriptor each wrapper translates into its
 *      own MCP entry shape.
 *
 * The function is wrapper-agnostic: it knows nothing about copilot's
 * `McpStdioServerConfig` or opencode's `McpLocalServerConfig`. The
 * caller (an executor) merges the returned descriptor into its resolved
 * `mcp` map under `descriptor.key` after running it through a wrapper
 * adapter.
 *
 * Failure semantics follow the spec's "fail-fast on config errors,
 * warn-and-continue on runtime errors" decision:
 *
 *   - Validation errors and bridge-config write errors throw, aborting
 *     parent startup. The write failure is logged at `error` level with
 *     the absolute target path before the throw so operators see exactly
 *     where the parent gave up.
 *   - Probe failures are logged as warnings. They never abort, and the
 *     synthesized MCP entry is returned regardless so the bridge has a
 *     chance to serve tools as sub-agents come back online (Requirement
 *     7.4).
 *
 * @module sub-agents/bootstrap
 */

import { createLogger, type Logger } from "../utils/logger.js";

import {
  buildBridgeConfig,
  resolveBridgeConfigPath,
  writeBridgeConfig,
} from "./bridge-config.js";
import { probeSubAgents, type ProbeResult } from "./probe.js";
import { buildSynthesizedMcpEntry } from "./synthesize.js";
import type {
  SubAgentConfig,
  SubAgentsConfig,
  SubAgentsOptions,
  SynthesizedMcpDescriptor,
} from "./types.js";
import { validateSubAgents } from "./validate.js";

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * Inputs to {@link bootstrapSubAgents}. Wrappers assemble this object
 * from their resolved `AgentConfig` before invoking the orchestrator.
 */
export interface BootstrapInput {
  /**
   * The `subAgents` section from the parent's resolved config. The
   * caller is expected to have already verified that
   * `subAgents.agents.length > 0` — bootstrapping with an empty list
   * is supported but pointless and produces a no-op summary log.
   */
  subAgents: SubAgentsConfig;

  /**
   * The parent's workspace directory, used to resolve where the
   * bridge config will be written. When `undefined` (or empty), a
   * `os.tmpdir()` fallback is used. See
   * {@link resolveBridgeConfigPath}.
   */
  workspaceDir: string | undefined;

  /**
   * The parent's `logging.level` (as configured in the parent's
   * `AgentConfig`). Propagated verbatim into the bridge config's
   * `logging.level` so skillmap respects the same verbosity.
   */
  parentLogLevel: string;

  /**
   * Currently-defined keys in the parent's resolved `mcp` map. Used
   * by {@link validateSubAgents} to detect collisions with the
   * reserved sub-agents key. The set is treated as read-only;
   * bootstrap never mutates it.
   */
  existingMcpKeys: ReadonlySet<string>;
}

/**
 * Outputs from {@link bootstrapSubAgents}. The caller merges
 * `descriptor` into its `mcp` map (after running it through a
 * wrapper-specific adapter) and may surface `probeResults` via
 * additional reporting if desired.
 */
export interface BootstrapResult {
  /**
   * The canonical MCP descriptor for the synthesized sub-agents
   * bridge entry. Wrapper-agnostic by design — translate via the
   * wrapper's `toXxxMcpEntry` adapter before merging.
   */
  descriptor: SynthesizedMcpDescriptor;

  /** Absolute filesystem path the bridge config was written to. */
  bridgeConfigPath: string;

  /**
   * One probe outcome per sub-agent in input order. Always populated
   * (even when every probe failed) so callers can produce
   * deterministic diagnostic output.
   */
  probeResults: ProbeResult[];
}

// ─── Internal Constants ─────────────────────────────────────────────────────

/**
 * Default skillmap response shaping mode used when
 * `subAgents.options.responseMode` is unset. Mirrors the documented
 * default on {@link SubAgentsOptions.responseMode}.
 */
const DEFAULT_RESPONSE_MODE: NonNullable<SubAgentsOptions["responseMode"]> =
  "artifact";

/**
 * Default probe timeout in milliseconds applied when
 * `subAgents.options.probeTimeoutMs` is unset, zero, or non-finite.
 * Mirrors the documented default on
 * {@link SubAgentsOptions.probeTimeoutMs}.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Sentinel value meaning "let skillmap use its own default sync budget".
 * When `subAgents.options.syncBudgetMs` is unset we pass `undefined`
 * to `buildBridgeConfig` so the key is omitted from the bridge config
 * entirely, letting skillmap's own default (30 000 ms) apply.
 */
const SYNC_BUDGET_UNSET = undefined;

/**
 * Root logger name for sub-agent bootstrap output. A child of
 * `createLogger("subagents")`, which keeps these lines distinct from
 * the rest of the parent's logging hierarchy and makes them easy to
 * grep.
 */
const LOGGER_NAME = "subagents";

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Run the full sub-agents bootstrap sequence and return the descriptor
 * the caller will merge into its `mcp` map.
 *
 * Side effects:
 *
 * - Writes the bridge config to disk (under the workspace, or the
 *   tmpdir fallback). The file is created with mode `0600` so any
 *   inlined credentials are not world-readable.
 * - Logs a startup summary line, per-sub-agent registration entries,
 *   and warnings for any validation soft-failures or probe failures.
 *   Auth tokens are never logged — URLs are redacted of any
 *   `userinfo` component before they reach the log line.
 *
 * Failure modes:
 *
 * - Throws {@link SubAgentValidationError} from
 *   {@link validateSubAgents} on any fail-fast config issue
 *   (missing/invalid name, invalid URL, reserved-key collision).
 * - Throws the underlying filesystem error if writing the bridge
 *   config fails. The error is logged at `error` level with the
 *   absolute target path before being re-thrown so operators see the
 *   path even if the throw is swallowed upstream (Requirement 11.4).
 * - Probe failures never throw. Each is logged as a warning and
 *   reported in the returned `probeResults`. The synthesized MCP
 *   entry is returned even when every probe failed, so the bridge
 *   has a chance to serve tools as sub-agents come back online
 *   (Requirement 7.4).
 */
export async function bootstrapSubAgents(
  input: BootstrapInput,
): Promise<BootstrapResult> {
  const logger = createLogger(LOGGER_NAME);

  // 1. Validate the operator's config. Throws on every fail-fast case;
  //    soft warnings (missing env vars, empty resolved tokens) are
  //    surfaced via the structured warnings list and logged below.
  const validation = validateSubAgents(
    input.subAgents.agents,
    input.existingMcpKeys,
  );

  for (const warning of validation.warnings) {
    logger.warn(warning);
  }

  // Resolve effective options once so downstream steps share a single
  // view of the defaults. Direct property access (rather than a
  // spread) keeps unset keys out of the resulting object so snapshot
  // tests downstream stay deterministic.
  const optionsIn = input.subAgents.options ?? {};
  const responseMode = optionsIn.responseMode ?? DEFAULT_RESPONSE_MODE;
  const probeTimeoutMs =
    typeof optionsIn.probeTimeoutMs === "number" &&
    Number.isFinite(optionsIn.probeTimeoutMs) &&
    optionsIn.probeTimeoutMs > 0
      ? optionsIn.probeTimeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS;

  // syncBudgetMs: pass through when explicitly set (including 0 to
  // disable the budget); omit when unset so skillmap uses its default.
  const syncBudgetMs =
    typeof optionsIn.syncBudgetMs === "number" &&
    Number.isFinite(optionsIn.syncBudgetMs) &&
    optionsIn.syncBudgetMs >= 0
      ? optionsIn.syncBudgetMs
      : SYNC_BUDGET_UNSET;

  // 2. Build the bridge config document and the absolute path it will
  //    be written to. The path is computed first so write failures
  //    can be logged with full context.
  const bridgeConfig = buildBridgeConfig({
    agents: validation.agents,
    options: { responseMode, probeTimeoutMs, syncBudgetMs },
    parentLogLevel: input.parentLogLevel,
  });
  const bridgeConfigPath = resolveBridgeConfigPath(input.workspaceDir);

  // 3. Persist the bridge config. Failures here are unrecoverable —
  //    skillmap cannot start without it — so we log at error level
  //    (per Requirement 11.4) and re-throw to abort startup.
  let absoluteBridgeConfigPath: string;
  try {
    absoluteBridgeConfigPath = await writeBridgeConfig(
      bridgeConfig,
      bridgeConfigPath,
    );
  } catch (err: unknown) {
    logger.error("Failed to write sub-agents bridge config", {
      path: bridgeConfigPath,
      error: stringifyError(err),
    });
    throw err;
  }

  // 4. Emit the startup summary line. This goes out before probes so
  //    operators tailing the log see the registration intent even if
  //    the parent is killed mid-probe.
  logger.info(
    `Registered ${validation.agents.length} sub-agent${
      validation.agents.length === 1 ? "" : "s"
    }`,
    {
      count: validation.agents.length,
      names: validation.agents.map((a) => a.name),
      bridgeConfigPath: absoluteBridgeConfigPath,
    },
  );

  // 5. Probe each sub-agent in parallel. probeSubAgents never throws
  //    and never rejects, so we don't wrap it in try/catch — every
  //    failure surfaces as a structured `ProbeResult` with `ok: false`.
  const probeResults = await probeSubAgents(validation.agents, probeTimeoutMs);

  // 6. Log per-sub-agent registration entries. URLs are redacted of
  //    any `userinfo` component before logging so credentials embedded
  //    in URLs (rare, but possible) are not leaked.
  logProbeOutcomes(logger, validation.agents, probeResults);

  // 7. Build the canonical MCP descriptor. This always succeeds for
  //    well-formed inputs (writeBridgeConfig returns an absolute path).
  //    Returning the descriptor regardless of probe results satisfies
  //    Requirement 7.4: even if every sub-agent is currently down,
  //    the bridge entry is still registered so tools appear when the
  //    sub-agents come back online.
  const descriptor = buildSynthesizedMcpEntry(absoluteBridgeConfigPath);

  return {
    descriptor,
    bridgeConfigPath: absoluteBridgeConfigPath,
    probeResults,
  };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Emit one log line per probe outcome.
 *
 * Successful probes (2xx) are logged at info level; everything else
 * (non-2xx, network error, timeout) is logged at warn level so
 * operators can spot misconfiguration at a glance. The URL on every
 * line is redacted of any `userinfo` portion to avoid leaking
 * credentials embedded in URL syntax (`https://user:pass@host/...`).
 *
 * Auth tokens themselves are never logged — they live in the
 * validated `auth` block, which we deliberately do not include in any
 * structured log payload. This satisfies Requirement 11.3.
 */
function logProbeOutcomes(
  logger: Logger,
  agents: SubAgentConfig[],
  probeResults: ProbeResult[],
): void {
  for (let i = 0; i < probeResults.length; i++) {
    const result = probeResults[i];
    const agent = agents[i];
    const safeUrl = redactUrl(result.url);

    if (result.ok) {
      logger.info(`Sub-agent "${agent.name}" reachable`, {
        name: agent.name,
        url: safeUrl,
        status: result.status,
        durationMs: result.durationMs,
      });
      continue;
    }

    // Failures: include status when known, error message otherwise.
    // Both fields together produce a self-explanatory log line for
    // operators (e.g. status 404 with "HTTP 404 Not Found", or no
    // status with "Probe timed out after 5000ms").
    const data: Record<string, unknown> = {
      name: agent.name,
      url: safeUrl,
      durationMs: result.durationMs,
    };
    if (typeof result.status === "number") {
      data.status = result.status;
    }
    if (typeof result.error === "string" && result.error.length > 0) {
      data.error = result.error;
    }
    logger.warn(`Sub-agent "${agent.name}" probe failed`, data);
  }
}

/**
 * Strip any `userinfo` component (`https://user:password@host/path`)
 * from a URL before logging it. The rest of the URL is preserved
 * verbatim so operators can still correlate the log line with their
 * config.
 *
 * If the input is not a parseable URL (which validation should have
 * already prevented), it is returned unchanged — there is nothing
 * useful we could do, and dropping the URL outright would degrade the
 * log line more than the unparseable fragment does.
 */
function redactUrl(rawUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return rawUrl;
  }
  if (parsed.username.length === 0 && parsed.password.length === 0) {
    return rawUrl;
  }
  parsed.username = "";
  parsed.password = "";
  return parsed.toString();
}

/**
 * Best-effort coercion of an unknown thrown value to a non-empty
 * string for logging. Mirrors the helper in `probe.ts` but is
 * duplicated here to keep both modules' helpers internal — this
 * helper is small and the ~10 lines of duplication is preferable to
 * widening either module's public surface.
 */
function stringifyError(err: unknown): string {
  if (err instanceof Error) {
    return err.message.length > 0 ? err.message : err.name;
  }
  if (err === null || err === undefined) {
    return "Unknown error";
  }
  return String(err);
}
