/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import type {LlmAgent} from '../agents/llm_agent.js';
import {addDefaultRetryOptionsIfNotPresent} from '../evaluation/retry_options_utils.js';
import type {BaseLlm} from '../models/base_llm.js';
import type {LlmRequest} from '../models/llm_request.js';
import {LLMRegistry} from '../models/registry.js';
import {logger} from '../utils/logger.js';

import {AgentOptimizer, type OptimizeParams} from './agent_optimizer.js';
import type {
  AgentWithScores,
  OptimizerResult,
  UnstructuredSamplingResult,
} from './data_types.js';
import {Sampler} from './sampler.js';

/** Model that rewrites the instruction when the caller names none. */
const DEFAULT_OPTIMIZER_MODEL = 'gemini-2.5-flash';

/** Optimization rounds run when the caller asks for no particular number. */
const DEFAULT_NUM_ITERATIONS = 10;

/** Training examples scored per candidate when the caller sets no batch size. */
const DEFAULT_BATCH_SIZE = 5;

/** Thinking tokens the optimizer model may spend per rewrite. */
const DEFAULT_THINKING_BUDGET = 10240;

/**
 * Prompt sent to the optimizer model, held verbatim from
 * `_OPTIMIZER_PROMPT_TEMPLATE` in adk-python.
 */
const OPTIMIZER_PROMPT_TEMPLATE = `
You are an expert prompt engineer. Your task is to improve the system prompt for an AI agent.
The agent's current prompt achieved an average score of {currentScore} on a set of evaluation tasks. A higher score is better.

Here is the current prompt:
<current_prompt>
{currentPromptText}
</current_prompt>

Based on the current prompt, rewrite it to create a new, improved version that is likely to achieve a higher score.
The agent needs to solve customer support tasks by using tools correctly and following policies.
Focus on clarity, structure, and providing actionable guidance for the agent.

**Output only the new, full, improved agent prompt. Do not add any other text, explanations, or markdown formatting.**
`;

/** Configuration for {@link SimplePromptOptimizer}. */
export interface SimplePromptOptimizerConfig {
  /** Model used to rewrite the instruction. Defaults to `'gemini-2.5-flash'`. */
  optimizerModel?: string;

  /**
   * Config for the optimizer model. Defaults to a thinking config with
   * `includeThoughts: true` and a thinking budget of 10240 tokens.
   */
  modelConfiguration?: GenerateContentConfig;

  /** Number of optimization rounds. Defaults to 10. */
  numIterations?: number;

  /** Training examples used to score each candidate. Defaults to 5. */
  batchSize?: number;
}

/**
 * Reads an agent's instruction as a string.
 *
 * @param agent The agent whose instruction to read.
 * @returns The instruction text.
 * @throws If the instruction is an `InstructionProvider`, because the optimizer
 *     rewrites instruction text and has nothing to rewrite in a function.
 */
function requireStringInstruction(agent: LlmAgent): string {
  if (typeof agent.instruction !== 'string') {
    throw new Error(
      `SimplePromptOptimizer only supports a string instruction, but agent ` +
        `'${agent.name}' carries an InstructionProvider.`,
    );
  }
  return agent.instruction;
}

/**
 * Draws `k` distinct items, matching Python's `random.sample`.
 *
 * Callers must pass `k <= items.length`; {@link SimplePromptOptimizer} keeps to
 * that by taking `Math.min` of the batch size and the set it draws from.
 */
function randomSample<T>(items: readonly T[], k: number): T[] {
  const pool = [...items];
  for (let i = 0; i < k; i++) {
    const j = i + Math.floor(Math.random() * (pool.length - i));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, k);
}

/** Averages a score map, answering 0 for an empty one rather than `NaN`. */
function meanScore(scores: Record<string, number>): number {
  const values = Object.values(scores);
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * Fills the optimizer prompt with the current score and instruction.
 *
 * Both substitutions use a replacer function. A string replacement expands
 * `$&`, `` $` ``, `$'` and `$1`, and the instruction is arbitrary user text
 * that may contain any of them.
 */
function renderOptimizerPrompt(
  currentScore: number,
  currentPromptText: string,
): string {
  return OPTIMIZER_PROMPT_TEMPLATE.replace('{currentScore}', () =>
    currentScore.toFixed(2),
  ).replace('{currentPromptText}', () => currentPromptText);
}

/**
 * A naive optimizer that iteratively tries to improve an agent's instruction.
 *
 * Each round asks an optimizer model to rewrite the current best instruction,
 * then scores the rewrite on a random batch of training examples. A rewrite
 * replaces the incumbent only when it scores strictly higher.
 *
 * The run is expensive and makes real calls. With the defaults it invokes the
 * sampler 12 times and the optimizer model 10 times, so run it as an offline
 * batch job rather than at request time.
 */
export class SimplePromptOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithScores
> {
  private readonly llm: BaseLlm;
  private readonly optimizerModel: string;
  private readonly modelConfiguration: GenerateContentConfig;
  private readonly numIterations: number;
  private readonly batchSize: number;

  constructor(config: SimplePromptOptimizerConfig = {}) {
    super();
    this.optimizerModel = config.optimizerModel ?? DEFAULT_OPTIMIZER_MODEL;
    this.modelConfiguration = config.modelConfiguration ?? {
      thinkingConfig: {
        includeThoughts: true,
        thinkingBudget: DEFAULT_THINKING_BUDGET,
      },
    };
    this.numIterations = config.numIterations ?? DEFAULT_NUM_ITERATIONS;
    this.batchSize = config.batchSize ?? DEFAULT_BATCH_SIZE;
    this.llm = LLMRegistry.newLlm(this.optimizerModel);
  }

  override async optimize({
    initialAgent,
    sampler,
  }: OptimizeParams<UnstructuredSamplingResult>): Promise<
    OptimizerResult<AgentWithScores>
  > {
    requireStringInstruction(initialAgent);

    const trainExampleIds = sampler.getTrainExampleIds();
    if (this.batchSize > trainExampleIds.length) {
      logger.warn(
        `Batch size (${this.batchSize}) is larger than the number of training ` +
          `examples (${trainExampleIds.length}). Using all training examples ` +
          `for each evaluation.`,
      );
    }

    const bestAgent = await this.runOptimizationIterations(
      initialAgent,
      sampler,
      trainExampleIds,
    );
    const finalScore = await this.runFinalValidation(bestAgent, sampler);
    logger.debug(`Final validation score: ${finalScore}`);

    return {
      optimizedAgents: [{optimizedAgent: bestAgent, overallScore: finalScore}],
    };
  }

  /** Runs the search loop and returns the highest-scoring agent it found. */
  private async runOptimizationIterations(
    initialAgent: LlmAgent,
    sampler: Sampler<UnstructuredSamplingResult>,
    trainExampleIds: string[],
  ): Promise<LlmAgent> {
    let bestAgent = initialAgent;
    let bestScore = await this.scoreAgentOnBatch(
      bestAgent,
      sampler,
      trainExampleIds,
    );
    logger.debug(`Initial agent baseline score: ${bestScore}`);

    for (let i = 0; i < this.numIterations; i++) {
      logger.debug(
        `--- Starting optimization iteration ${i + 1}/${this.numIterations} ---`,
      );
      const newPromptText = await this.generateCandidatePrompt(
        bestAgent,
        bestScore,
      );
      const candidateAgent = bestAgent.clone({instruction: newPromptText});
      const candidateScore = await this.scoreAgentOnBatch(
        candidateAgent,
        sampler,
        trainExampleIds,
      );
      logger.debug(
        `Candidate score: ${candidateScore} (vs. best score: ${bestScore})`,
      );
      if (candidateScore > bestScore) {
        bestAgent = candidateAgent;
        bestScore = candidateScore;
      }
    }
    return bestAgent;
  }

  /** Asks the optimizer model for a rewrite of the current best instruction. */
  private async generateCandidatePrompt(
    bestAgent: LlmAgent,
    bestScore: number,
  ): Promise<string> {
    const promptForOptimizer = renderOptimizerPrompt(
      bestScore,
      requireStringInstruction(bestAgent),
    );
    const llmRequest: LlmRequest = {
      model: this.optimizerModel,
      // A copy per request: the retry helper writes into this object, and
      // `modelConfiguration` is reused by every later request.
      config: {...this.modelConfiguration},
      contents: [{role: 'user', parts: [{text: promptForOptimizer}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };
    addDefaultRetryOptionsIfNotPresent(llmRequest);

    let responseText = '';
    for await (const llmResponse of this.llm.generateContentAsync(llmRequest)) {
      for (const part of llmResponse.content?.parts ?? []) {
        if (part.text && !part.thought) {
          responseText += part.text;
        }
      }
    }
    return responseText;
  }

  /** Scores an agent on a random batch drawn from the training examples. */
  private async scoreAgentOnBatch(
    agent: LlmAgent,
    sampler: Sampler<UnstructuredSamplingResult>,
    exampleIds: string[],
  ): Promise<number> {
    const evalBatch = randomSample(
      exampleIds,
      Math.min(this.batchSize, exampleIds.length),
    );
    const results = await sampler.sampleAndScore({
      candidate: agent,
      exampleSet: Sampler.TRAIN_SET,
      batch: evalBatch,
      captureFullEvalData: false,
    });
    return meanScore(results.scores);
  }

  /** Scores the winning agent on the whole validation set. */
  private async runFinalValidation(
    bestAgent: LlmAgent,
    sampler: Sampler<UnstructuredSamplingResult>,
  ): Promise<number> {
    const results = await sampler.sampleAndScore({
      candidate: bestAgent,
      exampleSet: Sampler.VALIDATION_SET,
    });
    return meanScore(results.scores);
  }
}
