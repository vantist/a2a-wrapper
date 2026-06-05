/**
 * Backend Capability Declaration — Codex
 *
 * Declares the capabilities of the Codex backend to callers and
 * orchestrators. Use this to make runtime decisions about what
 * the backend can and cannot do.
 */

export interface BackendCapabilities {
  /** Artifact delivery model. "buffered" = single final artifact. */
  artifactStreaming: "buffered" | "incremental";
  /** Whether tasks can be aborted mid-execution. */
  cancellation: "state-only" | "abortable";
  /** MCP transports the backend can accept. */
  mcpTransports: Array<"stdio" | "http" | "sse">;
  /** Whether the backend runs in a sandboxed environment. */
  sandboxing: boolean;
  /** Approval model. "none" = auto-approve; "interactive" = blocks waiting for human. */
  approvals: "none" | "headless" | "interactive";
}

export const CODEX_CAPABILITIES: BackendCapabilities = {
  // Declared buffered until integration tests confirm snapshot-delta extraction is safe
  artifactStreaming: "buffered",
  cancellation: "abortable",
  mcpTransports: ["stdio", "http"],
  sandboxing: true,
  approvals: "none",
};
