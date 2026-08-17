/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// `import type` keeps this a compile-time-only reference: `Context` imports
// `ToolConfirmation` as a value, so a value import back would form a runtime
// ESM cycle.
import type {Context} from '../agents/context.js';

/**
 * Represents a tool confirmation configuration.
 * @experimental  (Experimental, subject to change)
 */
export class ToolConfirmation {
  /** The hint text for why the input is needed. */
  hint: string;

  /** Whether the tool execution is confirmed. */
  confirmed: boolean;

  /**
   * The custom data payload needed from the user to continue the flow.
   * It should be JSON serializable.
   */
  payload?: unknown;

  constructor({
    hint,
    confirmed,
    payload,
  }: {
    hint?: string;
    confirmed: boolean;
    payload?: unknown;
  }) {
    this.hint = hint ?? '';
    this.confirmed = confirmed;
    this.payload = payload;
  }
}

/**
 * Applies the confirmation gate to a tool call that requires confirmation.
 *
 * The caller decides whether confirmation is required
 * (`BaseTool.checkRequireConfirmation`); this helper only runs the gate itself,
 * so every tool surfaces the same hint and the same errors.
 *
 * @param toolName The name of the gated tool, quoted back in the hint.
 * @param toolContext The context of the current tool call.
 * @return `undefined` when the call may proceed (the user approved); otherwise
 *     the function response payload the tool surfaces instead of running — a
 *     request for confirmation on the first pass, or a rejection once the user
 *     declined.
 */
export function checkToolConfirmation(
  toolName: string,
  toolContext: Context,
): {error: string} | undefined {
  if (!toolContext.toolConfirmation) {
    toolContext.requestConfirmation({
      hint:
        `Please approve or reject the tool call ${toolName}() by ` +
        'responding with a FunctionResponse with an expected ' +
        'ToolConfirmation payload.',
    });
    toolContext.actions.skipSummarization = true;
    return {
      error: 'This tool call requires confirmation, please approve or reject.',
    };
  }
  if (!toolContext.toolConfirmation.confirmed) {
    return {error: 'This tool call is rejected.'};
  }
  return undefined;
}
