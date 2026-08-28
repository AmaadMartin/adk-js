/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Keys of the ADK evaluation dataset file format.
 *
 * These values appear verbatim in the `*.test.json` files that users author and
 * keep on disk, so they are observable outside the process. They stay
 * snake_case and identical to adk-python's `EvalConstants`.
 *
 * Index a dataset entry through these members rather than through a string
 * literal. A typo in `'expected_tool_use'` does not fail to compile; it reads
 * `undefined` at runtime from a file that is perfectly valid.
 */
export enum EvalConstants {
  QUERY = 'query',
  EXPECTED_TOOL_USE = 'expected_tool_use',
  RESPONSE = 'response',
  REFERENCE = 'reference',
  TOOL_NAME = 'tool_name',
  TOOL_INPUT = 'tool_input',
  MOCK_TOOL_OUTPUT = 'mock_tool_output',
}
