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
import {AGENT_PROMPT_NAME} from './gepa_root_agent_prompt_optimizer.js';
import {
  generateReflectionResponse,
  requireStaticInstruction,
} from './gepa_utils.js';
import type {ExampleSet, Sampler} from './sampler.js';

/** The GEPA component key prefix for a skill's instructions. */
export const SKILL_KEY_PREFIX = 'skill_instructions:';

/**
 * Returns the GEPA component key holding a skill's instructions.
 *
 * @param skillName The skill's frontmatter name.
 */
export function skillComponentKey(skillName: string): string {
  return `${SKILL_KEY_PREFIX}${skillName}`;
}

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

/** Where the current text of a component is substituted into a template. */
const CURRENT_TEXT_PLACEHOLDER = '<curr_param>';

/** Where the component's reflective dataset is substituted into a template. */
const SIDE_INFO_PLACEHOLDER = '<side_info>';

/** Where the skill's name is substituted into the skill template. */
const SKILL_NAME_PLACEHOLDER = '{skill_name}';

/** Indentation of the reflective dataset rendered into a proposal prompt. */
const SIDE_INFO_INDENT = 2;

/** Matches a fenced block, capturing its body. */
const FENCED_BLOCK_PATTERN = /```[^\n]*\n([\s\S]*?)```/g;

const AGENT_PROMPT_UPDATER_TEMPLATE = `I provided an AI agent with the following core instructions:
\`\`\`
${CURRENT_TEXT_PLACEHOLDER}
\`\`\`

I then evaluated the agent.
The following are examples of different task inputs provided to the agent along with the agent's response and some external feedback for each input:
\`\`\`
${SIDE_INFO_PLACEHOLDER}
\`\`\`

Your task is to write a new version of the agent core instructions.
During evaluation, the agent may have loaded skills containing additional instructions.
Do NOT include or attempt to fix instructions loaded through skills (instructions for deciding which skills to load are acceptable in the core instructions).
Focus only on the agent's general behavior, reasoning processes, and tool/skill selection.

Read the evaluation data carefully to identify the format of the user input, agent response, and feedback.
Identify any factual information about the task which belongs in the core instructions.
If such information is omitted or incorrect, update the core instructions accordingly.
Unless there are clear contradictions, avoid removing existing information from the core instructions as it may be relevant to other tasks.

Provide the new instructions within \`\`\` blocks.`;

const SKILL_INSTRUCTION_UPDATER_TEMPLATE = `I provided an AI agent with access to a skill named \`${SKILL_NAME_PLACEHOLDER}\` which provides the following skill instructions:
\`\`\`
${CURRENT_TEXT_PLACEHOLDER}
\`\`\`

I then evaluated the agent.
The following are examples of different task inputs provided to the agent along with the agent's response and some external feedback for each input:
\`\`\`
${SIDE_INFO_PLACEHOLDER}
\`\`\`

Your task is to write a new version of the skill instructions.
Do NOT include or attempt to fix the agent's core instructions.
If NONE of the evaluation tasks exercised this skill, do not update the skill instructions.
If at least some of the evaluation tasks exercised this skill, then update the skill instructions based on the evaluation data for those tasks.
During evaluation, the agent may have loaded other skills besides this one.
Do NOT include or attempt to fix instructions related to other skills.

Read the evaluation data carefully to identify the format of the user input, agent response, and feedback.
Identify any factual information about the task which belongs in the skill instructions.
If such information is omitted or incorrect, update the skill instructions accordingly.
Unless there are clear contradictions, avoid removing existing information from the skill instructions as it may be relevant to other tasks.
Also note that the eval data may contain multiple copies and different versions of the skill instructions; disregard them and focus on updating the skill instructions provided at the start.

Provide the new instructions within \`\`\` blocks.`;

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

/** Returns the instruction-updater template a component is rewritten with. */
function proposalTemplateFor(component: string): string {
  if (component === AGENT_PROMPT_NAME) {
    return AGENT_PROMPT_UPDATER_TEMPLATE;
  }
  if (component.startsWith(SKILL_KEY_PREFIX)) {
    const skillName = component.slice(SKILL_KEY_PREFIX.length);
    return SKILL_INSTRUCTION_UPDATER_TEMPLATE.replace(
      SKILL_NAME_PLACEHOLDER,
      () => skillName,
    );
  }
  throw new Error(`Unknown component type for update: ${component}`);
}

/**
 * Renders the prompt that asks the reflection model for a new component text.
 *
 * adk-python delegates this to the `gepa` package's
 * `InstructionProposalSignature.prompt_renderer`. npm has no equivalent, so
 * this implements the contract the templates themselves state.
 */
function renderProposalPrompt(
  template: string,
  currentText: string,
  dataset: Array<Record<string, unknown>>,
): string {
  return template
    .replace(CURRENT_TEXT_PLACEHOLDER, () => currentText)
    .replace(SIDE_INFO_PLACEHOLDER, () =>
      JSON.stringify(dataset, null, SIDE_INFO_INDENT),
    );
}

/**
 * Returns the last fenced block of a reflection reply, trimmed.
 *
 * The templates ask for the new instructions within ``` blocks, and the last
 * block is what survives a model that restates the current text first. This
 * stands in for the `gepa` package's `output_extractor`.
 *
 * @throws If the reply carries no fenced block.
 */
function extractNewInstruction(lmOutput: string, component: string): string {
  const blocks = [...lmOutput.matchAll(FENCED_BLOCK_PATTERN)];
  const lastBlock = blocks.at(-1);
  if (!lastBlock) {
    throw new Error(
      `The reflection model returned no fenced block for component ` +
        `${component}, so there is no new text to apply.`,
    );
  }
  return lastBlock[1].trim();
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
        proposalTemplateFor(component),
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
