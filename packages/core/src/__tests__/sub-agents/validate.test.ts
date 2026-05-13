import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  SubAgentValidationError,
  validateSubAgents,
} from "../../sub-agents/validate.js";
import { SUBAGENTS_MCP_KEY } from "../../sub-agents/types.js";
import type { SubAgentConfig } from "../../sub-agents/types.js";

/**
 * Unit tests for the sub-agents config validator.
 *
 * Validates Requirements 1.3, 1.4, 1.5, 1.6, 2.3, 2.4, 3.4, 3.5, 5.2 by
 * exercising every fail-fast case and the env-substitution path of
 * {@link validateSubAgents}.
 */

const NO_RESERVED: ReadonlySet<string> = new Set();

/** Convenience helper: extract `details.reason` off a thrown validation error. */
function expectReason(fn: () => unknown, reason: string): SubAgentValidationError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(SubAgentValidationError);
    const ve = err as SubAgentValidationError;
    expect(ve.details.reason).toBe(reason);
    return ve;
  }
  throw new Error(`Expected validateSubAgents to throw with reason "${reason}", but it did not throw.`);
}

describe("validateSubAgents — fail-fast errors", () => {
  // Requirement 1.3: missing `name` throws and identifies the entry by index.
  it("throws when an entry is missing the required `name` field, identifying the index", () => {
    const agents = [
      {
        agentCardUrl: "https://coding.example.com/.well-known/agent-card.json",
      } as unknown as SubAgentConfig,
    ];

    const err = expectReason(() => validateSubAgents(agents, NO_RESERVED), "missing_name");
    expect(err.details.index).toBe(0);
    expect(err.message).toMatch(/index 0/);
    expect(err.message).toMatch(/name/);
  });

  it("throws missing_name when `name` is an empty string", () => {
    const agents: SubAgentConfig[] = [
      { name: "", agentCardUrl: "https://example.com/.well-known/agent-card.json" },
    ];
    const err = expectReason(() => validateSubAgents(agents, NO_RESERVED), "missing_name");
    expect(err.details.index).toBe(0);
  });

  // Requirement 1.6: invalid `name` characters throw and identify the offending name.
  it.each([
    ["with a space", "coding agent"],
    ["with a dot", "coding.agent"],
    ["with a slash", "coding/agent"],
    ["with a colon", "coding:agent"],
    ["with an at sign", "coding@agent"],
  ])("throws invalid_name when name contains characters %s", (_label, badName) => {
    const agents: SubAgentConfig[] = [
      { name: badName, agentCardUrl: "https://example.com/.well-known/agent-card.json" },
    ];
    const err = expectReason(() => validateSubAgents(agents, NO_RESERVED), "invalid_name");
    expect(err.details.index).toBe(0);
    expect(err.details.subAgentName).toBe(badName);
    expect(err.message).toContain(badName);
  });

  // Requirement 1.5: duplicate names throw and list every duplicate.
  it("throws duplicate_name with every offending entry listed", () => {
    const agents: SubAgentConfig[] = [
      { name: "coding", agentCardUrl: "https://a.example.com/.well-known/agent-card.json" },
      { name: "research", agentCardUrl: "https://b.example.com/.well-known/agent-card.json" },
      { name: "coding", agentCardUrl: "https://c.example.com/.well-known/agent-card.json" },
      { name: "coding", agentCardUrl: "https://d.example.com/.well-known/agent-card.json" },
    ];
    const err = expectReason(() => validateSubAgents(agents, NO_RESERVED), "duplicate_name");
    // Lists the duplicate name once with all offending indexes.
    expect(err.message).toContain('"coding"');
    expect(err.message).toContain("0");
    expect(err.message).toContain("2");
    expect(err.message).toContain("3");
  });

  // Requirement 1.4: missing `agentCardUrl` throws and identifies entry by name.
  it("throws missing_agent_card_url and identifies the entry by name", () => {
    const agents = [
      { name: "coding" } as unknown as SubAgentConfig,
    ];
    const err = expectReason(
      () => validateSubAgents(agents, NO_RESERVED),
      "missing_agent_card_url",
    );
    expect(err.details.subAgentName).toBe("coding");
    expect(err.details.index).toBe(0);
    expect(err.message).toContain('"coding"');
    expect(err.message).toContain("agentCardUrl");
  });

  it("throws missing_agent_card_url when agentCardUrl is an empty string", () => {
    const agents: SubAgentConfig[] = [{ name: "coding", agentCardUrl: "" }];
    const err = expectReason(
      () => validateSubAgents(agents, NO_RESERVED),
      "missing_agent_card_url",
    );
    expect(err.details.subAgentName).toBe("coding");
  });

  // Requirement 2.4: agentCardUrl must be a valid http(s) URL.
  it.each([
    ["non-http scheme", "ftp://example.com/card.json"],
    ["file scheme", "file:///etc/agent-card.json"],
    ["javascript scheme", "javascript:alert(1)"],
  ])("throws invalid_agent_card_url for %s", (_label, badUrl) => {
    const agents: SubAgentConfig[] = [{ name: "coding", agentCardUrl: badUrl }];
    const err = expectReason(
      () => validateSubAgents(agents, NO_RESERVED),
      "invalid_agent_card_url",
    );
    expect(err.details.subAgentName).toBe("coding");
    expect(err.message).toContain(badUrl);
  });

  it("throws invalid_agent_card_url for unparseable strings", () => {
    const agents: SubAgentConfig[] = [{ name: "coding", agentCardUrl: "not a url" }];
    const err = expectReason(
      () => validateSubAgents(agents, NO_RESERVED),
      "invalid_agent_card_url",
    );
    expect(err.details.subAgentName).toBe("coding");
  });

  // Requirement 2.3: endpointUrlOverride must be a valid http(s) URL when set.
  it.each([
    ["non-http scheme", "ftp://internal.local/card.json"],
    ["file scheme", "file:///etc/agent-card.json"],
    ["unparseable", "::not a url::"],
  ])("throws invalid_endpoint_url_override for %s", (_label, badOverride) => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
        endpointUrlOverride: badOverride,
      },
    ];
    const err = expectReason(
      () => validateSubAgents(agents, NO_RESERVED),
      "invalid_endpoint_url_override",
    );
    expect(err.details.subAgentName).toBe("coding");
    expect(err.message).toContain("endpointUrlOverride");
  });

  it("throws invalid_endpoint_url_override when override is an empty string", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
        endpointUrlOverride: "",
      },
    ];
    const err = expectReason(
      () => validateSubAgents(agents, NO_RESERVED),
      "invalid_endpoint_url_override",
    );
    expect(err.details.subAgentName).toBe("coding");
  });

  // Requirement 5.2: collision with the reserved MCP key fails startup.
  it("throws reserved_mcp_key_collision when SUBAGENTS_MCP_KEY is already in mcp map", () => {
    const agents: SubAgentConfig[] = [
      { name: "coding", agentCardUrl: "https://example.com/.well-known/agent-card.json" },
    ];
    const reserved = new Set([SUBAGENTS_MCP_KEY]);
    const err = expectReason(
      () => validateSubAgents(agents, reserved),
      "reserved_mcp_key_collision",
    );
    expect(err.message).toContain(SUBAGENTS_MCP_KEY);
  });

  it("checks reserved key collision before per-entry diagnostics", () => {
    // Even though entries below would otherwise fail with `missing_name` /
    // `duplicate_name`, the reserved-key check fires first.
    const agents = [
      { agentCardUrl: "https://a.example.com/" } as unknown as SubAgentConfig,
      { agentCardUrl: "https://b.example.com/" } as unknown as SubAgentConfig,
    ];
    const err = expectReason(
      () => validateSubAgents(agents, new Set([SUBAGENTS_MCP_KEY])),
      "reserved_mcp_key_collision",
    );
    expect(err.details.reason).toBe("reserved_mcp_key_collision");
  });
});

describe("validateSubAgents — auth resolution and warnings", () => {
  // Snapshot environment so per-test mutations are isolated.
  const originalEnv = { ...process.env };

  beforeEach(() => {
    delete process.env.SUBAGENT_TEST_MISSING;
    delete process.env.SUBAGENT_TEST_PRESENT;
    delete process.env.SUBAGENT_TEST_EMPTY;
  });

  afterEach(() => {
    // Restore original env: clear our test keys, then reapply originals.
    delete process.env.SUBAGENT_TEST_MISSING;
    delete process.env.SUBAGENT_TEST_PRESENT;
    delete process.env.SUBAGENT_TEST_EMPTY;
    for (const key of Object.keys(originalEnv)) {
      process.env[key] = originalEnv[key];
    }
  });

  // Requirement 3.5: missing env var → warn + omit auth block; success.
  it("warns and omits auth block when an env var referenced in token is unset", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
        auth: { mode: "bearer", token: "${SUBAGENT_TEST_MISSING}" },
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.agents).toHaveLength(1);
    expect(result.agents[0].auth).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"coding"');
    expect(result.warnings[0]).toContain("SUBAGENT_TEST_MISSING");
    // Token value must never appear in warnings (it doesn't exist anyway).
    expect(result.warnings[0]).not.toContain("${");
  });

  // Requirement 3.4: present env var → token substituted, auth block intact.
  it("substitutes a present env var into the token and preserves the auth block", () => {
    process.env.SUBAGENT_TEST_PRESENT = "secret-bearer-value";
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
        auth: { mode: "bearer", token: "${SUBAGENT_TEST_PRESENT}" },
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.warnings).toEqual([]);
    expect(result.agents[0].auth).toEqual({
      mode: "bearer",
      token: "secret-bearer-value",
    });
  });

  it("substitutes mid-string env var references", () => {
    process.env.SUBAGENT_TEST_PRESENT = "abc";
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
        auth: { mode: "bearer", token: "Bearer-${SUBAGENT_TEST_PRESENT}-suffix" },
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.warnings).toEqual([]);
    expect(result.agents[0].auth).toEqual({
      mode: "bearer",
      token: "Bearer-abc-suffix",
    });
  });

  it("preserves a literal token (no env-var reference) verbatim", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
        auth: { mode: "bearer", token: "literal-token-value" },
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.warnings).toEqual([]);
    expect(result.agents[0].auth).toEqual({
      mode: "bearer",
      token: "literal-token-value",
    });
  });

  it("preserves api_key auth with optional headerName", () => {
    process.env.SUBAGENT_TEST_PRESENT = "key-123";
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
        auth: {
          mode: "api_key",
          token: "${SUBAGENT_TEST_PRESENT}",
          headerName: "X-Custom-Key",
        },
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.warnings).toEqual([]);
    expect(result.agents[0].auth).toEqual({
      mode: "api_key",
      token: "key-123",
      headerName: "X-Custom-Key",
    });
  });

  // Requirement 3.3: mode "none" → auth block omitted from output.
  it("omits the auth block when mode is `none`", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
        auth: { mode: "none" },
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.warnings).toEqual([]);
    expect(result.agents[0].auth).toBeUndefined();
  });

  it("omits the auth block when auth is omitted entirely", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.warnings).toEqual([]);
    expect(result.agents[0].auth).toBeUndefined();
  });

  it("warns and omits when the resolved token is empty", () => {
    process.env.SUBAGENT_TEST_EMPTY = "";
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
        auth: { mode: "bearer", token: "${SUBAGENT_TEST_EMPTY}" },
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.agents[0].auth).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain('"coding"');
  });

  it("collects multiple missing-env-var names into a single warning", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
        auth: {
          mode: "bearer",
          token: "${SUBAGENT_TEST_MISSING}-${SUBAGENT_TEST_EMPTY}",
        },
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.agents[0].auth).toBeUndefined();
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("SUBAGENT_TEST_MISSING");
    expect(result.warnings[0]).toContain("SUBAGENT_TEST_EMPTY");
  });
});

describe("validateSubAgents — happy paths and structural preservation", () => {
  it("returns the agent verbatim (minus undefined fields) on a minimal valid input", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.warnings).toEqual([]);
    expect(result.agents).toEqual([
      {
        name: "coding",
        agentCardUrl: "https://example.com/.well-known/agent-card.json",
      },
    ]);
  });

  it("preserves endpointUrlOverride when set to a valid http(s) URL", () => {
    const agents: SubAgentConfig[] = [
      {
        name: "research",
        agentCardUrl: "https://example.com/",
        endpointUrlOverride: "https://internal.local/.well-known/agent-card.json",
      },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.warnings).toEqual([]);
    expect(result.agents[0].endpointUrlOverride).toBe(
      "https://internal.local/.well-known/agent-card.json",
    );
  });

  it("accepts the empty agents array as valid (no warnings, no agents)", () => {
    const result = validateSubAgents([], NO_RESERVED);
    expect(result.agents).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("accepts names made up entirely of allowed characters (letters, digits, _, -)", () => {
    const agents: SubAgentConfig[] = [
      { name: "Coding-1", agentCardUrl: "https://a.example.com/" },
      { name: "research_2", agentCardUrl: "http://b.example.com/" },
      { name: "ABC123", agentCardUrl: "https://c.example.com/" },
    ];

    const result = validateSubAgents(agents, NO_RESERVED);

    expect(result.warnings).toEqual([]);
    expect(result.agents).toHaveLength(3);
    expect(result.agents.map((a) => a.name)).toEqual(["Coding-1", "research_2", "ABC123"]);
  });
});
