/**
 * Sub-Agents Config Validation
 *
 * Performs all the fail-fast checks the parent agent runs against the
 * `subAgents.agents` array before any bridge config is generated, any
 * filesystem write is attempted, or any reachability probe is fired.
 *
 * The function is deliberately synchronous and side-effect free except
 * for reading from `process.env` to resolve `${VAR}` references in
 * outbound auth tokens. All hard failures throw a
 * {@link SubAgentValidationError} carrying structured details
 * (offending index, sub-agent name, machine-readable reason). Soft
 * failures (e.g. a referenced env var is unset) produce structured
 * warnings and cause the affected `auth` block to be omitted from the
 * output.
 *
 * @module sub-agents/validate
 */

import {
  SUBAGENTS_MCP_KEY,
  type SubAgentAuthConfig,
  type SubAgentConfig,
} from "./types.js";

// ─── Error Type ─────────────────────────────────────────────────────────────

/**
 * Machine-readable reason codes for each fail-fast case in
 * {@link validateSubAgents}. Useful for tests and for callers that
 * want to map errors to specific user-facing diagnostics without
 * string-matching on the message.
 */
export type SubAgentValidationReason =
  | "missing_name"
  | "invalid_name"
  | "duplicate_name"
  | "missing_agent_card_url"
  | "invalid_agent_card_url"
  | "invalid_endpoint_url_override"
  | "reserved_mcp_key_collision";

/**
 * Structured details attached to every {@link SubAgentValidationError}.
 *
 * Both `index` and `subAgentName` are optional because some failures
 * are not associated with a single entry (e.g. a reserved-key
 * collision applies to the whole `mcp` map).
 */
export interface SubAgentValidationErrorDetails {
  /** Machine-readable reason code for this validation failure. */
  reason: SubAgentValidationReason;
  /** The 0-based index of the offending entry in the `agents` array, when known. */
  index?: number;
  /** The `name` of the offending sub-agent, when known. */
  subAgentName?: string;
}

/**
 * Thrown by {@link validateSubAgents} for every fail-fast case. The
 * `details` field carries the structured context callers (and tests)
 * use to react programmatically.
 *
 * The class name is preserved as `"SubAgentValidationError"` so it
 * survives `JSON.stringify(err)` and shows up correctly in `instanceof`
 * checks across module boundaries.
 */
export class SubAgentValidationError extends Error {
  /** Structured details about the validation failure. */
  readonly details: SubAgentValidationErrorDetails;

  constructor(message: string, details: SubAgentValidationErrorDetails) {
    super(message);
    this.name = "SubAgentValidationError";
    this.details = details;
    // Restore the prototype chain when transpiled targets pre-date
    // proper ES2015 Error subclassing semantics.
    Object.setPrototypeOf(this, SubAgentValidationError.prototype);
  }
}

// ─── Outcome Type ───────────────────────────────────────────────────────────

/**
 * The successful return shape of {@link validateSubAgents}: the
 * env-substituted agent list (with omitted auth blocks where env vars
 * were missing) and any warnings produced during validation.
 */
export interface ValidationOutcome {
  /**
   * The validated agents. Each entry's structure is preserved verbatim
   * from the input except that `auth.token` env-var references are
   * resolved against `process.env`, and `auth` blocks are dropped when
   * a referenced env var is unset or the resolved token is empty.
   */
  agents: SubAgentConfig[];

  /**
   * Human-readable warnings produced during validation. Always present
   * (possibly empty). Callers are expected to surface these via the
   * shared logger.
   */
  warnings: string[];
}

// ─── Internal Constants ─────────────────────────────────────────────────────

/**
 * Permitted shape for a sub-agent `name`: ASCII letters, digits,
 * hyphens, and underscores. Matches the rule documented on
 * {@link SubAgentConfig.name}.
 */
const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Matches `${VAR_NAME}` references in `auth.token`. Variable names
 * follow the conventional shell-style identifier rules: must start
 * with a letter or underscore, followed by letters, digits, or
 * underscores.
 */
const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate a `subAgents.agents` array against the rules documented in
 * the spec. Throws on fail-fast cases; returns the env-substituted
 * agent list and any structured warnings on success.
 *
 * Validation order is deliberate so that error messages always include
 * as much identifying context as possible:
 *
 *   1. Reserved MCP key collision (whole-map check).
 *   2. Per-entry `name` shape (so subsequent errors can name the
 *      offending entry by name rather than only by index).
 *   3. `name` uniqueness across all entries.
 *   4. Per-entry `agentCardUrl`, `endpointUrlOverride`, and `auth`.
 *
 * @param agents - The agents to validate. The caller is responsible
 *   for ensuring this is an array (typically the
 *   `subAgents.agents` field of the resolved config).
 * @param reservedMcpKeys - The set of currently-defined keys in the
 *   parent's resolved `mcp` map. If this set contains
 *   {@link SUBAGENTS_MCP_KEY}, validation throws because the operator
 *   has manually defined an MCP server under the reserved key.
 * @returns The validated, env-substituted agent list and any warnings.
 *
 * @throws {SubAgentValidationError} On any fail-fast condition listed
 *   in the spec's "Error Handling" table.
 */
export function validateSubAgents(
  agents: SubAgentConfig[],
  reservedMcpKeys: ReadonlySet<string>,
): ValidationOutcome {
  // 1. Reserved-key collision: a whole-map check, run first so the
  //    error message is not buried under per-entry diagnostics.
  if (reservedMcpKeys.has(SUBAGENTS_MCP_KEY)) {
    throw new SubAgentValidationError(
      `MCP server key "${SUBAGENTS_MCP_KEY}" is reserved by the sub-agents feature ` +
        `but is already defined in your "mcp" config. Remove or rename that entry — ` +
        `the sub-agents bridge must be registered under "${SUBAGENTS_MCP_KEY}".`,
      { reason: "reserved_mcp_key_collision" },
    );
  }

  const warnings: string[] = [];

  // 2. Validate `name` shape on every entry, collecting duplicates as
  //    we go so we can produce a single error covering all of them.
  const firstSeenAt = new Map<string, number>();
  const duplicateIndexes = new Map<string, number[]>();

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];

    if (
      agent === null ||
      agent === undefined ||
      typeof agent.name !== "string" ||
      agent.name.length === 0
    ) {
      throw new SubAgentValidationError(
        `Sub-agent at index ${i} is missing the required "name" field.`,
        { reason: "missing_name", index: i },
      );
    }

    if (!NAME_PATTERN.test(agent.name)) {
      throw new SubAgentValidationError(
        `Sub-agent at index ${i} has invalid name "${agent.name}" — names must match ` +
          `/^[A-Za-z0-9_-]+$/ (letters, digits, hyphens, and underscores only).`,
        { reason: "invalid_name", index: i, subAgentName: agent.name },
      );
    }

    const previous = firstSeenAt.get(agent.name);
    if (previous !== undefined) {
      const existing = duplicateIndexes.get(agent.name) ?? [previous];
      existing.push(i);
      duplicateIndexes.set(agent.name, existing);
    } else {
      firstSeenAt.set(agent.name, i);
    }
  }

  // 3. Surface duplicate names in a single error. Identifying every
  //    duplicate at once is friendlier than failing on the first
  //    collision and forcing repeated edit-restart cycles.
  if (duplicateIndexes.size > 0) {
    const summary = Array.from(duplicateIndexes.entries())
      .map(([name, indexes]) => `"${name}" (at indexes ${indexes.join(", ")})`)
      .join(", ");
    throw new SubAgentValidationError(
      `Duplicate sub-agent names: ${summary}. Each sub-agent must have a unique "name".`,
      { reason: "duplicate_name" },
    );
  }

  // 4. Validate URLs and resolve auth on every entry.
  const validated: SubAgentConfig[] = [];

  for (let i = 0; i < agents.length; i++) {
    const agent = agents[i];

    // agentCardUrl — required, must be a parseable http(s) URL.
    if (typeof agent.agentCardUrl !== "string" || agent.agentCardUrl.length === 0) {
      throw new SubAgentValidationError(
        `Sub-agent "${agent.name}" (index ${i}) is missing the required "agentCardUrl" field.`,
        {
          reason: "missing_agent_card_url",
          index: i,
          subAgentName: agent.name,
        },
      );
    }
    assertHttpUrl(agent.agentCardUrl, "agentCardUrl", agent.name, i);

    // endpointUrlOverride — optional, but when present must be a
    // parseable http(s) URL.
    if (agent.endpointUrlOverride !== undefined && agent.endpointUrlOverride !== null) {
      if (
        typeof agent.endpointUrlOverride !== "string" ||
        agent.endpointUrlOverride.length === 0
      ) {
        throw new SubAgentValidationError(
          `Sub-agent "${agent.name}" (index ${i}) has an empty "endpointUrlOverride" — ` +
            `either remove the field or set it to a valid http(s) URL.`,
          {
            reason: "invalid_endpoint_url_override",
            index: i,
            subAgentName: agent.name,
          },
        );
      }
      assertHttpUrl(agent.endpointUrlOverride, "endpointUrlOverride", agent.name, i);
    }

    // auth — env-substitute and possibly omit.
    const resolvedAuth = resolveAuth(agent.auth, agent.name, warnings);

    // Reconstruct the validated entry: avoid copying undefined fields
    // through so the output is identical to what skillmap would expect
    // and snapshot tests stay deterministic.
    const validatedAgent: SubAgentConfig = {
      name: agent.name,
      agentCardUrl: agent.agentCardUrl,
    };
    if (agent.endpointUrlOverride !== undefined && agent.endpointUrlOverride !== null) {
      validatedAgent.endpointUrlOverride = agent.endpointUrlOverride;
    }
    if (resolvedAuth !== undefined) {
      validatedAgent.auth = resolvedAuth;
    }
    validated.push(validatedAgent);
  }

  return { agents: validated, warnings };
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

/**
 * Throw a {@link SubAgentValidationError} unless `value` parses as a
 * URL whose protocol is `http:` or `https:`. The `field` argument
 * disambiguates the reason code so callers can tell `agentCardUrl`
 * failures from `endpointUrlOverride` failures.
 */
function assertHttpUrl(
  value: string,
  field: "agentCardUrl" | "endpointUrlOverride",
  subAgentName: string,
  index: number,
): void {
  const reason: SubAgentValidationReason =
    field === "agentCardUrl"
      ? "invalid_agent_card_url"
      : "invalid_endpoint_url_override";

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new SubAgentValidationError(
      `Sub-agent "${subAgentName}" (index ${index}) has invalid "${field}" "${value}" — ` +
        `must be a parseable URL.`,
      { reason, index, subAgentName },
    );
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new SubAgentValidationError(
      `Sub-agent "${subAgentName}" (index ${index}) has invalid "${field}" "${value}" — ` +
        `must use http: or https: protocol (got "${parsed.protocol}").`,
      { reason, index, subAgentName },
    );
  }
}

/**
 * Resolve an `auth` block: substitute `${VAR}` references in the
 * token, drop the block (with a warning) if any referenced env var is
 * unset or if the resolved token is empty, and pass through `mode:
 * "none"` as `undefined`.
 */
function resolveAuth(
  auth: SubAgentAuthConfig | undefined,
  subAgentName: string,
  warnings: string[],
): SubAgentAuthConfig | undefined {
  if (auth === undefined || auth === null || auth.mode === "none") {
    return undefined;
  }

  // mode === "bearer" or "api_key" — both require a token.
  const rawToken = auth.token;
  if (typeof rawToken !== "string" || rawToken.length === 0) {
    warnings.push(
      `Sub-agent "${subAgentName}": auth.token is empty; omitting auth block.`,
    );
    return undefined;
  }

  const { resolved, missing } = substituteEnvVars(rawToken);

  if (missing.length > 0) {
    const plural = missing.length > 1;
    warnings.push(
      `Sub-agent "${subAgentName}": environment variable${plural ? "s" : ""} ` +
        `${missing.map((v) => `"${v}"`).join(", ")} referenced in auth.token ` +
        `${plural ? "are" : "is"} unset; omitting auth block.`,
    );
    return undefined;
  }

  if (resolved.length === 0) {
    warnings.push(
      `Sub-agent "${subAgentName}": auth.token resolved to an empty string; ` +
        `omitting auth block.`,
    );
    return undefined;
  }

  if (auth.mode === "bearer") {
    return { mode: "bearer", token: resolved };
  }

  // mode === "api_key" — preserve the optional headerName when set.
  const out: SubAgentAuthConfig = { mode: "api_key", token: resolved };
  if (auth.headerName !== undefined) {
    out.headerName = auth.headerName;
  }
  return out;
}

/**
 * Replace every `${VAR}` reference in `value` with `process.env[VAR]`,
 * collecting the names of any variables that are unset. Variables
 * whose values are the empty string are treated as set (the resolved
 * token may still be deemed empty by the caller).
 */
function substituteEnvVars(value: string): {
  resolved: string;
  missing: string[];
} {
  const missing: string[] = [];
  const resolved = value.replace(ENV_VAR_PATTERN, (_match, varName: string) => {
    const envValue = process.env[varName];
    if (envValue === undefined) {
      missing.push(varName);
      return "";
    }
    return envValue;
  });
  return { resolved, missing };
}
