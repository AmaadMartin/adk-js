/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {GenerateContentConfig} from '@google/genai';

import type {LlmAgent} from '../agents/llm_agent.js';
import type {BaseLlm} from '../models/base_llm.js';
import {LLMRegistry, type BaseLlmType} from '../models/registry.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {AgentOptimizer, type OptimizeParams} from './agent_optimizer.js';
import type {
  AgentWithScores,
  OptimizerResult,
  UnstructuredSamplingResult,
} from './data_types.js';
import type {EvaluationBatch, GepaAdapter, GepaEngine} from './gepa_engine.js';
import {
  generateReflectionResponse,
  requireStaticInstruction,
} from './gepa_utils.js';
import type {ExampleSet, Sampler} from './sampler.js';

/** The GEPA component key holding the root agent's instruction. */
export const AGENT_PROMPT_NAME = 'agent_prompt';

/**
 * Score for an example absent from the sampling result. It assumes the [0, 1]
 * scale, so GEPA treats the example as a failure rather than aborting the run.
 */
const MISSING_EXAMPLE_SCORE = 0;

/** The reflection model's thinking budget, in tokens. */
const DEFAULT_THINKING_BUDGET = 10240;

/** Thrown when an optimization runs without a GEPA engine. */
const MISSING_ENGINE_MESSAGE =
  'GEPARootAgentPromptOptimizer requires a GEPA engine, which ADK does not ' +
  'bundle. GEPA is an external search algorithm, so applications that do ' +
  'not optimize prompts are not made to carry it. Pass an implementation of ' +
  'the GepaEngine interface as `config.engine`.';

/** Configuration options for {@link GEPARootAgentPromptOptimizer}. */
export interface GEPARootAgentPromptOptimizerConfig {
  /** The model that reads the eval results and rewrites the instruction. */
  optimizerModel?: string;

  /** The generation config for the optimizer model. */
  modelConfiguration?: GenerateContentConfig;

  /** The maximum number of evaluations the search may make. */
  maxMetricCalls?: number;

  /** The number of examples the engine reflects over at a time. */
  reflectionMinibatchSize?: number;

  /** Where the engine writes intermediate and final results, if anywhere. */
  runDir?: string;

  /**
   * The GEPA search engine. ADK bundles none, so an optimization run without
   * one throws.
   */
  engine?: GepaEngine;
}

/** Defaults matching adk-python's `GEPARootAgentPromptOptimizerConfig`. */
const DEFAULT_CONFIG: Required<
  Omit<GEPARootAgentPromptOptimizerConfig, 'runDir' | 'engine'>
> = {
  optimizerModel: 'gemini-2.5-flash',
  modelConfiguration: {
    thinkingConfig: {
      includeThoughts: true,
      thinkingBudget: DEFAULT_THINKING_BUDGET,
    },
  },
  maxMetricCalls: 100,
  reflectionMinibatchSize: 3,
};

/** The final result of a {@link GEPARootAgentPromptOptimizer} run. */
export interface GEPARootAgentPromptOptimizerResult extends OptimizerResult<AgentWithScores> {
  /** The raw result the GEPA engine reported. */
  gepaResult?: Record<string, unknown>;
}

/** Parameters for the {@link AgentGepaAdapter} constructor. */
export interface AgentGepaAdapterParams {
  /** The agent whose root instruction each candidate replaces. */
  initialAgent: LlmAgent;

  /** The scoring the caller already trusts. */
  sampler: Sampler<UnstructuredSamplingResult>;
}

/**
 * The bridge between a GEPA engine and an ADK agent.
 *
 * It clones the initial agent with each candidate instruction, and delegates
 * the scoring to the caller's {@link Sampler}.
 */
export class AgentGepaAdapter implements GepaAdapter<
  string,
  Record<string, unknown>,
  Record<string, unknown>
> {
  private readonly initialAgent: LlmAgent;
  private readonly sampler: Sampler<UnstructuredSamplingResult>;
  private readonly trainExampleIds: Set<string>;
  private readonly validationExampleIds: Set<string>;

  constructor({initialAgent, sampler}: AgentGepaAdapterParams) {
    this.initialAgent = initialAgent;
    this.sampler = sampler;
    this.trainExampleIds = new Set(sampler.getTrainExampleIds());
    this.validationExampleIds = new Set(sampler.getValidationExampleIds());
  }

  async evaluate(
    batch: string[],
    candidate: Record<string, string>,
    captureTraces = false,
  ): Promise<
    EvaluationBatch<Record<string, unknown>, Record<string, unknown>>
  > {
    const prompt = candidate[AGENT_PROMPT_NAME];
    logger.debug(
      `Evaluating agent on batch [${batch}] with prompt:\n${prompt}`,
    );

    const result = await this.sampler.sampleAndScore({
      candidate: this.initialAgent.clone({instruction: prompt}),
      exampleSet: this.resolveExampleSet(batch),
      batch,
      captureFullEvalData: captureTraces,
    });

    const scores: number[] = [];
    const evalData: Array<Record<string, unknown>> = [];
    for (const exampleId of batch) {
      let score = result.scores[exampleId];
      if (score === undefined) {
        logger.warn(
          `Example ${exampleId} missing from sampling result; scoring it ` +
            `${MISSING_EXAMPLE_SCORE}.`,
        );
        score = MISSING_EXAMPLE_SCORE;
      }
      scores.push(score);
      evalData.push(result.data?.[exampleId] ?? {});
    }

    return {outputs: evalData, scores, trajectories: evalData};
  }

  makeReflectiveDataset(
    candidate: Record<string, string>,
    evalBatch: EvaluationBatch<
      Record<string, unknown>,
      Record<string, unknown>
    >,
    componentsToUpdate: string[],
  ): Record<string, Array<Record<string, unknown>>> {
    const {scores, trajectories} = evalBatch;
    if (!trajectories) {
      throw new Error(
        'GEPA cannot build a reflective dataset without captured trajectories.',
      );
    }
    if (scores.length !== trajectories.length) {
      throw new Error(
        `GEPA reported ${scores.length} scores and ${trajectories.length} ` +
          'trajectories; a reflective dataset needs one trajectory per score.',
      );
    }

    const dataset = scores.map((score, index) => ({
      [AGENT_PROMPT_NAME]: candidate[AGENT_PROMPT_NAME],
      'score': score,
      'eval_data': trajectories[index],
    }));

    // The same data serves every component, of which there should be only one.
    return Object.fromEntries(
      componentsToUpdate.map((component) => [component, dataset]),
    );
  }

  /** Reports which example set a batch of UIDs belongs to. */
  private resolveExampleSet(batch: string[]): ExampleSet {
    if (batch.every((id) => this.trainExampleIds.has(id))) {
      return 'train';
    }
    if (batch.every((id) => this.validationExampleIds.has(id))) {
      return 'validation';
    }
    throw new Error(`Invalid batch composition: ${batch}`);
  }
}

/**
 * An optimizer that improves the root agent instruction with the GEPA
 * framework.
 *
 * ADK bundles no GEPA engine, so the caller supplies one as `config.engine`.
 */
@experimental
export class GEPARootAgentPromptOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithScores
> {
  private readonly config: GEPARootAgentPromptOptimizerConfig &
    typeof DEFAULT_CONFIG;
  private readonly llmClass: BaseLlmType;
  private llm?: BaseLlm;

  constructor(config: GEPARootAgentPromptOptimizerConfig = {}) {
    super();
    this.config = {...DEFAULT_CONFIG, ...config};
    this.llmClass = LLMRegistry.resolve(this.config.optimizerModel);
  }

  /**
   * Builds the reflection model on first use, and reuses it after that.
   *
   * adk-js models validate their credentials in the constructor, so building
   * one up front would make an engine that never reflects need credentials it
   * never uses.
   */
  private resolveLlm(): BaseLlm {
    this.llm ??= new this.llmClass({model: this.config.optimizerModel});
    return this.llm;
  }

  /**
   * Runs the GEPA search over the root agent's instruction.
   *
   * @param params The agent to start from, and the sampler that scores
   *     candidates. Only the root agent's instruction is optimized.
   * @returns The Pareto front of optimized agents, plus the raw engine result.
   * @throws If no GEPA engine is configured, or if the initial instruction is
   *     not a static string.
   */
  override async optimize({
    initialAgent,
    sampler,
  }: OptimizeParams<UnstructuredSamplingResult>): Promise<GEPARootAgentPromptOptimizerResult> {
    const engine = this.config.engine;
    if (!engine) {
      throw new Error(MISSING_ENGINE_MESSAGE);
    }

    if (initialAgent.subAgents.length > 0) {
      logger.warn(
        'The GEPARootAgentPromptOptimizer will not optimize prompts for ' +
          'sub-agents.',
      );
    }

    const trainIds = sampler.getTrainExampleIds();
    const valIds = sampler.getValidationExampleIds();
    const valIdSet = new Set(valIds);
    if (trainIds.some((id) => valIdSet.has(id))) {
      logger.warn(
        'The training and validation example UIDs overlap. This WILL cause' +
          ' aliasing issues unless each common UID refers to the same example' +
          ' in both sets.',
      );
    }

    const seedInstruction = requireStaticInstruction(initialAgent);

    const engineResult = await engine.optimize({
      seedCandidate: {[AGENT_PROMPT_NAME]: seedInstruction},
      trainset: trainIds,
      valset: valIds,
      adapter: new AgentGepaAdapter({initialAgent, sampler}),
      maxMetricCalls: this.config.maxMetricCalls,
      reflectionLm: (prompt) =>
        generateReflectionResponse({
          llm: this.resolveLlm(),
          model: this.config.optimizerModel,
          config: this.config.modelConfiguration,
          prompt,
        }),
      reflectionMinibatchSize: this.config.reflectionMinibatchSize,
      runDir: this.config.runDir,
    });

    const {candidates, valAggregateScores} = engineResult;
    if (candidates.length !== valAggregateScores.length) {
      throw new Error(
        `GEPA reported ${candidates.length} candidates and ` +
          `${valAggregateScores.length} validation scores; it must report one ` +
          'score per candidate.',
      );
    }

    return {
      optimizedAgents: candidates.map((candidate, index) => ({
        optimizedAgent: initialAgent.clone({
          instruction: candidate[AGENT_PROMPT_NAME],
        }),
        overallScore: valAggregateScores[index],
      })),
      gepaResult: engineResult.toDict(),
    };
  }
}
