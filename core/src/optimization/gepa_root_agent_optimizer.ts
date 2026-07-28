/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GenerateContentConfig} from '@google/genai';

import {LlmAgent as Agent} from '../agents/llm_agent.js';
import {BaseLlmType, LLMRegistry} from '../models/registry.js';
import {Skill} from '../skills/skill.js';
import {SkillToolset} from '../tools/skill/skill_toolset.js';
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
import {
  extractProposedInstruction,
  renderInstructionProposal,
} from './gepa/instruction_proposal.js';
import {buildReflectionLm} from './gepa_root_agent_prompt_optimizer.js';
import {ExampleSet, Sampler} from './sampler.js';

/** The GEPA component key for the root agent's core instruction. */
const AGENT_PROMPT_KEY = 'agent_prompt';

/** The prefix for GEPA component keys that target a skill's instructions. */
const SKILL_KEY_PREFIX = 'skill_instructions:';

/** Returns the GEPA component key for a given skill name. */
function skillKeyFor(skillName: string): string {
  return `${SKILL_KEY_PREFIX}${skillName}`;
}

/**
 * The meta-prompt used to propose an improved core instruction. The
 * `<curr_param>` and `<side_info>` markers are filled by
 * {@link renderInstructionProposal}. Reproduced from the adk-python reference.
 */
const AGENT_PROMPT_UPDATOR_INST_TEMPLATE = `I provided an AI agent with the following core instructions:
\`\`\`
<curr_param>
\`\`\`

I then evaluated the agent.
The following are examples of different task inputs provided to the agent along with the agent's response and some external feedback for each input:
\`\`\`
<side_info>
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

/**
 * The meta-prompt used to propose improved instructions for a single skill. The
 * `{skill_name}` placeholder is filled with the skill name, and the
 * `<curr_param>` / `<side_info>` markers are filled by
 * {@link renderInstructionProposal}. Reproduced from the adk-python reference.
 */
const SKILL_INST_UPDATOR_INST_TEMPLATE = `I provided an AI agent with access to a skill named \`{skill_name}\` which provides the following skill instructions:
\`\`\`
<curr_param>
\`\`\`

I then evaluated the agent.
The following are examples of different task inputs provided to the agent along with the agent's response and some external feedback for each input:
\`\`\`
<side_info>
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

/**
 * Configuration options for {@link GEPARootAgentOptimizer}.
 */
export class GEPARootAgentOptimizerConfig {
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

  constructor(init?: Partial<GEPARootAgentOptimizerConfig>) {
    this.optimizerModel = init?.optimizerModel ?? 'gemini-3.5-flash';
    this.modelConfiguration = init?.modelConfiguration ?? {
      thinkingConfig: {includeThoughts: true, thinkingBudget: 10240},
    };
    this.maxMetricCalls = init?.maxMetricCalls ?? 100;
    this.reflectionMinibatchSize = init?.reflectionMinibatchSize ?? 3;
    this.runDir = init?.runDir ?? null;
  }
}

/**
 * The final result of a {@link GEPARootAgentOptimizer} run.
 */
export interface GEPARootAgentOptimizerResult extends OptimizerResult<AgentWithScores> {
  /** The raw, JSON-serializable result dictionary from the GEPA engine. */
  gepaResult?: Record<string, unknown>;
}

/**
 * Clones a {@link SkillToolset}, replacing each skill's instructions with the
 * matching candidate component when present.
 *
 * @param toolset The toolset to rebuild.
 * @param candidate The candidate component texts (keyed by
 *   `skill_instructions:<name>`).
 * @return A new, independent toolset with updated skill instructions.
 */
export function updateSkillToolset(
  toolset: SkillToolset,
  candidate: Record<string, string>,
): SkillToolset {
  const newSkills: Skill[] = [];
  for (const skill of Object.values(toolset.skills)) {
    const key = skillKeyFor(skill.frontmatter.name);
    newSkills.push(
      key in candidate ? {...skill, instructions: candidate[key]} : skill,
    );
  }
  return toolset.cloneWithUpdatedSkills(newSkills);
}

/**
 * Reconstructs an agent from a GEPA candidate.
 *
 * Clones {@link initialAgent} with the candidate's core instruction and rebuilds
 * its tools, replacing each {@link SkillToolset} with a clone carrying the
 * candidate's skill instructions. Never mutates {@link initialAgent}.
 *
 * @param initialAgent The agent to rebuild from.
 * @param candidate The candidate component texts.
 * @return A new agent reflecting the candidate.
 */
export function createAgentFromCandidate(
  initialAgent: Agent,
  candidate: Record<string, string>,
): Agent {
  const prompt = candidate[AGENT_PROMPT_KEY] ?? initialAgent.instruction;
  const newAgent = initialAgent.clone({instruction: prompt});
  newAgent.tools = initialAgent.tools.map((tool) =>
    tool instanceof SkillToolset ? updateSkillToolset(tool, candidate) : tool,
  );
  return newAgent;
}

/**
 * A GEPA engine adapter for ADK agents that optimizes the root agent's core
 * instruction together with the instructions of every skill exposed through an
 * attached {@link SkillToolset}.
 *
 * It rebuilds a candidate agent with {@link createAgentFromCandidate}, delegates
 * scoring to the developer-provided {@link Sampler}, filters reflection examples
 * per skill, and proposes new component texts with per-component meta-prompts.
 */
export class RootAgentGepaAdapter implements GepaAdapter<
  string,
  Record<string, unknown>,
  Record<string, unknown>
> {
  constructor(
    private readonly initialAgent: Agent,
    private readonly sampler: Sampler<UnstructuredSamplingResult>,
    private readonly trainExampleIds: Set<string>,
    private readonly validationExampleIds: Set<string>,
    private readonly reflectionLm: ReflectionLm,
  ) {}

  async evaluate(
    batch: string[],
    candidate: Record<string, string>,
    captureTraces = false,
  ): Promise<
    EvaluationBatch<Record<string, unknown>, Record<string, unknown>>
  > {
    const newAgent = createAgentFromCandidate(this.initialAgent, candidate);

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

    const outputs: Record<string, unknown>[] = [];
    const scores: number[] = [];
    const trajectories: Record<string, unknown>[] = [];
    for (const exampleId of batch) {
      scores.push(result.scores[exampleId]);
      const evalData = result.data?.[exampleId] ?? {};
      outputs.push(evalData);
      trajectories.push(evalData);
    }

    return {outputs, scores, trajectories};
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

    const result: Record<string, Array<Record<string, unknown>>> = {};
    for (const component of componentsToUpdate) {
      result[component] = [];
    }

    for (let i = 0; i < scores.length; i++) {
      const evalData = trajectories[i];
      const entry = {score: scores[i], eval_data: evalData};
      // Parity with adk-python: skill relevance is a substring match of the
      // skill name against the serialized eval data. This is intentionally
      // brittle and preserved for cross-language behavioural parity.
      const evalDataStr = JSON.stringify(evalData);
      for (const component of componentsToUpdate) {
        if (component.startsWith(SKILL_KEY_PREFIX)) {
          const skillName = component.slice(SKILL_KEY_PREFIX.length);
          if (evalDataStr.includes(skillName)) {
            result[component].push(entry);
          }
        } else {
          result[component].push(entry);
        }
      }
    }

    return result;
  }

  async proposeNewTexts(
    candidate: Record<string, string>,
    reflectiveDataset: Record<string, Array<Record<string, unknown>>>,
    componentsToUpdate: string[],
  ): Promise<Record<string, string>> {
    const newTexts: Record<string, string> = {};
    for (const component of componentsToUpdate) {
      let promptTemplate: string;
      if (component === AGENT_PROMPT_KEY) {
        promptTemplate = AGENT_PROMPT_UPDATOR_INST_TEMPLATE;
      } else if (component.startsWith(SKILL_KEY_PREFIX)) {
        const skillName = component.slice(SKILL_KEY_PREFIX.length);
        promptTemplate = SKILL_INST_UPDATOR_INST_TEMPLATE.replace(
          '{skill_name}',
          () => skillName,
        );
      } else {
        throw new Error(`Unknown component type for update: ${component}`);
      }

      const prompt = renderInstructionProposal({
        currentInstructionDoc: candidate[component],
        datasetWithFeedback: reflectiveDataset[component],
        promptTemplate,
      });
      const lmOut = await this.reflectionLm(prompt);
      newTexts[component] = extractProposedInstruction(lmOut);
    }
    return newTexts;
  }
}

/**
 * An optimizer that improves a root agent's core instruction AND the
 * instructions of every skill exposed through an attached {@link SkillToolset},
 * using the GEPA framework (reflective prompt evolution).
 */
@experimental
export class GEPARootAgentOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithScores
> {
  private readonly config: GEPARootAgentOptimizerConfig;
  private readonly llmClass: BaseLlmType;

  constructor(config: GEPARootAgentOptimizerConfig) {
    super();
    this.config = config;
    this.llmClass = LLMRegistry.resolve(config.optimizerModel);
  }

  /**
   * Runs the optimizer.
   *
   * @param initialAgent The initial agent to optimize. Only the root agent's
   *   core instruction and the skill instructions of its attached
   *   {@link SkillToolset} tools are optimized; sub-agents are left untouched.
   * @param sampler The interface used to get training/validation example UIDs,
   *   request agent evaluations, and get data for optimizing the agent.
   * @returns The optimization result, containing the optimized agents with
   *   their validation scores and the raw engine result.
   */
  async optimize(
    initialAgent: Agent,
    sampler: Sampler<UnstructuredSamplingResult>,
  ): Promise<GEPARootAgentOptimizerResult> {
    if (initialAgent.subAgents?.length) {
      logger.warn(
        'The GEPARootAgentOptimizer will not optimize prompts for sub-agents.',
      );
    }

    logger.info('Setting up the GEPA optimizer...');

    const instruction = initialAgent.instruction;
    if (typeof instruction !== 'string') {
      throw new Error(
        'GEPARootAgentOptimizer requires a string instruction;' +
          ' InstructionProvider functions are not supported.',
      );
    }

    const reflectionLm = buildReflectionLm(
      this.llmClass,
      this.config.optimizerModel,
      this.config.modelConfiguration,
    );

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

    const adapter = new RootAgentGepaAdapter(
      initialAgent,
      sampler,
      new Set(trainIds),
      valIdSet,
      reflectionLm,
    );

    // Seed the search with every skill instruction first, then the core prompt.
    // The ordering is intentional (object insertion order): skills are placed
    // before `agent_prompt` so they are optimized before the core instruction.
    const seedCandidate: Record<string, string> = {};
    for (const tool of initialAgent.tools) {
      if (tool instanceof SkillToolset) {
        for (const skill of Object.values(tool.skills)) {
          seedCandidate[skillKeyFor(skill.frontmatter.name)] =
            skill.instructions;
        }
      }
    }
    seedCandidate[AGENT_PROMPT_KEY] = instruction;

    logger.info('Running the GEPA optimizer...');

    const gepaResults = await gepaOptimize<string>({
      seedCandidate,
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
        optimizedAgent: createAgentFromCandidate(initialAgent, candidate),
        overallScore: gepaResults.valAggregateScores[i],
      }),
    );

    return {optimizedAgents, gepaResult: gepaResults.toJSON()};
  }
}
