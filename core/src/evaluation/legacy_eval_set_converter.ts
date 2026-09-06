/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Converts eval data written in ADK's original format into an {@link EvalSet}.
 *
 * The original format is a list of `{query, reference, expected_tool_use}`
 * records per eval case. It predates the eval-set schema and is still what
 * many `*.test.json` files hold, so both `AgentEvaluator.evaluate` and
 * `AgentEvaluator.migrateEvalDataToNewSchema` read it.
 */

import {Content, createPartFromText, FunctionCall, Part} from '@google/genai';
import {randomUUID} from '../utils/env_aware_utils.js';
import {EvalCase, Invocation, SessionInput} from './eval_case.js';
import {EvalSetSchemaError, isRecord} from './eval_json.js';
import {EvalSet} from './eval_set.js';

/** Milliseconds per second, for the epoch-seconds timestamps eval data uses. */
const MILLIS_PER_SECOND = 1000;

/** One eval case in the original format. */
export interface LegacyEvalCase {
  /** The eval case id. */
  name: string;

  /** The turns of the conversation. */
  data: Array<Record<string, unknown>>;

  /** Session state shared by every turn, keyed in snake_case. */
  initialSession?: Record<string, unknown>;
}

/**
 * Reads the eval cases of a file written in the original format.
 *
 * @throws {EvalSetSchemaError} When the value is not a list of eval cases in
 *   the original format either.
 */
export function parseLegacyEvalCases(raw: unknown): LegacyEvalCase[] {
  if (!Array.isArray(raw)) {
    throw new EvalSetSchemaError(
      'Eval data in the original format must be a JSON array of eval cases.',
    );
  }
  return raw.map((legacyEvalCase) => {
    if (
      !isRecord(legacyEvalCase) ||
      typeof legacyEvalCase['name'] !== 'string' ||
      !Array.isArray(legacyEvalCase['data'])
    ) {
      throw new EvalSetSchemaError(
        'Every eval case in the original format must have a `name` and ' +
          '`data`.',
      );
    }
    return {
      name: legacyEvalCase['name'],
      data: legacyEvalCase['data'].filter(isRecord),
      initialSession: isRecord(legacyEvalCase['initial_session'])
        ? legacyEvalCase['initial_session']
        : undefined,
    };
  });
}

/** Converts eval cases in the original format to an {@link EvalSet}. */
export function convertLegacyEvalSet(
  evalSetId: string,
  legacyEvalCases: LegacyEvalCase[],
): EvalSet {
  const creationTimestamp = Date.now() / MILLIS_PER_SECOND;
  const evalCases: EvalCase[] = legacyEvalCases.map((legacyEvalCase) => ({
    evalId: legacyEvalCase.name,
    conversation: legacyEvalCase.data.map(convertLegacyInvocation),
    sessionInput: convertInitialSession(legacyEvalCase.initialSession),
    creationTimestamp,
  }));
  return {evalSetId, evalCases, creationTimestamp};
}

function convertLegacyInvocation(
  legacyInvocation: Record<string, unknown>,
): Invocation {
  return {
    invocationId: randomUUID(),
    userContent: textContent(asText(legacyInvocation['query']), 'user'),
    finalResponse: textContent(asText(legacyInvocation['reference']), 'model'),
    intermediateData: {
      toolUses: convertToolUses(legacyInvocation['expected_tool_use']),
      toolResponses: [],
      intermediateResponses: convertIntermediateResponses(
        legacyInvocation['expected_intermediate_agent_responses'],
      ),
    },
    creationTimestamp: Date.now() / MILLIS_PER_SECOND,
  };
}

function convertToolUses(legacyToolUses: unknown): FunctionCall[] {
  if (!Array.isArray(legacyToolUses)) {
    return [];
  }
  return legacyToolUses.filter(isRecord).map((legacyToolUse) => ({
    name: asText(legacyToolUse['tool_name']),
    args: isRecord(legacyToolUse['tool_input'])
      ? legacyToolUse['tool_input']
      : {},
  }));
}

function convertIntermediateResponses(
  legacyResponses: unknown,
): Array<[string, Part[]]> {
  if (!Array.isArray(legacyResponses)) {
    return [];
  }
  return legacyResponses
    .filter(isRecord)
    .map((legacyResponse) => [
      asText(legacyResponse['author']),
      [createPartFromText(asText(legacyResponse['text']))],
    ]);
}

function convertInitialSession(
  initialSession?: Record<string, unknown>,
): SessionInput | undefined {
  if (!initialSession || Object.keys(initialSession).length === 0) {
    return undefined;
  }
  return {
    appName: asText(initialSession['app_name']),
    userId: asText(initialSession['user_id']),
    state: isRecord(initialSession['state']) ? initialSession['state'] : {},
  };
}

function textContent(text: string, role: string): Content {
  return {parts: [createPartFromText(text)], role};
}

function asText(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
