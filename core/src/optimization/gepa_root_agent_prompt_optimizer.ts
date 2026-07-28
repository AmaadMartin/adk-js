/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {LlmAgent as Agent} from '../agents/llm_agent.js';
import {BaseLlm} from '../models/base_llm.js';
import {LlmRequest} from '../models/llm_request.js';
import {BaseLlmType, LLMRegistry} from '../models/registry.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {AgentOptimizer} from './agent_optimizer.js';
import {
  AgentWithScores,
  OptimizerResult,
  UnstructuredSamplingResult,
} from './data_types.js';
import {EvaluationBatch, GepaAdapter} from './gepa/adapter.js';
import {optimize as gepaOptimize, ReflectionLm} from './gepa/engine.js';
import {ExampleSet, Sampler} from './sampler.js';

/**
 * The GEPA component key holding the root agent's instruction.
 *
 * Exported so optimizers that extend this one (e.g. a skill-instruction
 * optimizer) key the root prompt identically instead of redeclaring the
 * string and risking drift.
 */
export const AGENT_PROMPT_NAME = 'agent_prompt';

/**
 * Configuration options for {@link GEPARootAgentPromptOptimizer}.
 */
export class GEPARootAgentPromptOptimizerConfig {
  /** The model used to analyze eval results and optimize the agent. */
  optimizerModel: string;

  /** The generation configuration for the optimizer model. */
  modelConfiguration: GenerateContentConfig;

  /** The maximum number of metric calls (evaluations) to make. */
  maxMetricCalls: number;

  /** The number of examples to use for reflection. */
  reflectionMinibatchSize: number;

  /**
   * The directory to save intermediate/final optimization results.
   *
   * Accepted for API parity with adk-python; it is a no-op in this
   * implementation (no filesystem writes) so that `core` stays browser-safe.
   */
  runDir?: string | null;

  constructor(init?: Partial<GEPARootAgentPromptOptimizerConfig>) {
    this.optimizerModel = init?.optimizerModel ?? 'gemini-2.5-flash';
    this.modelConfiguration = init?.modelConfiguration ?? {
      thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
    };
    this.maxMetricCalls = init?.maxMetricCalls ?? 100;
    this.reflectionMinibatchSize = init?.reflectionMinibatchSize ?? 3;
    this.runDir = init?.runDir ?? null;
  }
}

/**
 * The final result of a {@link GEPARootAgentPromptOptimizer} run.
 */
export interface GEPARootAgentPromptOptimizerResult extends OptimizerResult<AgentWithScores> {
  /** The raw, JSON-serializable result dictionary from the GEPA engine. */
  gepaResult?: Record<string, unknown>;
}

/**
 * A GEPA engine adapter for ADK agents.
 *
 * It evaluates a candidate prompt by cloning the initial agent with the new
 * instruction and delegating scoring to the developer-provided {@link Sampler}.
 */
export class AgentGepaAdapter implements GepaAdapter<
  string,
  Record<string, unknown>,
  Record<string, unknown>
> {
  constructor(
    protected readonly initialAgent: Agent,
    private readonly sampler: Sampler<UnstructuredSamplingResult>,
    private readonly trainExampleIds: Set<string>,
    private readonly validationExampleIds: Set<string>,
  ) {}

  /**
   * Builds the candidate agent to evaluate for a given candidate.
   *
   * The base optimizer only rewrites the root instruction; subclasses override
   * this to reconstruct additional components (e.g. skill instructions).
   */
  buildCandidateAgent(candidate: Record<string, string>): Agent {
    return this.initialAgent.clone({
      instruction: candidate[AGENT_PROMPT_NAME],
    });
  }

  async evaluate(
    batch: string[],
    candidate: Record<string, string>,
    captureTraces = false,
  ): Promise<
    EvaluationBatch<Record<string, unknown>, Record<string, unknown>>
  > {
    const newAgent = this.buildCandidateAgent(candidate);

    let exampleSet: ExampleSet;
    if (batch.every((id) => this.trainExampleIds.has(id))) {
      exampleSet = 'train';
    } else if (batch.every((id) => this.validationExampleIds.has(id))) {
      exampleSet = 'validation';
    } else {
      throw new Error(`Invalid batch composition: ${batch}`);
    }

    const result = await this.sampler.sampleAndScore(
      newAgent,
      exampleSet,
      batch,
      captureTraces,
    );

    const scores = batch.map((exampleId) => result.scores[exampleId]);
    // Outputs and trajectories carry the same per-example eval data, matching
    // the Python reference adapter.
    const evalData = batch.map((exampleId) => result.data?.[exampleId] ?? {});

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
    if (!trajectories || trajectories.length !== scores.length) {
      throw new Error(
        `Mismatched scores (${scores.length}) and trajectories ` +
          `(${trajectories?.length ?? 0}) lengths in the reflective dataset.`,
      );
    }

    const dataset = scores.map((score, i) => ({
      [AGENT_PROMPT_NAME]: candidate[AGENT_PROMPT_NAME],
      score,
      eval_data: trajectories[i],
    }));

    const result: Record<string, Array<Record<string, unknown>>> = {};
    for (const component of componentsToUpdate) {
      result[component] = dataset;
    }
    return result;
  }
}

/**
 * Builds the reflection LM callback used by the GEPA engine's default proposer.
 *
 * The optimizer LLM is created lazily on the first reflection call, so running
 * `optimize()` only requires model credentials once the engine actually invokes
 * reflection (not, for example, when the engine is stubbed out).
 */
function buildReflectionLm(
  llmClass: BaseLlmType,
  model: string,
  modelConfiguration: GenerateContentConfig,
): ReflectionLm {
  let llm: BaseLlm | undefined;

  return async (prompt: string): Promise<string> => {
    llm ??= new llmClass({model});
    const llmRequest: LlmRequest = {
      model,
      config: modelConfiguration,
      contents: [{role: 'user', parts: [{text: prompt}]}],
      toolsDict: {},
      liveConnectConfig: {},
    };

    let responseText = '';
    for await (const llmResponse of llm.generateContentAsync(llmRequest)) {
      const parts = llmResponse.content?.parts;
      if (!parts) {
        continue;
      }
      responseText = parts
        .filter((part) => part.text && !part.thought)
        .map((part) => part.text ?? '')
        .join('');
    }
    return responseText;
  };
}

/**
 * An optimizer that improves a root agent's prompt using the GEPA framework
 * (reflective prompt evolution).
 */
@experimental
export class GEPARootAgentPromptOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithScores
> {
  protected readonly config: GEPARootAgentPromptOptimizerConfig;
  protected readonly llmClass: BaseLlmType;

  /** The optimizer name used in log and error messages. */
  protected readonly optimizerName: string = 'GEPARootAgentPromptOptimizer';

  constructor(config: GEPARootAgentPromptOptimizerConfig) {
    super();
    this.config = config;
    this.llmClass = LLMRegistry.resolve(config.optimizerModel);
  }

  /**
   * Creates the engine adapter that evaluates candidates. Subclasses override
   * this to optimize components beyond the root instruction.
   */
  protected createAdapter(
    initialAgent: Agent,
    sampler: Sampler<UnstructuredSamplingResult>,
    trainExampleIds: Set<string>,
    validationExampleIds: Set<string>,
    _reflectionLm: ReflectionLm,
  ): AgentGepaAdapter {
    return new AgentGepaAdapter(
      initialAgent,
      sampler,
      trainExampleIds,
      validationExampleIds,
    );
  }

  /**
   * Builds the candidate the search is seeded with. Subclasses override this
   * to seed components beyond the root instruction.
   */
  protected buildSeedCandidate(
    _initialAgent: Agent,
    instruction: string,
  ): Record<string, string> {
    return {[AGENT_PROMPT_NAME]: instruction};
  }

  /**
   * Runs the optimizer.
   *
   * @param initialAgent The initial agent whose (root) prompt is optimized.
   * @param sampler The interface used to get training/validation example UIDs,
   *   request agent evaluations, and get data for optimizing the agent.
   * @returns The optimization result, containing the optimized agents with
   *   their validation scores and the raw engine result.
   */
  async optimize(
    initialAgent: Agent,
    sampler: Sampler<UnstructuredSamplingResult>,
  ): Promise<GEPARootAgentPromptOptimizerResult> {
    if (initialAgent.subAgents?.length) {
      logger.warn(
        `The ${this.optimizerName} will not optimize prompts for sub-agents.`,
      );
    }

    logger.info('Setting up the GEPA optimizer...');

    const instruction = initialAgent.instruction;
    if (typeof instruction !== 'string') {
      throw new Error(
        `${this.optimizerName} requires a string instruction;` +
          ' InstructionProvider functions are not supported.',
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

    const reflectionLm = buildReflectionLm(
      this.llmClass,
      this.config.optimizerModel,
      this.config.modelConfiguration,
    );
    const adapter = this.createAdapter(
      initialAgent,
      sampler,
      new Set(trainIds),
      valIdSet,
      reflectionLm,
    );

    logger.info('Running the GEPA optimizer...');

    const gepaResults = await gepaOptimize<string>({
      seedCandidate: this.buildSeedCandidate(initialAgent, instruction),
      trainset: trainIds,
      valset: valIds,
      adapter,
      reflectionLm,
      maxMetricCalls: this.config.maxMetricCalls,
      reflectionMinibatchSize: this.config.reflectionMinibatchSize,
    });

    logger.info('GEPA optimization finished. Preparing final results...');

    const optimizedAgents: AgentWithScores[] = gepaResults.candidates.map(
      (candidate, i) => ({
        // Delegated to the adapter so subclasses that rebuild extra
        // components (e.g. skill instructions) map candidates consistently.
        optimizedAgent: adapter.buildCandidateAgent(candidate),
        overallScore: gepaResults.valAggregateScores[i],
      }),
    );

    return {optimizedAgents, gepaResult: gepaResults.toJSON()};
  }
}
