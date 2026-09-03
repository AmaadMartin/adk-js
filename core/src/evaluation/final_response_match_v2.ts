/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InputValidationError} from '../errors/input_validation_error.js';
import {BaseLlm} from '../models/base_llm.js';
import {LlmResponse} from '../models/llm_response.js';
import {experimental} from '../utils/experimental.js';
import {Invocation} from './eval_case.js';
import {EvalStatus, LlmAsAJudgeMetric} from './eval_metrics.js';
import {
  EvaluationResult,
  getEvalStatus,
  getTextFromContent,
  PerInvocationResult,
} from './evaluator.js';
import {LlmAsJudge} from './llm_as_judge.js';
import {
  getTextFromInvocation,
  Label,
  PARTIALLY_VALID_LABELS,
} from './llm_as_judge_utils.js';

/**
 * The prompt the judge model answers. Copied from adk-python, because the
 * wording is what the two runtimes agree on.
 */
const FINAL_RESPONSE_MATCH_V2_PROMPT = `You are an expert rater for an AI agent. The AI agent is going to call an API to answer the user query and generate API tool use code based for the choice of the API and API arguments. The ideal model response should be a function call that fulfills user query, or a natural language response hedges or asks users for further clarification if a function call does not apply.
The primary focus of this rating task is to check correctness of the model responses.

The data consists of:
- A user query.
- A model generated response for the prompt. The responses can consist of:
  - Natural language, when the model is asking for clarification, or tells the user it does not possess the requested functionality / option.
  - Code, in the form of one or multiple python function calls, and additional code as needed, for when the model is fulfilling the user request.
You can use the help from a reference response annotated by a human rater. This reference response is of high quality. You can compare the agent's response with the reference response and decide if the agent's response is valid.
Note sometimes the reference response only contains the key entities of the correct answer and you need to be flexible to allow the agent response to contain more information than the reference response, or to present the key entities in a different format or structure or in shorter or longer format.
When the agent response is provided in the form of tables/dataframes or should be best provided in the form of tables/dataframes: focus on the key entities and main components requested in the user query and check whether you can retrieve those from the agent response. Likewise, if you have the reference response, then find out the key entities and main components in them and check whether you can retrieve those from the agent response. If the prompt does not specify any format instructions and the main items/components are included in the response then tolerate the differences in the formatting of those tables/dataframes.

You should follow the constitutions below very carefully to rate the model response:
- Allow flexibility of format even when reference code only uses one of the possible format, unless API spec or user prompt has explicit format requirement
  - e.g. For state name, allow both abbreviation and full name unless API spec has explicit requirement. e.g. both 'tx' and 'Texas' should be allowed in the agent response even when reference code only uses one of them.
  - e.g. If a reference response list outputs in a list format, the agent response is allowed to use sentence format and vice versa unless user prompt explicitly asks for a specific format.
  - e.g. For numbers, allow flexibility of formatting, e.g. 1000000 vs 1,000,000.
- The model shouldn't assume that it doesn't have access to according data or incapable of answering the question if reference response is able to find a legit answer.
- If the model response contains the correct final answer, rate it as valid even when the model response contains more information than the reference response.
- If the user prompt has csv or other table format data, don't read it yourself. Trust the reference response final answer instead.
- When the validation needs maths, date calculations, do not use your own calculator. Trust the reference response final answer instead.
- Be mindful about unit of numbers. For example, if the reference response says 100 miles, but the model response says 100 km, it is invalid.
- When the agent response or the reference response is provided in the form of tables/dataframes: focus on the key entities and main components requested in the user query and check whether you can retrieve those from the agent response and whether those match the reference response. If the user query does not specify any format instructions and the main items/components are included in the response then tolerate the differences in the formatting of those tables/dataframes.
- When the answer is in numeric format, check whether there are any format requirements in the numeric format, rounding, precision, number of decimals, etc. specified in the user query and the prompt. If there are no such instructions, then tolerate different numerical formats.
- When the answer is in numeric format and there are rounding or precision differences between the agent response and the reference response, if no further instructions are provided evaluate if the rounding strategy or precision in the agent response follows the standards for that entity. For instance, model accuracy scores must be reported with at least two decimal places (e.g., 0.798 → 0.80 is acceptable,  but 0.7 is not).

Below are the inputs:
{{
  "User prompt": {prompt},
  "Agent response": {response},
  "Reference response": {golden_response},
}}

The answer should be a json alone which follows the json structure below:
{{
  "reasoning": [reasoning],
  "is_the_agent_response_valid": [valid or invalid],
}}
Answer with assertiveness:
`;

/** The labels that count the agent's response as invalid. */
const INVALID_LABELS: readonly string[] = [
  Label.INVALID,
  Label.ALMOST,
  Label.FALSE,
  ...PARTIALLY_VALID_LABELS,
];

/** The labels that count the agent's response as valid. */
const VALID_LABELS: readonly string[] = [Label.VALID, Label.TRUE];

/**
 * The label field of the critique. The field ends at a comma, a newline or a
 * closing bracket.
 */
const RESPONSE_VALID_PATTERN =
  /"is_the_agent_response_valid":\s*\[*[\n\s]*"*([^"^\]^\s]*)"*[\n\s]*\]*\s*[,\n}]/;

/** The same field, for a judge that named it after the opposite verdict. */
const RESPONSE_INVALID_PATTERN =
  /"is_the_agent_response_invalid":\s*\[*[\n\s]*"*([^"^\]^\s]*)"*[\n\s]*\]*\s*[,\n}]/;

/** The placeholders the judge prompt template carries. */
const TEMPLATE_PATTERN =
  /\{\{|\}\}|\{prompt\}|\{response\}|\{golden_response\}/g;

/** The text a judge prompt template is filled with. */
export interface AutoRaterPromptValues {
  /** The user's query. */
  prompt: string;

  /** The agent's response, which the judge scores. */
  response: string;

  /** The reference response, which the judge scores against. */
  goldenResponse: string;
}

/**
 * Fills a judge prompt template.
 *
 * The template is written in the notation adk-python's templates use: `{{` and
 * `}}` stand for a literal brace, and `{prompt}`, `{response}` and
 * `{golden_response}` stand for the values.
 */
export function formatAutoRaterPrompt(
  template: string,
  values: AutoRaterPromptValues,
): string {
  const substitutions: Record<string, string> = {
    '{{': '{',
    '}}': '}',
    '{prompt}': values.prompt,
    '{response}': values.response,
    '{golden_response}': values.goldenResponse,
  };
  // A function replacement, because a value containing `$&` or `$1` would
  // otherwise be expanded as a substitution pattern.
  return template.replace(TEMPLATE_PATTERN, (match) => substitutions[match]);
}

/** Returns the label a judge model wrote into its critique. */
export function parseCritique(response: string): Label {
  const validMatch = RESPONSE_VALID_PATTERN.exec(response);
  if (validMatch) {
    const label = trimLabel(validMatch[1]);
    if (INVALID_LABELS.includes(label)) {
      return Label.INVALID;
    }
    return VALID_LABELS.includes(label) ? Label.VALID : Label.NOT_FOUND;
  }

  const invalidMatch = RESPONSE_INVALID_PATTERN.exec(response);
  if (invalidMatch) {
    const label = trimLabel(invalidMatch[1]);
    return label === Label.TRUE || label === Label.INVALID
      ? Label.INVALID
      : Label.VALID;
  }

  return Label.NOT_FOUND;
}

/** Drops the commas and closing braces a label ends with. */
function trimLabel(label: string): string {
  return label.replace(/[,}]+$/, '');
}

/**
 * Scores an agent's final response against a golden one, by asking a judge
 * model whether it is valid.
 *
 * The judge answers valid or invalid, so a sample scores 0 or 1. The samples
 * of one invocation are reduced by majority vote, and the overall score is the
 * fraction of valid invocations, in [0, 1]. A score closer to 1 is more
 * desirable.
 */
@experimental
export class FinalResponseMatchV2Evaluator extends LlmAsJudge {
  constructor(evalMetric: LlmAsAJudgeMetric, judgeModel?: BaseLlm) {
    super(evalMetric, true, judgeModel);
  }

  /**
   * @throws {InputValidationError} When the golden invocation is absent.
   */
  override formatAutoRaterPrompt(
    actual: Invocation,
    expected?: Invocation,
  ): string {
    if (expected === undefined) {
      throw new InputValidationError(
        'expectedInvocation is required for this metric.',
      );
    }

    const options = {
      includeIntermediateResponsesInFinal:
        this.criterion.includeIntermediateResponsesInFinal,
    };
    return formatAutoRaterPrompt(FINAL_RESPONSE_MATCH_V2_PROMPT, {
      prompt: getTextFromContent(expected.userContent),
      response: getTextFromInvocation(actual, options),
      goldenResponse: getTextFromInvocation(expected, options),
    });
  }

  override convertAutoRaterResponseToScore(
    autoRaterResponse: LlmResponse,
  ): number | undefined {
    const label = parseCritique(getTextFromContent(autoRaterResponse.content));
    if (label === Label.VALID) {
      return 1;
    }
    return label === Label.INVALID ? 0 : undefined;
  }

  /**
   * Reduces the samples of one invocation by majority vote, counting a tie as
   * invalid. Samples the judge did not score are ignored, and when it scored
   * none of them the first sample stands.
   */
  override aggregatePerInvocationSamples(
    perInvocationSamples: PerInvocationResult[],
  ): PerInvocationResult {
    const positives = perInvocationSamples.filter(
      (sample) => sample.score === 1,
    );
    const negatives = perInvocationSamples.filter(
      (sample) => sample.score === 0,
    );

    if (positives.length === 0 && negatives.length === 0) {
      return perInvocationSamples[0];
    }
    return positives.length > negatives.length ? positives[0] : negatives[0];
  }

  /** Returns the fraction of the evaluated invocations that are valid. */
  override aggregateInvocationResults(
    perInvocationResults: PerInvocationResult[],
  ): EvaluationResult {
    const scores = perInvocationResults
      .filter((result) => result.evalStatus !== EvalStatus.NOT_EVALUATED)
      .flatMap((result) => (result.score === undefined ? [] : [result.score]));

    if (scores.length === 0) {
      return {
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults,
      };
    }

    const overallScore =
      scores.reduce((total, score) => total + score, 0) / scores.length;
    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.threshold),
      perInvocationResults,
    };
  }
}
