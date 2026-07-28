/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmResponse} from '../models/llm_response.js';
import {experimental} from '../utils/experimental.js';

import {Invocation} from './eval_case.js';
import {
  EvalMetric,
  LlmAsAJudgeCriterion,
  LlmAsAJudgeCriterionSchema,
} from './eval_metrics.js';
import {
  EvalStatus,
  EvaluationResult,
  PerInvocationResult,
} from './evaluator.js';
import {AutoRaterScore, LlmAsJudge} from './llm_as_judge.js';
import {
  getEvalStatus,
  getTextFromContent,
  Label,
  PARTIALLY_VALID_VALUES,
} from './llm_as_judge_utils.js';

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

/**
 * Substitutes `{name}` fields and unescapes `{{`/`}}` in a template, mirroring
 * the subset of Python's `str.format` used by the auto-rater prompt.
 */
function formatTemplate(
  template: string,
  values: {prompt: string; response: string; goldenResponse: string},
): string {
  const substitutions: Record<string, string> = {
    prompt: values.prompt,
    response: values.response,
    golden_response: values.goldenResponse,
  };
  return template.replace(/\{\{|\}\}|\{(\w+)\}/g, (match, name?: string) => {
    if (match === '{{') return '{';
    if (match === '}}') return '}';
    return substitutions[name as string];
  });
}

/**
 * Parses the judge model critique and extracts the final label.
 *
 * @returns The extracted label: `VALID`, `INVALID`, or `NOT_FOUND`.
 */
export function parseCritique(response: string): Label {
  // Regex matching the label field in the response. The end of the field is
  // identified by either a comma, new line, or an end-bracket.
  const labelMatchIsResponseValid = response.match(
    /"is_the_agent_response_valid":\s*\[*[\n\s]*"*([^"^\]^\s]*)"*[\n\s]*\]*\s*[,\n}]/,
  );
  // In case the model names the label field as "is_the_agent_response_*invalid*"
  // instead of "..._*valid*".
  const labelMatchIsResponseInvalid = response.match(
    /"is_the_agent_response_invalid":\s*\[*[\n\s]*"*([^"^\]^\s]*)"*[\n\s]*\]*\s*[,\n}]/,
  );
  // Remove any trailing whitespace, commas, or end-brackets from the label.
  if (labelMatchIsResponseValid) {
    const label = labelMatchIsResponseValid[1].trim().replace(/[,}]+$/, '');
    const invalidLabels: string[] = [
      Label.INVALID,
      Label.ALMOST,
      Label.FALSE,
      ...PARTIALLY_VALID_VALUES,
    ];
    if (invalidLabels.includes(label)) {
      return Label.INVALID;
    }
    if (([Label.VALID, Label.TRUE] as string[]).includes(label)) {
      return Label.VALID;
    }
    return Label.NOT_FOUND;
  }
  if (labelMatchIsResponseInvalid) {
    const label = labelMatchIsResponseInvalid[1].trim().replace(/[,}]+$/, '');
    return ([Label.TRUE, Label.INVALID] as string[]).includes(label)
      ? Label.INVALID
      : Label.VALID;
  }
  return Label.NOT_FOUND;
}

/**
 * V2 final response match evaluator which uses an LLM to judge responses.
 *
 * The evaluator prompts the LLM to output whether the agent final response is
 * valid or invalid, hence outputs a score of 0 or 1. Repeated invocation samples
 * are aggregated by taking a majority vote, and the overall score is the
 * fraction (0..1) of valid samples. Higher overall scores indicate better final
 * response performance of the agent.
 */
@experimental
export class FinalResponseMatchV2Evaluator extends LlmAsJudge<LlmAsAJudgeCriterion> {
  /** Overridable so tests can inject a small template. */
  protected autoRaterPromptTemplate = FINAL_RESPONSE_MATCH_V2_PROMPT;

  constructor(evalMetric: EvalMetric) {
    super(evalMetric, LlmAsAJudgeCriterionSchema, 'LlmAsAJudgeCriterion', true);
  }

  override formatAutoRaterPrompt(
    actualInvocation: Invocation,
    expectedInvocation?: Invocation,
  ): string {
    if (expectedInvocation === undefined) {
      throw new Error('expectedInvocation is required for this metric.');
    }

    const includeIntermediate =
      this.criterion.includeIntermediateResponsesInFinal;
    const reference = getTextFromContent(expectedInvocation, {
      includeIntermediateResponsesInFinal: includeIntermediate,
    });
    const response = getTextFromContent(actualInvocation, {
      includeIntermediateResponsesInFinal: includeIntermediate,
    });
    const userPrompt = getTextFromContent(expectedInvocation.userContent);
    return formatTemplate(this.autoRaterPromptTemplate, {
      prompt: userPrompt ?? '',
      response: response ?? '',
      goldenResponse: reference ?? '',
    });
  }

  override convertAutoRaterResponseToScore(
    llmResponse: LlmResponse,
  ): AutoRaterScore {
    const responseText = getTextFromContent(llmResponse.content);
    if (responseText === undefined) {
      return {};
    }
    const label = parseCritique(responseText);
    if (label === Label.VALID) {
      return {score: 1.0};
    }
    if (label === Label.INVALID) {
      return {score: 0.0};
    }
    return {};
  }

  override aggregatePerInvocationSamples(
    perInvocationSamples: PerInvocationResult[],
  ): PerInvocationResult {
    // Majority vote over successfully-evaluated results. On a tie, or when no
    // result was evaluated, prefer the first invalid / first sample.
    const positiveResults = perInvocationSamples.filter((r) => r.score === 1.0);
    const negativeResults = perInvocationSamples.filter((r) => r.score === 0.0);
    if (positiveResults.length === 0 && negativeResults.length === 0) {
      return perInvocationSamples[0];
    }
    if (positiveResults.length > negativeResults.length) {
      return positiveResults[0];
    }
    return negativeResults[0];
  }

  override aggregateInvocationResults(
    perInvocationResults: PerInvocationResult[],
  ): EvaluationResult {
    // Computes the fraction of invocation results that are valid.
    let numValid = 0;
    let numEvaluated = 0;
    for (const result of perInvocationResults) {
      if (
        result.score === undefined ||
        result.evalStatus === EvalStatus.NOT_EVALUATED
      ) {
        continue;
      }
      numEvaluated += 1;
      numValid += result.score;
    }

    if (numEvaluated === 0) {
      return {
        overallScore: undefined,
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults,
      };
    }

    const overallScore = numValid / numEvaluated;
    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.criterion.threshold),
      perInvocationResults,
    };
  }
}
