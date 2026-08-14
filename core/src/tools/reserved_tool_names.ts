/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
} from '../agents/functions.js';

/**
 * Tool names the framework itself puts on the wire. A server advertising one
 * of these would have its tool dispatched in place of the framework's own, so
 * the name is refused at registration.
 */
const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
]);

/** Returns whether `name` is exactly a tool name the framework reserves. */
export function isReservedToolName(name: string): boolean {
  return RESERVED_TOOL_NAMES.has(name);
}
