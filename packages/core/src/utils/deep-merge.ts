/**
 * Deep Merge and Environment Token Substitution Utilities
 *
 * This module provides two core utility functions used throughout the
 * configuration loading pipeline:
 *
 * 1. `deepMerge` — Recursively merges a source object into a target object,
 *    producing a new object without mutating either input. Used by the config
 *    loader to layer defaults ← file ← env ← CLI overrides.
 *
 * 2. `substituteEnvTokens` — Replaces `$VAR_NAME` tokens in string arrays
 *    with matching environment variable values. Used to resolve environment
 *    references in MCP server arguments and other configuration arrays.
 *
 * Both functions are pure (no side effects beyond reading `process.env`) and
 * return new data structures rather than mutating inputs.
 *
 * @module utils/deep-merge
 */

/**
 * Recursively merge `source` into `target`, producing a new object.
 *
 * This function implements a deterministic, recursive merge strategy designed
 * for layered configuration loading. The merge follows these rules:
 *
 * **Merge Rules:**
 * - **Arrays are replaced** — If the source value for a key is an array, it
 *   completely replaces the target's array (no concatenation).
 * - **Neither input is mutated** — A new object is always returned. Both
 *   `target` and `source` remain unchanged after the call.
 * - **`undefined` values in source are skipped** — If a source key has the
 *   value `undefined`, the corresponding target value is preserved.
 * - **`null` values in source replace the target value** — An explicit `null`
 *   in the source overwrites whatever the target had for that key.
 * - **Nested objects are recursively merged** — When both the target and
 *   source values for a key are plain objects (non-null, non-array), the
 *   merge recurses into them.
 *
 * @typeParam T - The shape of the target object. The return type preserves
 *   this shape so that downstream consumers retain full type information.
 *
 * @param target - The base object providing default values. Not mutated.
 * @param source - The override object whose defined, non-undefined values
 *   take precedence over `target`. Not mutated.
 * @returns A new object containing the merged result of `target` and `source`.
 *
 * @example
 * ```typescript
 * const base = { server: { port: 3000, host: "localhost" }, tags: ["a"] };
 * const overrides = { server: { port: 8080 }, tags: ["b", "c"] };
 * const result = deepMerge(base, overrides);
 * // result = { server: { port: 8080, host: "localhost" }, tags: ["b", "c"] }
 * // base and overrides are unchanged
 * ```
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target };

  for (const key of Object.keys(source)) {
    const srcVal = (source as Record<string, unknown>)[key];

    // Skip undefined values — preserve the target's value
    if (srcVal === undefined) continue;

    const tgtVal = (result as Record<string, unknown>)[key];

    // Recursively merge when both sides are plain objects (non-null, non-array)
    if (
      tgtVal !== null &&
      srcVal !== null &&
      typeof tgtVal === "object" &&
      typeof srcVal === "object" &&
      !Array.isArray(tgtVal) &&
      !Array.isArray(srcVal)
    ) {
      (result as Record<string, unknown>)[key] = deepMerge(
        tgtVal as Record<string, unknown>,
        srcVal as Record<string, unknown>,
      );
    } else {
      // Arrays, primitives, and null — direct replacement
      (result as Record<string, unknown>)[key] = srcVal;
    }
  }

  return result;
}

/**
 * Replace environment-variable tokens in a single string.
 *
 * Two token forms are supported:
 * - `${VAR_NAME}` — explicit form, recommended. Works mid-string, e.g.
 *   `"Bearer ${TOKEN}"`.
 * - `$VAR_NAME` — bare form, kept for backward compatibility, e.g.
 *   `"$WORKSPACE_DIR"`.
 *
 * Tokens with no matching environment variable are left **unchanged** so that
 * literal `$` usage and misconfigurations remain visible rather than being
 * silently replaced with an empty string.
 *
 * @param value - String potentially containing env-var tokens.
 * @returns The string with resolvable tokens substituted.
 *
 * @example
 * ```typescript
 * // process.env.TOKEN = "abc"
 * substituteEnvTokensInString("Bearer ${TOKEN}") // "Bearer abc"
 * substituteEnvTokensInString("$HOME/x")          // "/home/user/x"
 * substituteEnvTokensInString("${MISSING}")       // "${MISSING}" (unchanged)
 * ```
 */
export function substituteEnvTokensInString(value: string): string {
  return value
    .replace(/\$\{(\w+)\}/g, (match, name: string) => process.env[name] ?? match)
    .replace(/\$(\w+)/g, (match, name: string) => process.env[name] ?? match);
}

/**
 * Replace `$VAR_NAME` / `${VAR_NAME}` tokens in a string array with matching
 * environment variable values from `process.env`.
 *
 * Each element is processed via {@link substituteEnvTokensInString}, so both
 * the bare (`$VAR`) and explicit (`${VAR}`) token forms are supported.
 * Unmatched tokens are left unchanged. Returns a **new array** — the input is
 * not mutated.
 *
 * @param args - Array of strings potentially containing env-var tokens.
 * @returns A new array with resolvable tokens substituted.
 *
 * @example
 * ```typescript
 * // Given: process.env.HOME = "/home/user"
 * // Given: process.env.WORKSPACE_DIR is not set
 *
 * substituteEnvTokens(["--dir", "$HOME/projects", "$WORKSPACE_DIR"])
 * // Returns: ["--dir", "/home/user/projects", "$WORKSPACE_DIR"]
 * ```
 */
export function substituteEnvTokens(args: string[]): string[] {
  return args.map(substituteEnvTokensInString);
}

/**
 * Replace env-var tokens in every value of a string-keyed string map.
 *
 * Each value is processed via {@link substituteEnvTokensInString} (supporting
 * both `${VAR}` and `$VAR` forms). Non-string values are passed through
 * untouched. Returns a **new object** — the input is not mutated. Passing
 * `undefined` returns `undefined`, which is convenient for optional config
 * fields like MCP `env` / `headers`.
 *
 * @param record - Map of string keys to string values (e.g. HTTP headers,
 *   process environment variables). May be `undefined`.
 * @returns A new map with resolvable tokens substituted, or `undefined` when
 *   the input was `undefined`.
 *
 * @example
 * ```typescript
 * // process.env.LINEAR_API_KEY = "lin_xxx"
 * substituteEnvTokensInRecord({ Authorization: "Bearer ${LINEAR_API_KEY}" })
 * // Returns: { Authorization: "Bearer lin_xxx" }
 * ```
 */
export function substituteEnvTokensInRecord(
  record: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!record) return record;
  const out: Record<string, string> = {};
  for (const [key, val] of Object.entries(record)) {
    out[key] = typeof val === "string" ? substituteEnvTokensInString(val) : val;
  }
  return out;
}
