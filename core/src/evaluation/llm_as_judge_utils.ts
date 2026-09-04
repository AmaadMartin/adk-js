/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {toSnakeCase} from '../utils/object_notation_utils.js';
import {getToolsByAgentName, type AppDetails} from './app_details.js';
import {isInvocationEvents, type Invocation} from './eval_case.js';
import {getTextFromContent} from './evaluator.js';

/** The indent of the JSON a judge model reads, matching adk-python. */
export const JSON_INDENT = 2;

/**
 * The labels a judge model writes into its critique.
 *
 * The values are compared against model output, so they match adk-python
 * exactly.
 */
export enum Label {
  TRUE = 'true',
  INVALID = 'invalid',
  VALID = 'valid',
  ALMOST = 'almost',
  FALSE = 'false',
  NOT_FOUND = 'label field not found',
}

/**
 * The spellings a judge model uses for a partly valid response, which counts
 * as invalid.
 *
 * adk-python holds these on a multi-valued `Label.PARTIALLY_VALID` member. A
 * TypeScript enum member holds one string, so they live beside the enum.
 */
export const PARTIALLY_VALID_LABELS: readonly string[] = [
  'partially_valid',
  'partially valid',
  'partially',
];

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
