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
import {logger} from '../utils/logger.js';

/**
 * The function call names ADK itself puts on the wire.
 *
 * The runtime keys its tool dictionary by name, so a tool that adopts one of
 * these names shadows the framework primitive: the model asks for a hand-off
 * or a human-in-the-loop interrupt and the call goes somewhere else. Tools
 * built from an untrusted listing must be matched against this set, exactly
 * and case-sensitively — `transfer_to_agent_v2` is a legal name.
 */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
]);

/**
 * Reports whether `name` is reserved, and warns the operator when it is.
 *
 * A toolset calls this to drop the tool before it constructs one. Skipping
 * here rather than letting `MCPTool` throw keeps one reserved name from taking
 * the server's honest tools down with it.
 *
 * @param name The exposed tool name — the prefixed one, when a toolset applies
 *   a prefix, since that is the name the tool dictionary is keyed by.
 */
export function warnIfReservedToolName(name: string): boolean {
  if (!RESERVED_TOOL_NAMES.has(name)) {
    return false;
  }
  logger.warn(
    `Skipping MCP tool '${name}' because it collides with a reserved ADK framework tool name.`,
  );
  return true;
}
