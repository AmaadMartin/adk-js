/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {AppDetails, getToolsByAgentName} from './app_details.js';
import {
  getAllToolCallsWithResponses,
  IntermediateDataType,
  Invocation,
} from './eval_case.js';
import {EvalStatus} from './eval_metrics.js';
import {RubricScore} from './eval_rubrics.js';

/**
 * Labels for an auto-rater response.
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
 * The set of "partially valid" strings the judge may emit. adk-python models
 * these as the tuple value of a single `PARTIALLY_VALID` enum member; here they
 * are an explicit list used where membership is checked.
 */
export const PARTIALLY_VALID_VALUES = [
  'partially_valid',
  'partially valid',
  'partially',
];

/** Returns the arithmetic mean of a non-empty list of numbers. */
export function mean(numbers: number[]): number {
  return numbers.reduce((total, value) => total + value, 0) / numbers.length;
}

function isInvocation(content: Content | Invocation): content is Invocation {
  return 'userContent' in content;
}

/**
 * Extracts text from a `Content` or an `Invocation`.
 *
 * When `content` is a `Content`, returns the concatenated text of its parts.
 *
 * When `content` is an `Invocation`, returns the text of the invocation's final
 * response. If `includeIntermediateResponsesInFinal` is true, text from
 * intermediate invocation events (e.g. natural language emitted before tool
 * calls) is concatenated with the final response text.
 */
export function getTextFromContent(
  content?: Content | Invocation,
  {
    includeIntermediateResponsesInFinal = false,
  }: {includeIntermediateResponsesInFinal?: boolean} = {},
): string | undefined {
  if (content && isInvocation(content)) {
    if (!includeIntermediateResponsesInFinal) {
      // Flag off: revert to basic plain-Content behavior.
      return getTextFromContent(content.finalResponse);
    }

    const parts: string[] = [];
    const intermediate = content.intermediateData;
    if (intermediate && 'invocationEvents' in intermediate) {
      // Walk intermediate events in order; collect text parts.
      for (const event of intermediate.invocationEvents) {
        const text = getTextFromContent(event.content);
        if (text) {
          parts.push(text);
        }
      }
    } else if (intermediate) {
      for (const [, responseParts] of intermediate.intermediateResponses) {
        const text = getTextFromContent({parts: responseParts});
        if (text) {
          parts.push(text);
        }
      }
    }

    // Then fetch the final response text and append it to the end.
    const finalText = getTextFromContent(content.finalResponse);
    if (finalText) {
      parts.push(finalText);
    }

    return parts.length ? parts.join('\n') : undefined;
  }

  if (content && content.parts && content.parts.length > 0) {
    return content.parts
      .map((part) => part.text)
      .filter((text): text is string => !!text)
      .join('\n');
  }

  return undefined;
}

/**
 * Maps a score to an {@link EvalStatus} using an inclusive threshold.
 */
export function getEvalStatus(
  score: number | undefined,
  threshold: number,
): EvalStatus {
  if (score === undefined) {
    return EvalStatus.NOT_EVALUATED;
  }
  return score >= threshold ? EvalStatus.PASSED : EvalStatus.FAILED;
}

/**
 * Returns a single aggregated score from the given rubric scores.
 *
 * Rubric scores without a numeric value are ignored. If none of the rubric
 * scores carry a value, `undefined` is returned; otherwise the mean of the
 * present scores is returned.
 */
export function getAverageRubricScore(
  rubricScores: RubricScore[],
): number | undefined {
  const scores = rubricScores
    .map((rubricScore) => rubricScore.score)
    .filter((score): score is number => score !== undefined);
  return scores.length ? mean(scores) : undefined;
}

/**
 * Returns a JSON string representation of tool declarations, intended to be
 * sent to the judge model.
 */
export function getToolDeclarationsAsJsonStr(appDetails: AppDetails): string {
  return JSON.stringify(
    {toolDeclarations: getToolsByAgentName(appDetails)},
    null,
    2,
  );
}

/**
 * Returns a JSON string representation of tool calls and their corresponding
 * responses, intended to be sent to the judge model.
 *
 * A tool call without a matching response serializes its response as the
 * literal string `"None"`.
 */
export function getToolCallsAndResponsesAsJsonStr(
  intermediateData?: IntermediateDataType,
): string {
  const rawToolCallsAndResponses =
    getAllToolCallsWithResponses(intermediateData);

  if (rawToolCallsAndResponses.length === 0) {
    return 'No intermediate steps were taken.';
  }

  const toolCallsAndResponse = rawToolCallsAndResponses.map(
    ([toolCall, toolResponse], step) => ({
      step,
      toolCall,
      toolResponse: toolResponse ?? 'None',
    }),
  );

  return JSON.stringify({toolCallsAndResponse}, null, 2);
}
