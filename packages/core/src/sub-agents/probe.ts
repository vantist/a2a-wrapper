/**
 * Sub-Agents Reachability Probe
 *
 * Performs a single startup HTTP GET against each configured sub-agent's
 * effective URL ({@link SubAgentConfig.endpointUrlOverride} when set,
 * otherwise {@link SubAgentConfig.agentCardUrl}) so that the parent can
 * surface obvious misconfiguration — unreachable host, wrong protocol,
 * 4xx/5xx responses, expired credentials — before the bridge child
 * process is spawned.
 *
 * Probes are best-effort by design: a failure of any subset never
 * aborts startup. The caller (typically `bootstrapSubAgents`) logs
 * each {@link ProbeResult} at info or warning level and continues
 * regardless. {@link probeSubAgents} therefore never throws — every
 * failure mode (network error, timeout, unreachable host) is captured
 * as a structured `ProbeResult` with `ok: false`.
 *
 * Implementation notes:
 *
 * - Uses Node 18+'s built-in global `fetch`. No third-party HTTP
 *   client is required.
 * - Each request is wired to an {@link AbortController} that fires
 *   after `timeoutMs`; the caught `AbortError` is normalized to a
 *   stable `"Probe timed out after Nms"` message so log output is
 *   not platform-dependent.
 * - All probes run concurrently via `Promise.allSettled`; result
 *   ordering matches the input order so callers can zip the two
 *   arrays without bookkeeping.
 * - Auth headers from the validated config are sent with the probe
 *   so credential issues (e.g. an expired bearer token) surface here
 *   too, not just at first tool call.
 *
 * @module sub-agents/probe
 */

import type { SubAgentAuthConfig, SubAgentConfig } from "./types.js";

// ─── Public Types ───────────────────────────────────────────────────────────

/**
 * The outcome of probing a single sub-agent.
 *
 * Exactly one entry is produced per input agent regardless of whether
 * the request succeeded, failed at the network layer, or timed out.
 * Callers map this to a log line and decide whether the parent should
 * proceed (always: yes, see Requirement 6.5 in the spec).
 */
export interface ProbeResult {
  /** Mirrors {@link SubAgentConfig.name} of the probed agent. */
  name: string;

  /**
   * The URL that was actually probed. Equal to
   * `endpointUrlOverride ?? agentCardUrl` for the agent.
   */
  url: string;

  /**
   * `true` when the request completed with a 2xx status code.
   * `false` for 1xx/3xx/4xx/5xx responses, network errors, and
   * timeouts.
   */
  ok: boolean;

  /**
   * The HTTP status code returned by the server. Present when the
   * response head was received (success and non-2xx alike); absent
   * when the request never produced a response (network error,
   * timeout, DNS failure).
   */
  status?: number;

  /**
   * Human-readable diagnostic when `ok` is `false`. For non-2xx
   * responses this is the status line (e.g. `"HTTP 404 Not Found"`).
   * For network-level failures this is the underlying error message,
   * normalized for timeouts to `"Probe timed out after Nms"`.
   */
  error?: string;

  /**
   * Wall-clock duration of the probe in milliseconds, measured with
   * the high-resolution timer. Useful for surfacing slow-but-reachable
   * sub-agents and for asserting parallelism in tests.
   */
  durationMs: number;
}

// ─── Internal Constants ─────────────────────────────────────────────────────

/**
 * Default timeout applied when a non-positive or non-finite value is
 * supplied. Matches the documented default in
 * {@link SubAgentsOptions.probeTimeoutMs}.
 */
const DEFAULT_PROBE_TIMEOUT_MS = 5000;

/**
 * Header name used when the operator sets `auth.mode: "api_key"` but
 * does not supply a custom `headerName`. Matches the convention used
 * by `a2a-mcp-skillmap` so the probe presents the same credential
 * shape skillmap will use at runtime.
 */
const DEFAULT_API_KEY_HEADER_NAME = "X-API-Key";

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Probe every sub-agent in `agents` in parallel, returning one
 * {@link ProbeResult} per input entry in the same order.
 *
 * The function is total: it never throws and never rejects. Every
 * input agent receives a result describing what happened, even if
 * `fetch` itself was unable to construct a request (e.g. due to a
 * malformed URL — though that case should already have been caught
 * by `validateSubAgents` upstream).
 *
 * @param agents - Validated sub-agent configs. The caller is
 *   responsible for having run `validateSubAgents` first; this
 *   function does not re-validate URLs.
 * @param timeoutMs - Per-request abort timeout in milliseconds.
 *   Non-positive or non-finite values fall back to 5000 to keep the
 *   probe step from hanging indefinitely on a misconfigured caller.
 * @returns A promise that resolves to an array of probe results in
 *   the same order as `agents`.
 */
export async function probeSubAgents(
  agents: SubAgentConfig[],
  timeoutMs: number,
): Promise<ProbeResult[]> {
  const effectiveTimeout =
    Number.isFinite(timeoutMs) && timeoutMs > 0
      ? timeoutMs
      : DEFAULT_PROBE_TIMEOUT_MS;

  // Promise.allSettled is belt-and-braces: probeOne already catches
  // every error we know of and resolves with a ProbeResult, but using
  // allSettled guarantees that even an unexpected synchronous throw
  // (or a future refactor that loses the try/catch) cannot reject the
  // outer promise. The .map(...) below converts any "rejected" entry
  // back into a ProbeResult so the return shape stays total.
  const settled = await Promise.allSettled(
    agents.map((agent) => probeOne(agent, effectiveTimeout)),
  );

  return settled.map((outcome, idx) => {
    if (outcome.status === "fulfilled") {
      return outcome.value;
    }
    // Defensive: probeOne is designed to never throw, but if the
    // contract ever breaks we still produce a well-formed result so
    // the caller can keep going. We do not have a duration here, so
    // report 0.
    const agent = agents[idx];
    return {
      name: agent.name,
      url: resolveProbeUrl(agent),
      ok: false,
      error: stringifyError(outcome.reason),
      durationMs: 0,
    };
  });
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Probe a single sub-agent. Always resolves; never rejects. Captures
 * status, error, and duration into a {@link ProbeResult}.
 */
async function probeOne(
  agent: SubAgentConfig,
  timeoutMs: number,
): Promise<ProbeResult> {
  const url = resolveProbeUrl(agent);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  const start = performance.now();

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: buildProbeHeaders(agent.auth),
      signal: controller.signal,
      // Prevent Node from following redirects silently — if the
      // operator's URL 30x's somewhere unexpected, we want to surface
      // it as a non-2xx outcome rather than silently chase it.
      redirect: "manual",
    });
    const durationMs = Math.round(performance.now() - start);

    if (response.ok) {
      return { name: agent.name, url, ok: true, status: response.status, durationMs };
    }

    return {
      name: agent.name,
      url,
      ok: false,
      status: response.status,
      error: `HTTP ${response.status}${response.statusText ? ` ${response.statusText}` : ""}`,
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Math.round(performance.now() - start);
    return {
      name: agent.name,
      url,
      ok: false,
      error: normalizeProbeError(err, timeoutMs),
      durationMs,
    };
  } finally {
    // Always release the timer so the event loop can exit cleanly when
    // the response races the timeout.
    clearTimeout(timer);
  }
}

/**
 * The URL skillmap will use for this agent and that the probe should
 * therefore exercise: `endpointUrlOverride` when set (and non-empty),
 * else `agentCardUrl`.
 */
function resolveProbeUrl(agent: SubAgentConfig): string {
  if (
    typeof agent.endpointUrlOverride === "string" &&
    agent.endpointUrlOverride.length > 0
  ) {
    return agent.endpointUrlOverride;
  }
  return agent.agentCardUrl;
}

/**
 * Build the request headers presented to the sub-agent during probing.
 * Always sends `Accept: application/json` so the response is shaped
 * for an agent card or JSON-RPC endpoint; layers any auth headers on
 * top when the validated config carries credentials.
 */
function buildProbeHeaders(
  auth: SubAgentAuthConfig | undefined,
): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };

  if (auth === undefined || auth.mode === "none") {
    return headers;
  }

  if (auth.mode === "bearer") {
    headers["Authorization"] = `Bearer ${auth.token}`;
    return headers;
  }

  // mode === "api_key"
  const headerName =
    typeof auth.headerName === "string" && auth.headerName.length > 0
      ? auth.headerName
      : DEFAULT_API_KEY_HEADER_NAME;
  headers[headerName] = auth.token;
  return headers;
}

/**
 * Convert an arbitrary thrown value into a stable diagnostic string.
 * Specifically rewrites `AbortError` (the value `fetch` throws when
 * the controller fires) to a self-describing timeout message so log
 * output does not depend on undici's wording.
 */
function normalizeProbeError(err: unknown, timeoutMs: number): string {
  if (isAbortError(err)) {
    return `Probe timed out after ${timeoutMs}ms`;
  }
  return stringifyError(err);
}

/**
 * Detect the `AbortError` thrown by `fetch` when the request's
 * `AbortSignal` fires. Both DOMException-shaped and Error-shaped
 * variants are handled because Node's undici has used both at
 * various points.
 */
function isAbortError(err: unknown): boolean {
  if (err === null || typeof err !== "object") {
    return false;
  }
  const candidate = err as { name?: unknown; code?: unknown };
  if (typeof candidate.name === "string" && candidate.name === "AbortError") {
    return true;
  }
  if (typeof candidate.code === "string" && candidate.code === "ABORT_ERR") {
    return true;
  }
  return false;
}

/**
 * Best-effort coercion of an unknown thrown value to a non-empty
 * string. Falls through to `String(err)` for primitives and to a
 * fixed sentinel for the `null`/`undefined` cases so callers always
 * have something to log.
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
