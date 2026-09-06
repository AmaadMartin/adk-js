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
import {nowInSeconds} from '../utils/time_utils.js';
import {EvalCase, Invocation, SessionInput} from './eval_case.js';
import {isRecord} from './eval_json.js';
import {EvalSet} from './eval_set.js';

/** One eval case in the original format. */
export interface LegacyEvalCase {
  /** The eval case id. */
  name: string;

  /** The turns of the conversation. */
  data: Array<Record<string, unknown>>;

  /** Session state shared by every turn, keyed in snake_case. */
  initialSession?: Record<string, unknown>;
}

/** Converts eval cases in the original format to an {@link EvalSet}. */
export function convertLegacyEvalSet(
  evalSetId: string,
  legacyEvalCases: LegacyEvalCase[],
): EvalSet {
  const creationTimestamp = nowInSeconds();
  const evalCases: EvalCase[] = legacyEvalCases.map((legacyEvalCase) => ({
    evalId: legacyEvalCase.name,
    conversation: legacyEvalCase.data.map(convertLegacyInvocation),
    sessionInput: convertInitialSession(legacyEvalCase.initialSession),
    creationTimestamp,
  }));
  return {evalSetId, name: evalSetId, evalCases, creationTimestamp};
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
    creationTimestamp: nowInSeconds(),
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
