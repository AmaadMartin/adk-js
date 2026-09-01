/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Turns what a user typed into the function response that answers a paused run.
 */
import {REQUEST_INPUT_FUNCTION_CALL_NAME, UserInputRequest} from '@google/adk';
import {Part} from '@google/genai';
import {isRecord} from '../utils/json_utils.js';

const POSITIVE_ANSWERS: ReadonlySet<string> = new Set([
  'y',
  'yes',
  'true',
  'confirm',
]);

/** Whether the answer approves a confirmation request. */
function isPositiveResponse(answer: string): boolean {
  return POSITIVE_ANSWERS.has(answer.trim().toLowerCase());
}

/**
 * Reads an answer to an input request.
 *
 * A JSON object is the response itself, so a caller can answer a structured
 * request in one line. Anything else — a JSON scalar, or text that is not JSON
 * at all — is carried under `result`.
 */
export function parseInputResponse(answer: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return {result: answer};
  }
  return isRecord(parsed) ? parsed : {result: parsed};
}

/**
 * Reads an answer to a confirmation request.
 *
 * A JSON object is passed through, which is how a caller supplies a custom
 * payload or an explicit flag; anything else decides `confirmed`.
 */
export function parseConfirmationResponse(
  answer: string,
): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(answer);
  } catch {
    return {confirmed: isPositiveResponse(answer)};
  }
  return isRecord(parsed) ? parsed : {confirmed: isPositiveResponse(answer)};
}

/**
 * Builds the part that answers one paused request with what the user typed.
 *
 * @param request The request to answer.
 * @param answer What the user typed.
 */
export function buildInterruptResponse(
  request: UserInputRequest,
  answer: string,
): Part {
  return {
    functionResponse: {
      id: request.interruptId,
      // A credential request is answered as an input request, as adk-python
      // does; completing an auth flow from the command line is not supported.
      name:
        request.kind === 'credential'
          ? REQUEST_INPUT_FUNCTION_CALL_NAME
          : request.functionCallName,
      response:
        request.kind === 'confirmation'
          ? parseConfirmationResponse(answer)
          : parseInputResponse(answer),
    },
  };
}
