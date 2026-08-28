/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';
import {sampleSize} from 'lodash-es';

import type {LlmAgent} from '../agents/llm_agent.js';
import type {BaseLlm} from '../models/base_llm.js';
import type {LlmRequest} from '../models/llm_request.js';
import {LLMRegistry} from '../models/registry.js';
import {logger} from '../utils/logger.js';

import type {AgentOptimizer} from './agent_optimizer.js';
import type {
  AgentWithScores,
  OptimizerResult,
  SamplingResult,
} from './data_types.js';
import type {Sampler} from './sampler.js';

/** The model that rewrites the instruction when the caller names none. */
const DEFAULT_OPTIMIZER_MODEL = 'gemini-2.5-flash';

/** Optimization rounds run when the caller sets none. */
const DEFAULT_NUM_ITERATIONS = 10;

/** Training examples scored per candidate when the caller sets none. */
const DEFAULT_BATCH_SIZE = 5;

/** Thinking budget of the default optimizer model configuration. */
const DEFAULT_THINKING_BUDGET = 10240;

/**
 * Builds the prompt that asks the optimizer model for a better instruction.
 *
 * The wording, the customer-support framing and the two-decimal score are
 * ported verbatim from adk-python, so both SDKs send the same prompt.
 */
function buildOptimizerPrompt(
  currentScore: number,
  currentPromptText: string,
): string {
  return `
You are an expert prompt engineer. Your task is to improve the system prompt for an AI agent.
The agent's current prompt achieved an average score of ${currentScore.toFixed(2)} on a set of evaluation tasks. A higher score is better.

Here is the current prompt:
<current_prompt>
${currentPromptText}
</current_prompt>

Based on the current prompt, rewrite it to create a new, improved version that is likely to achieve a higher score.
The agent needs to solve customer support tasks by using tools correctly and following policies.
Focus on clarity, structure, and providing actionable guidance for the agent.

**Output only the new, full, improved agent prompt. Do not add any other text, explanations, or markdown formatting.**
`;
}

/**
 * Returns the agent's instruction as a string.
 *
 * @throws {Error} If the instruction is a provider function. A provider only
 *     resolves inside a live invocation, and interpolating the function would
 *     send its source text to the optimizer model.
 */
function requireStaticInstruction(agent: LlmAgent): string {
  if (typeof agent.instruction !== 'string') {
    throw new Error(
      'SimplePromptOptimizer requires a static string instruction; agent ' +
        `"${agent.name}" uses an instruction provider, which cannot be ` +
        'resolved outside a live invocation.',
    );
  }
  return agent.instruction;
}

/** Returns the mean of the scores, or 0 when there are none. */
function meanScore(result: SamplingResult): number {
  const values = Object.values(result.scores);
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Caps the batch at the number of training examples that exist. */
function clampBatchSize(batchSize: number, trainExampleCount: number): number {
  if (batchSize <= trainExampleCount) {
    return batchSize;
  }
  logger.warn(
    `Batch size (${batchSize}) is larger than the number of training ` +
      `examples (${trainExampleCount}). Using all training examples for each ` +
      'evaluation.',
  );
  return trainExampleCount;
}

/** Scores a candidate on a fresh random batch of training examples. */
async function scoreOnTrainBatch(
  candidate: LlmAgent,
  sampler: Sampler,
  trainExampleIds: string[],
  batchSize: number,
): Promise<number> {
  const result = await sampler.sampleAndScore({
    candidate,
    exampleSet: 'train',
    batch: sampleSize(trainExampleIds, batchSize),
    captureFullEvalData: false,
  });
  return meanScore(result);
}

/** Configuration for {@link SimplePromptOptimizer}. */
export interface SimplePromptOptimizerConfig {
  /**
   * The model that rewrites the instruction. Independent of the model the
   * optimized agent itself runs on. Defaults to `'gemini-2.5-flash'`.
   */
  optimizerModel?: string;

  /**
   * Generation configuration for the optimizer model. Defaults to a thinking
   * configuration that includes thoughts.
   */
  modelConfiguration?: GenerateContentConfig;

  /** The number of optimization rounds to run. Defaults to 10. */
  numIterations?: number;

  /**
   * The number of training examples used to score each candidate. Capped at
   * the number of training examples the sampler reports. Defaults to 5.
   */
  batchSize?: number;
}

/**
 * A naive optimizer that iteratively rewrites an agent's instruction.
 *
 * One run makes `numIterations` calls to the optimizer model and
 * `numIterations + 2` calls to the sampler. Each sampler call runs a candidate
 * agent over a batch of examples, so a run costs real model traffic and
 * nothing in this class bounds it.
 *
 * Selection reads training scores only. Validation runs once at the end and
 * never decides which instruction wins, so a run can return a rewritten
 * instruction that scores below the initial agent on the validation set.
 */
export class SimplePromptOptimizer implements AgentOptimizer {
  private readonly optimizerModel: string;
  private readonly modelConfiguration: GenerateContentConfig;
  private readonly numIterations: number;
  private readonly batchSize: number;
  private readonly llm: BaseLlm;

  /**
   * @param config Optimizer settings. Every field has a default.
   * @throws {Error} If `optimizerModel` resolves to no registered LLM.
   */
  constructor(config: SimplePromptOptimizerConfig = {}) {
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

  /**
   * Hill-climbs the agent's instruction and validates the winner once.
   *
   * @param initialAgent The agent to optimize. It is never mutated; every
   *     candidate is a clone carrying a rewritten instruction.
   * @param sampler The developer's evaluation harness.
   * @returns One `AgentWithScores`, whose `overallScore` is the mean score
   *     over the whole validation set.
   * @throws {Error} If `initialAgent.instruction` is a provider function.
   */
  async optimize(
    initialAgent: LlmAgent,
    sampler: Sampler,
  ): Promise<OptimizerResult<AgentWithScores>> {
    let bestInstruction = requireStaticInstruction(initialAgent);
    const trainExampleIds = sampler.getTrainExampleIds();
    const batchSize = clampBatchSize(this.batchSize, trainExampleIds.length);

    let bestAgent = initialAgent;
    let bestScore = await scoreOnTrainBatch(
      bestAgent,
      sampler,
      trainExampleIds,
      batchSize,
    );
    logger.debug(`Initial agent baseline score: ${bestScore}`);

    for (let iteration = 1; iteration <= this.numIterations; iteration++) {
      const candidateInstruction = await this.generateCandidateInstruction(
        bestInstruction,
        bestScore,
      );
      const candidateAgent = bestAgent.clone({
        instruction: candidateInstruction,
      });
      const candidateScore = await scoreOnTrainBatch(
        candidateAgent,
        sampler,
        trainExampleIds,
        batchSize,
      );
      logger.debug(
        `Iteration ${iteration}/${this.numIterations}: candidate scored ` +
          `${candidateScore} against the best score ${bestScore}.`,
      );
      if (candidateScore > bestScore) {
        bestAgent = candidateAgent;
        bestInstruction = candidateInstruction;
        bestScore = candidateScore;
      }
    }

    const validationResult = await sampler.sampleAndScore({
      candidate: bestAgent,
      exampleSet: 'validation',
    });
    const overallScore = meanScore(validationResult);
    logger.debug(`Final validation score: ${overallScore}`);

    return {
      optimizedAgents: [{optimizedAgent: bestAgent, overallScore}],
    };
  }

  /** Asks the optimizer model for a rewrite of the current instruction. */
  private async generateCandidateInstruction(
    currentInstruction: string,
    currentScore: number,
  ): Promise<string> {
    const request: LlmRequest = {
      model: this.optimizerModel,
      config: this.modelConfiguration,
      contents: [
        {
          role: 'user',
          parts: [
            {text: buildOptimizerPrompt(currentScore, currentInstruction)},
          ],
        },
      ],
      toolsDict: {},
      liveConnectConfig: {},
    };

    let instruction = '';
    for await (const response of this.llm.generateContentAsync(request)) {
      for (const part of response.content?.parts ?? []) {
        if (part.text && !part.thought) {
          instruction += part.text;
        }
      }
    }
    return instruction;
  }
}
