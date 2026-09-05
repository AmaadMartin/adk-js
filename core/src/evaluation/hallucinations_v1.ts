/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';

import {InputValidationError} from '../errors/input_validation_error.js';
import type {BaseLlm} from '../models/base_llm.js';
import type {LlmRequest} from '../models/llm_request.js';
import {LLMRegistry} from '../models/registry.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {toSnakeCase} from '../utils/object_notation_utils.js';
import {getDeveloperInstructions, type AppDetails} from './app_details.js';
import {
  isInvocationEvents,
  type ConversationScenario,
  type Invocation,
  type InvocationEvent,
} from './eval_case.js';
import {
  parseHallucinationsCriterion,
  resolveJudgeModelOptions,
  type EvalMetric,
  type HallucinationsCriterion,
} from './eval_metrics.js';
import {
  emptyEvaluationResult,
  getEvalStatus,
  getTextFromContent,
  validateInvocationLengths,
  type CriterionType,
  type EvaluationResult,
  type Evaluator,
  type PerInvocationResult,
} from './evaluator.js';
import {
  JSON_INDENT,
  formatPromptTemplate,
  getToolDeclarationsAsJsonStr,
} from './llm_as_judge_utils.js';
import {addDefaultRetryOptionsIfNotPresent} from './retry_options_utils.js';

/**
 * Asks the judge model to split a response into sentences.
 *
 * The text is byte-identical to adk-python's, because the two runtimes must
 * agree on what they ask the judge. `{response}` is filled per call.
 */
const SEGMENTER_PROMPT = `You are a helpful and harmless AI assistant. You will be provided with a model-generated response.
Your task is to segment the provided response sentence by sentence so that we could analyze each sentence in the future.

**Instructions:**
1. Overall, you should decompose the whole provided response into individual sentences. You should make sure the output covers ALL the sentences in the provided response block.
2. You should COPY each sentence as it is, WORD BY WORD. DO NOT modify the sentence or the surrounding punctuation.
3. If there are bullet points in the response, you should segment each bullet point into DIFFERENT sentences. If one bullet point has sub bullet points, you should further decompose sub bullet points into DIFFERENT sentences.
For example, if there are responses like "it has three criteria: * aaa. * bbb. * ccc", you should segment them into FOUR sentences: "it has three criteria", "aaa", "bbb", "ccc". Bullet points could start with numbers (1/2/3/etc) or symbols like "*", "-" etc.
4. When encountering tables, you should include the whole table in ONE sentence output.
5. Each sentence should be meaningful to further analyze on. DO NOT ONLY put symbols themselves into a sentence.
6. You should ONLY output segmented sentences in the provided response. DO NOT make up any new sentences.

**Input Format:**

The input will be the model-generated response:
* **Response:** The model-generated response to be analyzed.

**Output Format:**

For each decomposed sentence, wrap them with <sentence> and </sentence> like the following:
<sentence>...</sentence>
<sentence>...</sentence>

**Example:**

**Input:**

**Response Begin**
There are three kinds of fruits:
1. Apples are red.
2. Bananas are green.
3. Pears are purple.

For prices:
* Bananas are cheaper than apples.

Enjoy your fruit!
**Response End**

**Output:**
<sentence>There are three kinds of fruits:</sentence>
<sentence>1. Apples are red.</sentence>
<sentence>2. Bananas are green.</sentence>
<sentence>3. Pears are purple.</sentence>
<sentence>For prices:</sentence>
<sentence>* Bananas are cheaper than apples.</sentence>
<sentence>Enjoy your fruit!</sentence>

**Now, given the following response, please segment the response into sentences:**

**Input:**

**Response Begin**
{response}
**Response End**

**Your Sentence Segmentation Output:**`;

/**
 * Asks the judge model to label each sentence against the context.
 *
 * The text is byte-identical to adk-python's. `{context}` and `{sentences}`
 * are filled per call.
 */
const VALIDATOR_PROMPT = `You are a helpful and harmless AI assistant. You will be provided with a textual context and sentences from a model-generated response.
Your task is to analyze sentence by sentence and classify each sentence according to its relationship with the provided context.

**Instructions:**

1. **Read the textual context carefully.**
2. **For each sentence, assign one of the following labels:**
    * **\`supported\`**: The sentence is entailed by the given context. Provide a supporting excerpt from the context. The supporting except must *fully* entail the sentence.
    * **\`unsupported\`**: The sentence is not entailed by the given context. No excerpt is needed for this label.
    * **\`contradictory\`**: The sentence is falsified by the given context. Provide a contradicting excerpt from the context.
    * **\`disputed\`**: The given context contains both supporting and contradicting information. Provide both supporting and contradicting excerpt from the context.
    * **\`not_applicable\`**: The sentence does not require factual attribution (e.g., opinions, planning steps, greetings, questions, disclaimers, mathematical calculation).
3. **For each label, provide a short rationale explaining your decision.** The rationale should be separate from the excerpt.
4. **Be very strict with your \`supported\`, \`contradictory\` and \`disputed\` decisions.** Unless you can find straightforward, indisputable evidence excepts *in the context* that a sentence is \`supported\`, \`contradictory\` or \`disputed\`, consider it \`unsupported\`.  You should not employ world knowledge unless it is truly trivial.
5. "tool_outputs" blocks contain code execution results of the "tool_code" blocks immediately above them. If any sentence is based on "tool_outputs" results, first analyze if the corresponding "tool_code" is supported and if the results are error-free. Only if the "tool_code" block is supported, you can treat code execution results as correct.
6. If you need to cite multiple supporting excerpts, simply concatenate them. Excerpt could be summary from the context if it is too long.

**Input Format:**

The input will consist of two parts, clearly separated:

* **Context:**  The textual context used to generate the response.
* **Sentences:** The sentences from the model-generated response to be analyzed. Each sentence will be wrapped in <sentence>...</sentence>.

**Output Format:**

For each sentence, output a block of text with the following fields:

* sentence: The sentence being analyzed. Please directly copy the sentence which is provided.
* label: One of \`supported\`, \`unsupported\`, \`contradictory\`, \`disputed\` or \`not_applicable\`.
* rationale: A brief explanation for the assessment
* supporting_excerpt: A relevant excerpt from the context that supports the sentence. Only required for \`supported\` and \`disputed\` labels.
* contradicting_excerpt: A relevant excerpt from the context that contradicts with the sentence. Only required for \`contradictory\` and \`disputed\` labels.

**Example:**

**Input:**

**Context Begin**
Apples are red fruits. Bananas are yellow fruits. Pears are purple fruits. Pears are blue fruits.
**Context End**

**Sentences Begin**
<sentence>Apples are red.</sentence>
<sentence>Bananas are green.</sentence>
<sentence>Pears are purple.</sentence>
<sentence>Bananas are cheaper than apples.</sentence>
<sentence>Enjoy your fruit!</sentence>
**Sentences End**

**Output:**
sentence: Apples are red.
label: supported
rationale: The context explicitly states that apples are red.
supporting_excerpt: Apples are red fruits.
contradicting_excerpt: null

sentence: Bananas are green.
label: contradictory
rationale: The context states that bananas are yellow, not green.
supporting_excerpt: null
contradicting_excerpt: Bananas are yellow fruits.

sentence: Pears are purple.
label: disputed
rationale: The context states that pears are purple but it also states that pears are blue.
supporting_excerpt: Pears are purple fruits
contradicting_excerpt: Pears are blue fruits

sentence: Bananas are cheaper than apples.
label: unsupported
rationale: The context does not mention the price of bananas or apples.
supporting_excerpt: null
contradicting_excerpt: null

sentence: Enjoy your fruit!
label: not_applicable
rationale: This is a general expression and does not require factual attribution.
supporting_excerpt: null
contradicting_excerpt: null

**Now, please analyze the following context and sentences:**

**Input:**

**Context Begin**
{context}
**Context End**

**Sentences Begin**
{sentences}
**Sentences End**

**Output:**`;

/** Labels that count a sentence as grounded. */
const POSITIVE_LABELS: readonly string[] = ['supported', 'not_applicable'];

/** Labels that count a sentence as ungrounded. */
const NEGATIVE_LABELS: readonly string[] = [
  'unsupported',
  'contradictory',
  'disputed',
];

/** What the judge is told when the app declares no tools. */
const NO_TOOLS_TEXT = 'Agent has no tools.';

const SENTENCE_PATTERN = /<sentence>(.*?)<\/sentence>/gs;

/**
 * One block of the validator's report. `$` without the `m` flag means end of
 * input, which is what adk-python's `\Z` means.
 */
const VALIDATION_RESULT_PATTERN =
  /sentence:(.*?)\nlabel:(.*?)\nrationale:(.*?)\nsupporting_excerpt:(.*?)\ncontradicting_excerpt:(.*?)(?=\nsentence:|$)/gis;

/** The context and natural language response evaluated at one step. */
export interface EvaluationStep {
  context: string;
  nlResponse: string;
}

/** One sentence's verdict, as the sentence validator reported it. */
export interface SentenceValidationResult {
  sentence: string;
  label: string;
  rationale: string;
  supportingExcerpt?: string;
  contradictingExcerpt?: string;
}

/** The outcome of grading one natural language response. */
export interface NlResponseEvaluation {
  /**
   * The fraction of labelled sentences that are grounded. Absent when the
   * judge failed, said nothing, or labelled nothing this metric recognises.
   */
  score?: number;

  /**
   * The validator's report, serialized as adk-python serializes it, or the
   * reason there is no score.
   */
  details: string;
}

/** Returns every sentence the segmenter wrapped in a `<sentence>` tag. */
export function parseSentences(responseText: string): string[] {
  return [...responseText.matchAll(SENTENCE_PATTERN)].map(
    ([, sentence]) => sentence,
  );
}

/**
 * Returns the sentence verdicts the validator reported. Text that fits no
 * block yields an empty list, which is how an unparseable report ends up
 * unscored.
 */
export function parseValidationResults(
  responseText: string,
): SentenceValidationResult[] {
  return [...responseText.trim().matchAll(VALIDATION_RESULT_PATTERN)].map(
    ([, sentence, label, rationale, supporting, contradicting]) => ({
      sentence: sentence.trim(),
      label: label.trim(),
      rationale: rationale.trim(),
      supportingExcerpt: parseExcerpt(supporting),
      contradictingExcerpt: parseExcerpt(contradicting),
    }),
  );
}

/** Reads an excerpt field, whose `null` spelling means the judge gave none. */
function parseExcerpt(excerpt: string): string | undefined {
  const trimmed = excerpt.trim();
  return trimmed.toLowerCase() === 'null' ? undefined : trimmed;
}

/** Returns the mean of the values, or `undefined` when there are none. */
function mean(values: number[]): number | undefined {
  if (values.length === 0) {
    return undefined;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Serializes a list of typed SDK values the way a judge model reads them.
 *
 * @param payloadKeys The keys whose value is agent data rather than a typed
 *   field, so that its own keys keep the spelling the agent used.
 */
function toJsonBlock(values: object[], payloadKeys: string[]): string {
  return JSON.stringify(toSnakeCase(values, payloadKeys), null, JSON_INDENT);
}

/**
 * Serializes the verdicts the way adk-python does: snake_case keys, and an
 * explicit `null` for an excerpt the judge did not give.
 */
function toDetails(results: SentenceValidationResult[]): string {
  return JSON.stringify(
    results.map((result) => ({
      sentence: result.sentence,
      label: result.label,
      rationale: result.rationale,
      supporting_excerpt: result.supportingExcerpt ?? null,
      contradicting_excerpt: result.contradictingExcerpt ?? null,
    })),
    null,
    JSON_INDENT,
  );
}

/** Returns the instructions of every agent that carries some, in app order. */
function formatDeveloperInstructions(appDetails: AppDetails): string {
  return Object.keys(appDetails.agentDetails ?? {})
    .flatMap((agentName) => {
      const instructions = getDeveloperInstructions(appDetails, agentName);
      return instructions ? [`${agentName}:\n${instructions}`] : [];
    })
    .join('\n\n');
}

/**
 * Builds the context the sentence validator reads for one step: the developer
 * instructions, the user prompt, the tool declarations, and everything the
 * agent did before the step.
 */
export function createContextForStep(
  appDetails: AppDetails | undefined,
  invocation: Invocation,
  events: InvocationEvent[],
): string {
  const contextParts = [
    `Developer instructions:\n${appDetails ? formatDeveloperInstructions(appDetails) : ''}\n`,
    `User prompt:\n${getTextFromContent(invocation.userContent)}\n`,
    'Tool definitions:',
    `${appDetails ? getToolDeclarationsAsJsonStr(appDetails) : NO_TOOLS_TEXT}\n`,
  ];

  for (const event of events) {
    const parts = event.content?.parts ?? [];
    const texts = parts.flatMap((part) => (part.text ? [part.text] : []));
    const toolCalls = parts.flatMap((part) =>
      part.functionCall ? [part.functionCall] : [],
    );
    const toolResponses = parts.flatMap((part) =>
      part.functionResponse ? [part.functionResponse] : [],
    );

    if (texts.length > 0) {
      contextParts.push(`${texts.join('\n')}\n`);
    }
    if (toolCalls.length > 0) {
      contextParts.push('tool_calls:', `${toJsonBlock(toolCalls, ['args'])}\n`);
    }
    if (toolResponses.length > 0) {
      contextParts.push(
        'tool_outputs:',
        `${toJsonBlock(toolResponses, ['response'])}\n`,
      );
    }
  }

  return contextParts.join('\n');
}

/** Asks the judge one question and returns its first answer, or `undefined`. */
async function askJudge(
  judgeModel: BaseLlm,
  modelConfig: GenerateContentConfig,
  prompt: string,
): Promise<string | undefined> {
  const llmRequest: LlmRequest = {
    // The model that answers, not the one the criterion names: `Gemini` binds
    // the outgoing call to `llmRequest.model` ahead of its own, so a
    // caller-supplied judge would otherwise be sent to the wrong model.
    model: judgeModel.model,
    contents: [{role: 'user', parts: [{text: prompt}]}],
    config: modelConfig,
    liveConnectConfig: {},
    toolsDict: {},
  };
  addDefaultRetryOptionsIfNotPresent(llmRequest);

  // The call is non-streaming, so the first response is the whole answer.
  // Returning out of the loop closes the generator.
  for await (const llmResponse of judgeModel.generateContentAsync(llmRequest)) {
    return getTextFromContent(llmResponse.content);
  }
  return undefined;
}

/** Scores the sentence verdicts, ignoring every label this metric does not know. */
function scoreValidationResults(
  results: SentenceValidationResult[],
): number | undefined {
  const scores = results.flatMap((result) => {
    const label = result.label.trim().toLowerCase();
    if (POSITIVE_LABELS.includes(label)) {
      return [1];
    }
    if (NEGATIVE_LABELS.includes(label)) {
      return [0];
    }
    logger.debug(`Unexpected label: ${label}`);
    return [];
  });
  return mean(scores);
}

/**
 * Grades one natural language response against its context, by segmenting it
 * into sentences and then labelling each sentence.
 *
 * A judge that fails, says nothing, or answers unintelligibly leaves the
 * response unscored. It never throws.
 */
export async function evaluateNlResponse(
  judgeModel: BaseLlm,
  modelConfig: GenerateContentConfig,
  nlResponse: string,
  context: string,
): Promise<NlResponseEvaluation> {
  let sentences: string[];
  try {
    const segmenterText = await askJudge(
      judgeModel,
      modelConfig,
      formatPromptTemplate(SEGMENTER_PROMPT, {response: nlResponse}),
    );
    if (segmenterText === undefined) {
      return {details: 'Segmenter returned no text.'};
    }
    sentences = parseSentences(segmenterText);
  } catch (error: unknown) {
    return {details: `Error during sentence segmentation: ${toMessage(error)}`};
  }

  if (sentences.length === 0) {
    return {details: 'No sentences produced by segmenter.'};
  }

  const sentencesStr = sentences
    .map((sentence) => `<sentence>${sentence}</sentence>`)
    .join('\n');

  let validationResults: SentenceValidationResult[];
  try {
    const validatorText = await askJudge(
      judgeModel,
      modelConfig,
      formatPromptTemplate(VALIDATOR_PROMPT, {
        context,
        sentences: sentencesStr,
      }),
    );
    if (validatorText === undefined) {
      return {details: 'Sentence validator returned no text.'};
    }
    validationResults = parseValidationResults(validatorText);
  } catch (error: unknown) {
    return {details: `Error during sentence validation: ${toMessage(error)}`};
  }

  return {
    score: scoreValidationResults(validationResults),
    details: toDetails(validationResults),
  };
}

/** Returns the message of a thrown value, whatever it is. */
function toMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns the criterion a metric carries, as the type this evaluator declares.
 *
 * @throws {InputValidationError} Naming the metric, when the criterion is not
 *   of that type.
 */
function validateCriterion(evalMetric: EvalMetric): HallucinationsCriterion {
  const criterionType = HallucinationsV1Evaluator.criterionType;
  try {
    return criterionType.validate(evalMetric.criterion);
  } catch (error: unknown) {
    throw new InputValidationError(
      `\`${evalMetric.metricName}\` metric expects a criterion of type` +
        ` \`${criterionType.name}\`. ${toMessage(error)}`,
      {cause: error},
    );
  }
}

/**
 * Scores an agent's natural language responses for claims their context does
 * not support.
 *
 * Each response is graded in two steps: the judge model segments it into
 * sentences, then labels each sentence against the context the agent had.
 * The score is the Accuracy Score, the fraction of labelled sentences that
 * are supported or need no support, in [0, 1]. A score closer to 1 is more
 * desirable.
 */
@experimental
export class HallucinationsV1Evaluator implements Evaluator {
  /** The criterion type a metric must carry for this evaluator to read it. */
  static readonly criterionType: CriterionType<HallucinationsCriterion> = {
    name: 'HallucinationsCriterion',
    validate: parseHallucinationsCriterion,
  };

  private readonly criterion: HallucinationsCriterion;
  private readonly judgeModel: BaseLlm;
  private readonly modelConfig: GenerateContentConfig;

  /**
   * @param evalMetric The metric to score, carrying a
   *   {@link HallucinationsCriterion}.
   * @param judgeModel The model to grade with. Resolved from `LLMRegistry`
   *   when absent. Supply one to grade against a model the registry does not
   *   own.
   * @throws {InputValidationError} When the metric carries a criterion this
   *   evaluator cannot read.
   */
  constructor(evalMetric: EvalMetric, judgeModel?: BaseLlm) {
    this.criterion = validateCriterion(evalMetric);
    const judgeModelOptions = resolveJudgeModelOptions(
      this.criterion.judgeModelOptions,
    );
    this.judgeModel =
      judgeModel ?? LLMRegistry.newLlm(judgeModelOptions.judgeModel);
    this.modelConfig = judgeModelOptions.judgeModelConfig ?? {};
  }

  /**
   * @param actualInvocations The invocations obtained from the agent under
   *   test.
   * @param expectedInvocations Golden invocations. This metric does not read
   *   them, and reports each one on its invocation's result.
   * @throws {InputValidationError} When both lists are present and their
   *   lengths differ.
   */
  async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    _conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    validateInvocationLengths(actualInvocations, expectedInvocations);

    const perInvocationResults: PerInvocationResult[] = [];
    for (const [index, actual] of actualInvocations.entries()) {
      const score = await this.evaluateSteps(this.getStepsToEvaluate(actual));
      perInvocationResults.push({
        actualInvocation: actual,
        expectedInvocation: expectedInvocations?.[index],
        score,
        evalStatus: getEvalStatus(score, this.criterion.threshold),
        rubricScores: [],
      });
    }

    if (perInvocationResults.length === 0) {
      return emptyEvaluationResult();
    }

    const overallScore = mean(
      perInvocationResults.flatMap((result) =>
        result.score === undefined ? [] : [result.score],
      ),
    );
    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.criterion.threshold),
      perInvocationResults,
    };
  }

  /** Grades the steps one at a time, as adk-python does, and takes the mean. */
  private async evaluateSteps(
    steps: EvaluationStep[],
  ): Promise<number | undefined> {
    const scores: number[] = [];
    for (const step of steps) {
      const {score} = await evaluateNlResponse(
        this.judgeModel,
        this.modelConfig,
        step.nlResponse,
        step.context,
      );
      if (score !== undefined) {
        scores.push(score);
      }
    }
    return mean(scores);
  }

  /**
   * Gathers the natural language responses to grade, each with the context
   * the agent had when it produced it.
   */
  private getStepsToEvaluate(actual: Invocation): EvaluationStep[] {
    const allEvents = isInvocationEvents(actual.intermediateData)
      ? actual.intermediateData.invocationEvents
      : [];

    const steps: EvaluationStep[] = [];
    let eventsForContext: InvocationEvent[] = allEvents;

    if (this.criterion.evaluateIntermediateNlResponses) {
      eventsForContext = [];
      for (const event of allEvents) {
        const texts = (event.content?.parts ?? []).flatMap((part) =>
          part.text ? [part.text] : [],
        );
        if (texts.length > 0) {
          const context = createContextForStep(
            actual.appDetails,
            actual,
            eventsForContext,
          );
          steps.push(...texts.map((nlResponse) => ({context, nlResponse})));
        }
        eventsForContext.push(event);
      }
    }

    const finalResponseText = getTextFromContent(actual.finalResponse);
    if (finalResponseText) {
      steps.push({
        context: createContextForStep(
          actual.appDetails,
          actual,
          eventsForContext,
        ),
        nlResponse: finalResponseText,
      });
    }
    return steps;
  }
}
