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
} from '../agents/framework_function_calls.js';

/**
 * The tool names ADK itself puts on the wire.
 *
 * The runtime keys its tool dictionary by name, so a tool that adopts one of
 * these names shadows the framework primitive: the model asks for a hand-off
 * or a human-in-the-loop interrupt, and the call goes somewhere else. A tool
 * built from an untrusted listing is matched against this set exactly and
 * case-sensitively, since `transfer_to_agent_v2` is a legal name.
 */
export const RESERVED_TOOL_NAMES: ReadonlySet<string> = new Set([
  REQUEST_CONFIRMATION_FUNCTION_CALL_NAME,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
  TRANSFER_TO_AGENT_FUNCTION_CALL_NAME,
]);
