/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toSnakeCase} from '../utils/object_notation_utils.js';
import {getToolsByAgentName, type AppDetails} from './app_details.js';
import {
  getAllToolCallsWithResponses,
  isInvocationEvents,
  type IntermediateDataType,
  type Invocation,
} from './eval_case.js';
import type {RubricScore} from './eval_rubrics.js';
import {getTextFromContent} from './evaluator.js';

/** What the judge is told when the agent took no intermediate step. */
const NO_TOOL_CALLS_TEXT = 'No intermediate steps were taken.';

/** What the judge is told when no event carried grounding metadata. */
const NO_GROUNDING_METADATA_TEXT = 'No grounding metadata was provided.';

/** The indent of the JSON a judge model reads, matching adk-python. */
const JSON_INDENT = 2;

/**
 * A tool call's arguments and a tool response's payload are agent data, not
 * typed fields, so their own keys keep the spelling the agent used.
 */
const TOOL_CALL_PAYLOAD_KEYS = ['args'];
const TOOL_RESPONSE_PAYLOAD_KEYS = ['response'];

/**
 * Fills a prompt template, replacing every `{name}` with the matching value
 * and every `{{` or `}}` with the single brace it stands for.
 *
 * A `{name}` the values do not cover is left in place. The replacement is a
 * function, so a value containing `$&` or `$1` reaches the model unchanged.
 */
export function formatPromptTemplate(
  template: string,
  values: Record<string, string>,
): string {
  return template.replace(
    /\{\{|\}\}|\{(\w+)\}/g,
    (match: string, name: string | undefined) => {
      if (name === undefined) {
        return match === '{{' ? '{' : '}';
      }
      return values[name] ?? match;
    },
  );
}

/**
 * Returns the mean of the rubric scores that carry one, or `undefined` when
 * none of them do.
 */
export function getAverageRubricScore(
  rubricScores: RubricScore[],
): number | undefined {
  const scores = rubricScores.flatMap((rubricScore) =>
    rubricScore.score === undefined ? [] : [rubricScore.score],
  );
  if (scores.length === 0) {
    return undefined;
  }
  return scores.reduce((total, score) => total + score, 0) / scores.length;
}

/**
 * Returns the tools of every agent in the app as a JSON string, for a judge
 * model to read.
 */
export function getToolDeclarationsAsJsonStr(appDetails: AppDetails): string {
  const toolsByAgentName = getToolsByAgentName(appDetails);
  const declarations: Record<string, unknown> = {};
  for (const [agentName, tools] of Object.entries(toolsByAgentName)) {
    declarations[agentName] = toSnakeCase(tools);
  }
  return JSON.stringify({tool_declarations: declarations}, null, JSON_INDENT);
}

/**
 * Returns the agent's tool calls, each paired with its response, as a JSON
 * string for a judge model to read. A call that got no response reports the
 * string `None`, as adk-python does.
 */
export function getToolCallsAndResponsesAsJsonStr(
  intermediateData?: IntermediateDataType,
): string {
  const toolCallsWithResponses = getAllToolCallsWithResponses(intermediateData);
  if (toolCallsWithResponses.length === 0) {
    return NO_TOOL_CALLS_TEXT;
  }

  const entries = toolCallsWithResponses.map(
    ([toolCall, toolResponse], step) => ({
      step,
      tool_call: toSnakeCase(toolCall, TOOL_CALL_PAYLOAD_KEYS),
      tool_response: toolResponse
        ? toSnakeCase(toolResponse, TOOL_RESPONSE_PAYLOAD_KEYS)
        : 'None',
    }),
  );
  return JSON.stringify({tool_calls_and_response: entries}, null, JSON_INDENT);
}

/**
 * Returns the grounding metadata the model attached to the invocation's
 * events as a JSON string, for a judge model to read.
 *
 * The step is the index of the event, so it lines up with the agent's own
 * ordering rather than counting only the events that carry metadata.
 */
export function getGroundingMetadataAsJsonStr(
  intermediateData?: IntermediateDataType,
): string {
  if (!isInvocationEvents(intermediateData)) {
    return NO_GROUNDING_METADATA_TEXT;
  }

  const entries = intermediateData.invocationEvents.flatMap((event, step) =>
    event.groundingMetadata === undefined
      ? []
      : [
          {
            step,
            author: event.author,
            grounding_metadata: toSnakeCase(event.groundingMetadata),
          },
        ],
  );
  if (entries.length === 0) {
    return NO_GROUNDING_METADATA_TEXT;
  }
  return JSON.stringify({grounding_metadata: entries}, null, JSON_INDENT);
}

/**
 * Returns the text of an invocation's response, for a judge model to read.
 *
 * @param invocation The invocation to read.
 * @param options.includeIntermediateResponsesInFinal Whether the text an agent
 *   emitted on its way to the final response is read too. The intermediate
 *   text comes first, and the final response text last.
 */
export function getTextFromInvocation(
  invocation: Invocation,
  options: {includeIntermediateResponsesInFinal?: boolean} = {},
): string {
  const finalText = getTextFromContent(invocation.finalResponse);
  if (!options.includeIntermediateResponsesInFinal) {
    return finalText;
  }

  const texts = getIntermediateTexts(invocation);
  if (finalText) {
    texts.push(finalText);
  }
  return texts.join('\n');
}

/** Returns the text an agent emitted before its final response, in order. */
function getIntermediateTexts(invocation: Invocation): string[] {
  const intermediateData = invocation.intermediateData;
  if (intermediateData === undefined) {
    return [];
  }

  const contents = isInvocationEvents(intermediateData)
    ? intermediateData.invocationEvents.map((event) => event.content)
    : intermediateData.intermediateResponses.map(([, parts]) => ({parts}));

  return contents
    .map((content) => getTextFromContent(content))
    .filter((text) => text !== '');
}
