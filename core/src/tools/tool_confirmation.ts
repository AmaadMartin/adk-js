/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../errors/input_validation_error.js';
import {isRecord} from '../utils/object_utils.js';

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

  /**
   * Parses a confirmation out of a function-response object.
   *
   * A client may answer a gate in either of two shapes: the fields directly,
   * or the ADK client's `{response: '<json>'}` envelope. Both parse to the
   * same confirmation.
   *
   * Validation is strict. A key outside `hint`, `confirmed` and `payload` is
   * refused rather than dropped, so a client that misspells a field learns
   * that the field never took effect.
   *
   * @param response The decoded response of a confirmation function response.
   * @return The confirmation the client sent.
   * @throws InputValidationError If the envelope does not decode, or the
   *     fields do not match the confirmation shape.
   */
  static fromResponseDict(response: Record<string, unknown>): ToolConfirmation {
    const result = confirmationFieldsSchema.safeParse(
      unwrapConfirmationResponse(response),
    );
    if (!result.success) {
      throw new InputValidationError(
        `ToolConfirmation received ${describeIssues(result.error)}.`,
        {cause: result.error},
      );
    }
    return new ToolConfirmation(result.data);
  }
}

/**
 * The fields a confirmation response may carry, and nothing else.
 *
 * `payload` stays opaque: the reference model declares it `Optional[Any]` and
 * passes it through untouched, so nothing here inspects or rewrites it.
 *
 * The reference also configures a camelCase alias generator. That is a no-op
 * for these three single-word names — the alias equals the field name — so
 * there is no key mapping to port.
 *
 * `hint` declares no default because the constructor already applies one.
 */
const confirmationFieldsSchema = z.strictObject({
  hint: z.string().optional(),
  confirmed: z.boolean().default(false),
  payload: z.unknown().optional(),
});

/**
 * Unwraps the ADK client's `{response: '<json>'}` envelope.
 *
 * A lone `response` key is the envelope, and its value is a JSON string
 * carrying the real fields. Any other shape already is the fields, so a
 * `response` key next to other keys is not an envelope.
 *
 * @param response The decoded response of a confirmation function response.
 * @return The confirmation fields, still unvalidated.
 * @throws InputValidationError If the envelope does not decode to an object.
 */
export function unwrapConfirmationResponse(
  response: Record<string, unknown>,
): Record<string, unknown> {
  const keys = Object.keys(response);
  return keys.length === 1 && keys[0] === 'response'
    ? decodeConfirmationEnvelope(response['response'])
    : response;
}

function decodeConfirmationEnvelope(value: unknown): Record<string, unknown> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(String(value));
  } catch (e: unknown) {
    throw new InputValidationError(
      'ToolConfirmation envelope is not valid JSON.',
      {cause: e},
    );
  }
  if (!isRecord(decoded)) {
    throw new InputValidationError(
      'ToolConfirmation envelope must decode to an object.',
    );
  }
  return decoded;
}

/**
 * Names what the confirmation fields got wrong, without quoting any value —
 * the response is caller-controlled and must not reach a log.
 */
function describeIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.code === 'unrecognized_keys'
        ? `unknown key(s): ${issue.keys.join(', ')}`
        : `an invalid '${issue.path.join('.')}': ${issue.message}`,
    )
    .join('; ');
}

/**
 * Why a confirmation was refused. Each value is one of the checks the resume
 * path makes before it runs a tool call a human approved.
 */
export type IntentMismatchReason =
  /** The `adk_request_confirmation` call was not raised by the agent. */
  | 'untrusted_request'
  /** The `adk_request_confirmation` call carries no usable pinned call. */
  | 'malformed_request'
  /** The pinned call is absent from session history. */
  | 'unknown_original_call'
  /** The pinned call names a tool the agent does not have. */
  | 'unregistered_tool'
  /** The pinned tool does not gate on confirmation, so nothing was approved. */
  | 'confirmation_not_required'
  /** The pinned tool name disagrees with the call in history. */
  | 'tool_name_mismatch'
  /** The pinned arguments disagree with the call in history. */
  | 'arguments_mismatch';

/**
 * Raised when a tool confirmation does not bind to the action it claims to
 * approve — the approval and the action about to run are not the same thing.
 *
 * The framework fails closed on this: a mismatch aborts the invocation rather
 * than running an action no human agreed to. It is worth alerting on, so the
 * message names the reason and the call, and deliberately carries no argument
 * values — a rejected payload is attacker-controlled and does not belong in
 * logs.
 */
export class IntentMismatchError extends Error {
  /** Which binding check refused the confirmation. */
  readonly reason: IntentMismatchReason;

  /** The id of the pinned call, when one was named. */
  readonly functionCallId?: string;

  constructor(options: {
    reason: IntentMismatchReason;
    functionCallId?: string;
  }) {
    const target = options.functionCallId
      ? ` for function call '${options.functionCallId}'`
      : '';
    super(`Tool confirmation rejected${target}: ${options.reason}.`);
    this.name = 'IntentMismatchError';
    this.reason = options.reason;
    this.functionCallId = options.functionCallId;
    // Restore prototype chain for `instanceof` across transpilation targets.
    Object.setPrototypeOf(this, IntentMismatchError.prototype);
  }
}

/**
 * Type guard for {@link IntentMismatchError}.
 *
 * Matches on `name` rather than `instanceof` so it stays correct when the error
 * crosses a package boundary (two copies of adk-js in one runtime would fail an
 * `instanceof` check between them).
 */
export function isIntentMismatchError(e: unknown): e is IntentMismatchError {
  return e instanceof Error && e.name === 'IntentMismatchError';
}
