/**
 * Backend Paths — Codex Memory Materialization Targets
 *
 * Defines where Codex reads project instructions and skills.
 * Codex uses AGENTS.md (not .codex/instructions.md) for project context.
 *
 * Note: The core WELL_KNOWN_PATHS.codex currently has an incorrect default
 * (.codex/instructions.md). This wrapper-local constant takes precedence.
 */

import type { BackendPaths } from "@a2a-wrapper/core";

export const CODEX_BACKEND_PATHS: BackendPaths = {
  instructionsPath: "AGENTS.md",
  skillsBaseDir: ".agents/skills",
};
