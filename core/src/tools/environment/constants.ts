/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Default execution timeout in seconds. */
export const DEFAULT_TIMEOUT_SECONDS = 30;

/** Maximum characters returned to the LLM per tool call. */
export const MAX_OUTPUT_CHARS = 30_000;

/**
 * Builds the environment-level system instruction for `workingDir`.
 *
 * The text is model-facing and is reproduced from adk-python's
 * `ENVIRONMENT_INSTRUCTION` template in
 * `src/google/adk/tools/environment/_constants.py`. Python formats that
 * template with `.format(working_dir=...)`; a function removes the
 * placeholder-typo failure mode.
 */
export function environmentInstruction(workingDir: string): string {
  return `Your environment is at ${workingDir}/

# Environment Rules

DO:
- Chain sequential, dependent commands with \`&&\` in a single \`Execute\` call
- To read existing files, always use the \`ReadFile\` tool. Use \`EditFile\` to modify existing files.

DON'T:
- Use \`Execute\` to run cat, head, or tail when \`ReadFile\` tools can do the job
- Combine \`EditFile\` or \`ReadFile\` with \`Execute\` in the same response (Instead, call the file tool first, then \`Execute\` in the next turn)
- Use multiple \`Execute\` calls for dependent commands (they run in parallel)
`;
}
