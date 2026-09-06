/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Builds the `INVALID_ARGUMENTS` response naming every argument in `names`
 * that is missing or empty in `args`, or returns `undefined` when they are all
 * present. The messages are joined with a newline so one response reports
 * every missing argument, as the skill toolset in adk-python does.
 */
export function missingArgumentsError(
  args: Record<string, unknown>,
  names: string[],
): {error: string; error_code: string} | undefined {
  const missing = names.filter((name) => !args[name]);
  if (missing.length === 0) {
    return undefined;
  }

  return {
    error: missing.map((name) => `Argument '${name}' is required.`).join('\n'),
    error_code: 'INVALID_ARGUMENTS',
  };
}
