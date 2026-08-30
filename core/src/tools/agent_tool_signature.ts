/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The {@link AgentTool} brand, in a module of its own so that a caller can
 * recognise an agent tool without loading one.
 *
 * `agents/functions.ts` asks the question and `tools/agent_tool.ts` reaches the
 * workflow node runtime, which reaches `agents/functions.ts` again. A static
 * import between the two would close that loop and leave a class extending an
 * undefined base at load time. This module imports nothing at runtime, so it
 * breaks the loop without a lazy import.
 */

import type {AgentTool} from './agent_tool.js';

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseTool instances.
 */
export const AGENT_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.agentTool');

/**
 * Type guard to check if an object is an instance of BaseTool.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseTool, false otherwise.
 */
export function isAgentTool(obj: unknown): obj is AgentTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    AGENT_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[AGENT_TOOL_SIGNATURE_SYMBOL] === true
  );
}
