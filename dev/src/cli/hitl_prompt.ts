/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turning a paused turn into questions, and the typed answers back into the
 * function responses that resume the run.
 *
 * The prompts and the response payloads follow adk-python's `cli.py`, so a
 * transcript of `adk run` reads the same in both languages. Nothing here reads
 * stdin: the caller supplies the answer, which is what makes it testable.
 */

import {Event, getFunctionCalls} from '@google/adk';
import {Part} from '@google/genai';

import {asNonEmptyString, isRecord} from '../utils/value_utils.js';

const REQUEST_INPUT = 'adk_request_input';
const REQUEST_CONFIRMATION = 'adk_request_confirmation';

const POSITIVE_ANSWERS = new Set(['y', 'yes', 'true', 'confirm']);

/** A long-running function call from the finished turn that owes an answer. */
export interface PendingFunctionCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

/**
 * The long-running calls a turn raised, in event order and then part order.
 *
 * A call with no id or no name is skipped: a function response is addressed by
 * both, so neither can be answered.
 */
export function collectPendingFunctionCalls(
  events: Event[],
): PendingFunctionCall[] {
  const pending: PendingFunctionCall[] = [];

  for (const event of events) {
    const longRunningIds = event.longRunningToolIds;
    if (!longRunningIds?.length) {
      continue;
    }

    for (const call of getFunctionCalls(event)) {
      if (call.id && call.name && longRunningIds.includes(call.id)) {
        pending.push({id: call.id, name: call.name, args: call.args ?? {}});
      }
    }
  }

  return pending;
}

/** Whether the answer approves a confirmation request. */
export function isPositiveResponse(value: string): boolean {
  return POSITIVE_ANSWERS.has(value.trim().toLowerCase());
}

/** What the CLI prints to ask for one pending call's answer. */
export function renderFunctionCallPrompt(call: PendingFunctionCall): string {
  switch (call.name) {
    case REQUEST_INPUT: {
      const message =
        asNonEmptyString(call.args['message']) ?? 'Input requested';
      const schema = call.args['response_schema'];
      const lines = [`[HITL input] ${message}`];
      if (schema) {
        lines.push(`  Schema: ${JSON.stringify(schema)}`);
      }
      return lines.join('\n');
    }
    case REQUEST_CONFIRMATION: {
      const confirmation = call.args['toolConfirmation'];
      const hint = isRecord(confirmation)
        ? asNonEmptyString(confirmation['hint'])
        : undefined;
      const original = call.args['originalFunctionCall'];
      const originalName =
        (isRecord(original) ? asNonEmptyString(original['name']) : undefined) ??
        'unknown';
      return [
        `[HITL confirm] ${hint ?? `Confirm ${originalName}?`}`,
        '  Type "yes" to confirm, anything else to reject.',
      ].join('\n');
    }
    default:
      return `[HITL] Waiting for input for ${call.name}(${JSON.stringify(call.args)})`;
  }
}

/** The part that answers one pending call with what the user typed. */
export function buildFunctionResponse(
  call: PendingFunctionCall,
  answer: string,
): Part {
  return {
    functionResponse: {
      id: call.id,
      name: call.name,
      response: buildResponsePayload(call.name, answer),
    },
  };
}

/**
 * Reads the answer to one pending call.
 *
 * A JSON object is the response itself, so a caller can answer a structured
 * request in one line. Anything else travels under `result`.
 */
function buildResponsePayload(
  name: string,
  answer: string,
): Record<string, unknown> {
  if (name === REQUEST_CONFIRMATION) {
    return {confirmed: isPositiveResponse(answer)};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return {result: answer};
  }
  return isRecord(parsed) ? parsed : {result: parsed};
}
