/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent as Agent} from '../agents/llm_agent.js';
import {BaseLlmType, LLMRegistry} from '../models/registry.js';
import {Skill} from '../skills/skill.js';
import {SkillToolset} from '../tools/skill/skill_toolset.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {AgentOptimizer} from './agent_optimizer.js';
import {AgentWithScores, UnstructuredSamplingResult} from './data_types.js';
import {EvaluationBatch} from './gepa/adapter.js';
import {optimize as gepaOptimize, ReflectionLm} from './gepa/engine.js';
import {
  extractProposedInstruction,
  renderInstructionProposal,
} from './gepa/instruction_proposal.js';
import {
  AgentGepaAdapter,
  buildReflectionLm,
  GEPARootAgentPromptOptimizerConfig,
  GEPARootAgentPromptOptimizerResult,
} from './gepa_root_agent_prompt_optimizer.js';
import {Sampler} from './sampler.js';

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
 *
 * Shares the field set of {@link GEPARootAgentPromptOptimizerConfig}; only the
 * default optimizer model differs (mirroring the adk-python reference).
 */
export class GEPARootAgentOptimizerConfig extends GEPARootAgentPromptOptimizerConfig {
  constructor(init?: Partial<GEPARootAgentPromptOptimizerConfig>) {
    super({optimizerModel: 'gemini-3.5-flash', ...init});
  }
}

/**
 * The final result of a {@link GEPARootAgentOptimizer} run: the optimized agents
 * and the raw, JSON-serializable GEPA engine result.
 */
export type GEPARootAgentOptimizerResult = GEPARootAgentPromptOptimizerResult;

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
 * It reuses {@link AgentGepaAdapter}'s evaluation loop, rebuilding the candidate
 * agent with {@link createAgentFromCandidate}, filters reflection examples per
 * skill, and proposes new component texts with per-component meta-prompts.
 */
export class RootAgentGepaAdapter extends AgentGepaAdapter {
  constructor(
    initialAgent: Agent,
    sampler: Sampler<UnstructuredSamplingResult>,
    trainExampleIds: Set<string>,
    validationExampleIds: Set<string>,
    private readonly reflectionLm: ReflectionLm,
  ) {
    super(initialAgent, sampler, trainExampleIds, validationExampleIds);
  }

  override buildCandidateAgent(candidate: Record<string, string>): Agent {
    return createAgentFromCandidate(this.initialAgent, candidate);
  }

  override makeReflectiveDataset(
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
export class GEPARootAgentOptimizer extends GEPARootAgentPromptOptimizer {
  protected override readonly optimizerName = 'GEPARootAgentOptimizer';

  constructor(config: GEPARootAgentOptimizerConfig) {
    super(config);
  }

  /** Uses an adapter that also rewrites each skill's instructions. */
  protected override createAdapter(
    initialAgent: Agent,
    sampler: Sampler<UnstructuredSamplingResult>,
    trainExampleIds: Set<string>,
    validationExampleIds: Set<string>,
    reflectionLm: ReflectionLm,
  ): AgentGepaAdapter {
    return new RootAgentGepaAdapter(
      initialAgent,
      sampler,
      trainExampleIds,
      validationExampleIds,
      reflectionLm,
    );
  }

  /**
   * Seeds the search with every skill instruction first, then the core prompt.
   * The ordering is intentional (object insertion order): skills are placed
   * before `agent_prompt` so they are optimized before the core instruction.
   */
  protected override buildSeedCandidate(
    initialAgent: Agent,
    instruction: string,
  ): Record<string, string> {
    const seedCandidate: Record<string, string> = {};
    for (const tool of initialAgent.tools) {
      if (tool instanceof SkillToolset) {
        for (const skill of Object.values(tool.skills)) {
          seedCandidate[skillKeyFor(skill.frontmatter.name)] =
            skill.instructions;
        }
      }
    }
    seedCandidate[AGENT_PROMPT_NAME] = instruction;
    return seedCandidate;
  }
}
