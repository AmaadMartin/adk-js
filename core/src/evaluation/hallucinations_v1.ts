/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionCall,
  FunctionResponse,
  GenerateContentConfig,
} from '@google/genai';

import {BaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';
import {LlmResponse} from '../models/llm_response.js';
import {LLMRegistry} from '../models/registry.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {AppDetails, getDeveloperInstructions} from './app_details.js';
import {ConversationScenario} from './conversation_scenarios.js';
import {Invocation, InvocationEvent} from './eval_case.js';
import {
  EvalMetric,
  HallucinationsCriterion,
  HallucinationsCriterionSchema,
} from './eval_metrics.js';
import {
  EvalStatus,
  EvaluationResult,
  Evaluator,
  PerInvocationResult,
  validateInvocationLengths,
} from './evaluator.js';
import {
  getEvalStatus,
  getTextFromContent,
  getToolDeclarationsAsJsonStr,
  mean,
} from './llm_as_judge_utils.js';
import {addDefaultRetryOptionsIfNotPresent} from './retry_options_utils.js';

const HALLUCINATIONS_V1_SEGMENTER_PROMPT = `
You are a helpful and harmless AI assistant. You will be provided with a model-generated response.
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

**Your Sentence Segmentation Output:**
`.trim();

const HALLUCINATIONS_V1_VALIDATOR_PROMPT = `
You are a helpful and harmless AI assistant. You will be provided with a textual context and sentences from a model-generated response.
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

**Output:**
`.trim();

const POSITIVE_LABELS = new Set(['supported', 'not_applicable']);
const NEGATIVE_LABELS = new Set(['unsupported', 'contradictory', 'disputed']);

/**
 * The context and natural language response to be evaluated at a single step.
 */
export interface EvaluationStep {
  readonly context: string;
  readonly nlResponse: string;
}

/** Parses sentences wrapped in `<sentence>...</sentence>` from an LLM response. */
export function parseSentences(responseText: string): string[] {
  return [...responseText.matchAll(/<sentence>(.*?)<\/sentence>/gs)].map(
    (match) => match[1],
  );
}

/**
 * Parses sentence validation results from an LLM response. Excerpt fields whose
 * value is `null` (case-insensitive) are mapped to `undefined`.
 */
export function parseValidationResults(responseText: string): Array<{
  sentence: string;
  label: string;
  rationale: string;
  supportingExcerpt?: string;
  contradictingExcerpt?: string;
}> {
  const pattern =
    /sentence:(.*?)\nlabel:(.*?)\nrationale:(.*?)\nsupporting_excerpt:(.*?)\ncontradicting_excerpt:(.*?)(?=\nsentence:|$)/gis;
  const results = [];
  for (const match of responseText.trim().matchAll(pattern)) {
    const [, sentence, label, rationale, supExc, conExc] = match;
    results.push({
      sentence: sentence.trim(),
      label: label.trim(),
      rationale: rationale.trim(),
      supportingExcerpt:
        supExc.trim().toLowerCase() !== 'null' ? supExc.trim() : undefined,
      contradictingExcerpt:
        conExc.trim().toLowerCase() !== 'null' ? conExc.trim() : undefined,
    });
  }
  return results;
}

/**
 * Creates the context string for sentence validation from a list of events.
 *
 * The context is composed of a header block (developer instructions, user
 * prompt, tool definitions) followed by one step-block per preceding event
 * (natural language, tool calls, and tool outputs).
 */
export function createContextForStep(
  appDetails: AppDetails | undefined,
  invocation: Invocation,
  events: InvocationEvent[],
): string {
  let developerInstructions = '';
  let toolDeclarations = 'Agent has no tools.';
  if (appDetails) {
    const instructions: string[] = [];
    for (const agentName of Object.keys(appDetails.agentDetails)) {
      const agentInstructions = getDeveloperInstructions(appDetails, agentName);
      if (agentInstructions) {
        instructions.push(`${agentName}:\n${agentInstructions}`);
      }
    }
    developerInstructions = instructions.join('\n\n');
    toolDeclarations = getToolDeclarationsAsJsonStr(appDetails);
  }

  const contextParts: string[] = [];
  contextParts.push(`Developer instructions:\n${developerInstructions}\n`);
  contextParts.push(
    `User prompt:\n${getTextFromContent(invocation.userContent) ?? ''}\n`,
  );
  contextParts.push('Tool definitions:');
  contextParts.push(`${toolDeclarations}\n`);

  for (const event of events) {
    if (!event.content || !event.content.parts) {
      continue;
    }
    const toolCalls = event.content.parts
      .map((part) => part.functionCall)
      .filter((call): call is FunctionCall => !!call);
    const toolResponses = event.content.parts
      .map((part) => part.functionResponse)
      .filter((response): response is FunctionResponse => !!response);
    const nlResponses = event.content.parts
      .map((part) => part.text)
      .filter((text): text is string => !!text);

    if (nlResponses.length) {
      contextParts.push(nlResponses.join('\n') + '\n');
    }
    if (toolCalls.length) {
      contextParts.push('tool_calls:');
      contextParts.push(JSON.stringify(toolCalls, null, 2) + '\n');
    }
    if (toolResponses.length) {
      contextParts.push('tool_outputs:');
      contextParts.push(JSON.stringify(toolResponses, null, 2) + '\n');
    }
  }

  return contextParts.join('\n');
}

async function readFirstResponse(
  generator: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse> {
  // Returning from the for-await auto-closes the generator (parity with
  // adk-python reading a single value under `Aclosing`).
  for await (const response of generator) {
    return response;
  }
  throw new Error('Judge model returned no response.');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Evaluates whether a model response contains false, contradictory, or
 * unsupported claims.
 *
 * The metric follows a two-step process:
 * 1. Segmenter: segments the agent response into individual sentences.
 * 2. Sentence validator: evaluates each sentence against the provided context
 *    for grounding.
 *
 * The metric computes the accuracy score: the fraction of sentences that are
 * supported or not_applicable.
 */
@experimental
export class HallucinationsV1Evaluator extends Evaluator {
  protected readonly criterion: HallucinationsCriterion;
  protected readonly judgeModel: BaseLlm;
  protected readonly threshold: number;
  private readonly model: string;
  private readonly modelConfig: GenerateContentConfig;

  constructor(evalMetric: EvalMetric) {
    super();

    const expectedCriterionTypeError = new Error(
      `\`${evalMetric.metricName}\` metric expects a criterion of type ` +
        '`HallucinationsCriterion`.',
    );
    if (!evalMetric.criterion) {
      throw expectedCriterionTypeError;
    }
    const parsedCriterion = HallucinationsCriterionSchema.safeParse(
      evalMetric.criterion,
    );
    if (!parsedCriterion.success) {
      throw expectedCriterionTypeError;
    }

    this.criterion = parsedCriterion.data;
    this.threshold = evalMetric.threshold ?? this.criterion.threshold;
    this.model = this.criterion.judgeModelOptions.judgeModel;
    this.modelConfig = this.criterion.judgeModelOptions.judgeModelConfig ?? {};
    this.judgeModel = LLMRegistry.newLlm(this.model);
  }

  /**
   * Runs segmentation and validation for a single natural language response,
   * returning the accuracy score (or `undefined`) and a diagnostic message.
   */
  async evaluateNlResponse(
    nlResponse: string,
    context: string,
  ): Promise<[number | undefined, string]> {
    const segmenterRequest: LlmRequest = {
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: HALLUCINATIONS_V1_SEGMENTER_PROMPT.replace(
                '{response}',
                () => nlResponse,
              ),
            },
          ],
        },
      ],
      config: this.modelConfig,
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(segmenterRequest);

    let sentences: string[];
    try {
      const segmenterResponse = await readFirstResponse(
        this.judgeModel.generateContentAsync(segmenterRequest, false),
      );
      sentences = parseSentences(
        getTextFromContent(segmenterResponse.content) ?? '',
      );
    } catch (error) {
      return [
        undefined,
        `Error during sentence segmentation: ${errorMessage(error)}`,
      ];
    }

    if (sentences.length === 0) {
      return [undefined, 'No sentences produced by segmenter.'];
    }

    const sentencesStr = sentences
      .map((sentence) => `<sentence>${sentence}</sentence>`)
      .join('\n');

    const validatorRequest: LlmRequest = {
      model: this.model,
      contents: [
        {
          role: 'user',
          parts: [
            {
              text: HALLUCINATIONS_V1_VALIDATOR_PROMPT.replace(
                '{context}',
                () => context,
              ).replace('{sentences}', () => sentencesStr),
            },
          ],
        },
      ],
      config: this.modelConfig,
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(validatorRequest);

    let validationResults: ReturnType<typeof parseValidationResults>;
    try {
      const validatorResponse = await readFirstResponse(
        this.judgeModel.generateContentAsync(validatorRequest, false),
      );
      validationResults = parseValidationResults(
        getTextFromContent(validatorResponse.content) ?? '',
      );
    } catch (error) {
      return [
        undefined,
        `Error during sentence validation: ${errorMessage(error)}`,
      ];
    }

    const scores: number[] = [];
    for (const result of validationResults) {
      const label = result.label.trim().toLowerCase();
      if (POSITIVE_LABELS.has(label)) {
        scores.push(1);
      } else if (NEGATIVE_LABELS.has(label)) {
        scores.push(0);
      } else {
        logger.debug(`Unexpected label: ${label}`);
      }
    }

    const accuracyScore = scores.length ? mean(scores) : undefined;
    return [accuracyScore, JSON.stringify(validationResults, null, 2)];
  }

  private getStepsToEvaluate(actual: Invocation): EvaluationStep[] {
    const stepEvaluations: EvaluationStep[] = [];
    const eventsForContext: InvocationEvent[] = [];
    let allEvents: InvocationEvent[] = [];
    const intermediate = actual.intermediateData;
    if (intermediate && 'invocationEvents' in intermediate) {
      allEvents = intermediate.invocationEvents;
    }

    if (this.criterion.evaluateIntermediateNlResponses) {
      for (const event of allEvents) {
        const nlParts =
          event.content && event.content.parts
            ? event.content.parts
                .map((part) => part.text)
                .filter((text): text is string => !!text)
            : [];
        if (nlParts.length) {
          const context = createContextForStep(
            actual.appDetails,
            actual,
            eventsForContext,
          );
          for (const nlResponse of nlParts) {
            stepEvaluations.push({nlResponse, context});
          }
        }
        eventsForContext.push(event);
      }
    } else {
      eventsForContext.push(...allEvents);
    }

    const finalResponseText = getTextFromContent(actual.finalResponse);
    if (finalResponseText) {
      const context = createContextForStep(
        actual.appDetails,
        actual,
        eventsForContext,
      );
      stepEvaluations.push({nlResponse: finalResponseText, context});
    }
    return stepEvaluations;
  }

  private aggregateInvocationResults(
    perInvocationResults: PerInvocationResult[],
  ): EvaluationResult {
    const scores = perInvocationResults
      .map((result) => result.score)
      .filter((score): score is number => score !== undefined);
    if (scores.length === 0) {
      return {
        overallScore: undefined,
        overallEvalStatus: EvalStatus.NOT_EVALUATED,
        perInvocationResults,
      };
    }

    const overallScore = mean(scores);
    return {
      overallScore,
      overallEvalStatus: getEvalStatus(overallScore, this.threshold),
      perInvocationResults,
    };
  }

  override async evaluateInvocations(
    actualInvocations: Invocation[],
    expectedInvocations?: Invocation[],
    conversationScenario?: ConversationScenario,
  ): Promise<EvaluationResult> {
    void conversationScenario; // not used by this metric.
    validateInvocationLengths(actualInvocations, expectedInvocations);

    const expected: Array<Invocation | undefined> =
      expectedInvocations ?? actualInvocations.map(() => undefined);

    const perInvocationResults: PerInvocationResult[] = [];
    for (let i = 0; i < actualInvocations.length; i++) {
      const actual = actualInvocations[i];
      const expectedInvocation = expected[i];
      const stepEvaluations = this.getStepsToEvaluate(actual);

      if (stepEvaluations.length === 0) {
        perInvocationResults.push({
          actualInvocation: actual,
          expectedInvocation,
          score: undefined,
          evalStatus: EvalStatus.NOT_EVALUATED,
          rubricScores: [],
        });
        continue;
      }

      const scoresPerStep: number[] = [];
      for (const step of stepEvaluations) {
        const [fsScore] = await this.evaluateNlResponse(
          step.nlResponse,
          step.context,
        );
        if (fsScore !== undefined) {
          scoresPerStep.push(fsScore);
        }
      }

      const invocationScore = scoresPerStep.length
        ? mean(scoresPerStep)
        : undefined;
      perInvocationResults.push({
        actualInvocation: actual,
        expectedInvocation,
        score: invocationScore,
        evalStatus: getEvalStatus(invocationScore, this.threshold),
        rubricScores: [],
      });
    }

    // aggregateInvocationResults already yields NOT_EVALUATED with an empty
    // result list when there are no per-invocation results.
    return this.aggregateInvocationResults(perInvocationResults);
  }
}
