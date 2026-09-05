/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ThinkingLevel, type GenerateContentConfig} from '@google/genai';

import type {LlmAgent, ToolUnion} from '../agents/llm_agent.js';
import type {BaseLlm} from '../models/base_llm.js';
import {LLMRegistry, type BaseLlmType} from '../models/registry.js';
import {
  isSkillToolset,
  type SkillToolset,
} from '../tools/skill/skill_toolset.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {AgentOptimizer, type OptimizeParams} from './agent_optimizer.js';
import type {
  AgentWithScores,
  OptimizerResult,
  UnstructuredSamplingResult,
} from './data_types.js';
import type {
  EvaluationBatch,
  GepaAdapter,
  GepaEngine,
  ReflectionLm,
} from './gepa_engine.js';
import {
  generateReflectionResponse,
  requireStaticInstruction,
} from './gepa_utils.js';
import {
  AGENT_PROMPT_NAME,
  extractNewInstruction,
  renderProposalPrompt,
  SKILL_KEY_PREFIX,
  skillComponentKey,
} from './instruction_proposal.js';
import type {ExampleSet, Sampler} from './sampler.js';

/**
 * Score for an example absent from the sampling result. It assumes the [0, 1]
 * scale, so GEPA treats the example as a failure rather than aborting the run.
 */
const MISSING_EXAMPLE_SCORE = 0;

/** Thrown when an optimization runs without a GEPA engine. */
const MISSING_ENGINE_MESSAGE =
  'GEPARootAgentOptimizer requires a GEPA engine, which ADK does not ' +
  'bundle. GEPA is an external search algorithm, so applications that do ' +
  'not optimize prompts are not made to carry it. Pass an implementation of ' +
  'the GepaEngine interface as `config.engine`.';

/** Configuration options for {@link GEPARootAgentOptimizer}. */
export interface GEPARootAgentOptimizerConfig {
  /** The model that reads the eval results and rewrites the instructions. */
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

/** Defaults matching adk-python's `GEPARootAgentOptimizerConfig`. */
const DEFAULT_CONFIG: Required<
  Omit<GEPARootAgentOptimizerConfig, 'runDir' | 'engine'>
> = {
  optimizerModel: 'gemini-3.5-flash',
  modelConfiguration: {
    thinkingConfig: {
      includeThoughts: true,
      thinkingLevel: ThinkingLevel.HIGH,
    },
  },
  maxMetricCalls: 100,
  reflectionMinibatchSize: 3,
};

/** The final result of a {@link GEPARootAgentOptimizer} run. */
export interface GEPARootAgentOptimizerResult extends OptimizerResult<AgentWithScores> {
  /** The raw result the GEPA engine reported. */
  gepaResult?: Record<string, unknown>;
}

/** Parameters for the {@link RootAgentGepaAdapter} constructor. */
export interface RootAgentGepaAdapterParams {
  /** The agent each candidate is rebuilt from. */
  initialAgent: LlmAgent;

  /** The scoring the caller already trusts. */
  sampler: Sampler<UnstructuredSamplingResult>;

  /** The model call that rewrites one component. */
  reflectionLm: ReflectionLm;
}

/** Returns a copy of the toolset carrying the candidate's skill instructions. */
function updateSkillToolset(
  toolset: SkillToolset,
  candidate: Record<string, string>,
): SkillToolset {
  const newSkills = Object.values(toolset.skills).map((skill) => {
    const instructions = candidate[skillComponentKey(skill.frontmatter.name)];
    return instructions === undefined ? skill : {...skill, instructions};
  });
  return toolset.cloneWithUpdatedSkills(newSkills);
}

/**
 * Rebuilds the agent from one candidate.
 *
 * The instruction and the tools are passed to a single `clone` call. Assigning
 * the tools afterwards would leave the clone's config holding the original
 * toolsets, so cloning the result again would lose the candidate's skill
 * instructions.
 */
function createAgentFromCandidate(
  initialAgent: LlmAgent,
  candidate: Record<string, string>,
): LlmAgent {
  const instruction =
    candidate[AGENT_PROMPT_NAME] ?? requireStaticInstruction(initialAgent);
  const tools: ToolUnion[] = initialAgent.tools.map((tool) =>
    isSkillToolset(tool) ? updateSkillToolset(tool, candidate) : tool,
  );
  return initialAgent.clone({instruction, tools});
}

/** Returns the seed candidate: every skill's instructions, then the prompt. */
function buildSeedCandidate(
  initialAgent: LlmAgent,
  instruction: string,
): Record<string, string> {
  const seedCandidate: Record<string, string> = {};
  for (const tool of initialAgent.tools) {
    if (!isSkillToolset(tool)) {
      continue;
    }
    for (const skill of Object.values(tool.skills)) {
      seedCandidate[skillComponentKey(skill.frontmatter.name)] =
        skill.instructions;
    }
  }
  // Added last so an engine that walks the components in order optimizes the
  // skills before the core instruction.
  seedCandidate[AGENT_PROMPT_NAME] = instruction;
  return seedCandidate;
}

/**
 * The bridge between a GEPA engine and an ADK root agent and its skills.
 *
 * Each candidate carries the agent's core instruction under
 * {@link AGENT_PROMPT_NAME} and one entry per skill under
 * {@link skillComponentKey}. The adapter rebuilds the agent from a candidate,
 * delegates the scoring to the caller's {@link Sampler}, and asks the
 * reflection model for the next text of each component.
 */
export class RootAgentGepaAdapter implements GepaAdapter<
  string,
  Record<string, unknown>,
  Record<string, unknown>
> {
  private readonly initialAgent: LlmAgent;
  private readonly sampler: Sampler<UnstructuredSamplingResult>;
  private readonly reflectionLm: ReflectionLm;
  private readonly trainExampleIds: Set<string>;
  private readonly validationExampleIds: Set<string>;

  constructor({
    initialAgent,
    sampler,
    reflectionLm,
  }: RootAgentGepaAdapterParams) {
    this.initialAgent = initialAgent;
    this.sampler = sampler;
    this.reflectionLm = reflectionLm;
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
    logger.debug(`Evaluating agent on batch [${batch}]`);

    const result = await this.sampler.sampleAndScore({
      candidate: createAgentFromCandidate(this.initialAgent, candidate),
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

    const dataset: Record<string, Array<Record<string, unknown>>> = {};
    for (const component of componentsToUpdate) {
      dataset[component] = [];
    }

    scores.forEach((score, index) => {
      const evalData = trajectories[index];
      // snake_case because the reflection model reads these keys, and
      // adk-python writes them that way.
      const entry = {'score': score, 'eval_data': evalData};
      const serialized = JSON.stringify(evalData);

      for (const component of componentsToUpdate) {
        if (!component.startsWith(SKILL_KEY_PREFIX)) {
          dataset[component].push(entry);
          continue;
        }
        // A skill only learns from the examples that exercised it.
        if (serialized.includes(component.slice(SKILL_KEY_PREFIX.length))) {
          dataset[component].push(entry);
        }
      }
    });

    return dataset;
  }

  async proposeNewTexts(
    candidate: Record<string, string>,
    reflectiveDataset: Record<string, Array<Record<string, unknown>>>,
    componentsToUpdate: string[],
  ): Promise<Record<string, string>> {
    const newTexts: Record<string, string> = {};
    for (const component of componentsToUpdate) {
      const prompt = renderProposalPrompt(
        component,
        candidate[component],
        reflectiveDataset[component],
      );
      newTexts[component] = extractNewInstruction(
        await this.reflectionLm(prompt),
        component,
      );
    }
    return newTexts;
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
 * An optimizer that rewrites a root agent's instruction and the instructions
 * of every skill it exposes, in one GEPA search.
 *
 * ADK bundles no GEPA engine, so the caller supplies one as `config.engine`.
 */
@experimental
export class GEPARootAgentOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithScores
> {
  private readonly config: GEPARootAgentOptimizerConfig & typeof DEFAULT_CONFIG;
  private readonly llmClass: BaseLlmType;
  private llm?: BaseLlm;

  constructor(config: GEPARootAgentOptimizerConfig = {}) {
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
   * Runs the GEPA search over the root agent's instruction and its skills.
   *
   * @param params The agent to start from, and the sampler that scores
   *     candidates. Sub-agent instructions are left alone.
   * @returns The Pareto front of rebuilt agents, plus the raw engine result.
   * @throws If no GEPA engine is configured, or if the initial instruction is
   *     not a static string.
   */
  override async optimize({
    initialAgent,
    sampler,
  }: OptimizeParams<UnstructuredSamplingResult>): Promise<GEPARootAgentOptimizerResult> {
    const engine = this.config.engine;
    if (!engine) {
      throw new Error(MISSING_ENGINE_MESSAGE);
    }

    if (initialAgent.subAgents.length > 0) {
      logger.warn(
        'The GEPARootAgentOptimizer will not optimize prompts for sub-agents.',
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
    const reflectionLm: ReflectionLm = (prompt) =>
      generateReflectionResponse({
        llm: this.resolveLlm(),
        model: this.config.optimizerModel,
        config: this.config.modelConfiguration,
        prompt,
      });

    const engineResult = await engine.optimize({
      seedCandidate: buildSeedCandidate(initialAgent, seedInstruction),
      trainset: trainIds,
      valset: valIds,
      adapter: new RootAgentGepaAdapter({initialAgent, sampler, reflectionLm}),
      maxMetricCalls: this.config.maxMetricCalls,
      reflectionLm,
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
        optimizedAgent: createAgentFromCandidate(initialAgent, candidate),
        overallScore: valAggregateScores[index],
      })),
      gepaResult: engineResult.toDict(),
    };
  }
}
