/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GEPARootAgentOptimizer: rewriting a root agent's instruction and the
 * instructions of every skill it exposes, in one search.
 *
 * The search runs on the bundled DefaultGepaEngine, so no engine is
 * configured here. Scoring is phrase coverage over four hardcoded examples.
 *
 * A real run names a hosted model in `optimizerModel`, which needs
 * credentials. This sample registers an offline stand-in instead, so it runs
 * with none.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/optimization/gepa_root_agent_optimizer/agent.ts
 *
 * This file is the one copy of the demo sampler and reflection model. The
 * guide and `tests/integration/optimization/gepa_root_agent_optimizer_test.ts`
 * both point at it, and that test imports these classes and drives the
 * workflow below, so the suite executes the sample rather than only
 * type-checking it.
 */

import {
  BaseLlm,
  GEPARootAgentOptimizer,
  isSkillToolset,
  LlmAgent,
  LLMRegistry,
  node,
  NodeContext,
  requireStaticInstruction,
  SampleAndScoreParams,
  Sampler,
  SkillToolset,
  UnstructuredSamplingResult,
  Workflow,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
  type Skill,
} from '@google/adk';

/** The name of the one skill the starting agent exposes. */
export const SKILL_NAME = 'refund_policy';

/** The instruction the engine tries in place of the starting one. */
export const CANDIDATE_INSTRUCTION =
  'Help the user with their order. Confirm the order id before you act.';

/** The skill instructions the engine tries in place of the starting ones. */
export const CANDIDATE_SKILL_INSTRUCTIONS =
  'Refund an order only inside the refund window, and say which window applied.';

/** The phrases each example rewards, across the agent and its skills. */
const EXPECTED_PHRASES: Record<string, string[]> = {
  'case-1': ['order'],
  'case-2': ['order', 'confirm'],
  'case-3': ['refund', 'window'],
  'holdout-1': ['order', 'confirm', 'refund', 'window'],
};

/** The text a candidate agent is scored on: its instruction and its skills. */
function candidateText(agent: LlmAgent): string {
  const parts = [requireStaticInstruction(agent)];
  for (const tool of agent.tools) {
    if (!isSkillToolset(tool)) {
      continue;
    }
    for (const skill of Object.values(tool.skills)) {
      parts.push(skill.instructions);
    }
  }
  return parts.join('\n').toLowerCase();
}

function scoreText(text: string, exampleId: string): number {
  const phrases = EXPECTED_PHRASES[exampleId];
  const hits = phrases.filter((phrase) => text.includes(phrase)).length;
  return hits / phrases.length;
}

/** A sampler over four hardcoded examples. A real one runs the agent. */
export class PhraseCoverageSampler extends Sampler<UnstructuredSamplingResult> {
  override getTrainExampleIds(): string[] {
    return ['case-1', 'case-2', 'case-3'];
  }

  override getValidationExampleIds(): string[] {
    return ['holdout-1'];
  }

  override async sampleAndScore({
    candidate,
    exampleSet = Sampler.VALIDATION_SET,
    batch,
    captureFullEvalData = false,
  }: SampleAndScoreParams): Promise<UnstructuredSamplingResult> {
    const ids =
      batch ??
      (exampleSet === Sampler.TRAIN_SET
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());
    const text = candidateText(candidate);

    const result: UnstructuredSamplingResult = {
      scores: Object.fromEntries(ids.map((id) => [id, scoreText(text, id)])),
    };
    if (captureFullEvalData) {
      // `skillsUsed` is what makes an example reach the skill's reflective
      // dataset: the optimizer keeps the examples whose eval data names the
      // skill.
      result.data = Object.fromEntries(
        ids.map((id) => [
          id,
          {
            text,
            expected: EXPECTED_PHRASES[id],
            skillsUsed: EXPECTED_PHRASES[id].includes('refund')
              ? [SKILL_NAME]
              : [],
          },
        ]),
      );
    }
    return result;
  }
}

/** The model name the sample's offline reflection stand-in answers to. */
export const SAMPLE_REFLECTION_MODEL = 'gepa-sample-offline-reflector';

/**
 * Answers each reflection with the rewrite that component wants.
 *
 * It reads the prompt to tell a skill rewrite from an agent rewrite, because
 * the optimizer renders a different template for each.
 */
export class OfflineReflectionLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    SAMPLE_REFLECTION_MODEL,
  ];

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const prompt = llmRequest.contents[0].parts?.[0].text ?? '';
    const rewrite = prompt.includes(`a skill named \`${SKILL_NAME}\``)
      ? CANDIDATE_SKILL_INSTRUCTIONS
      : CANDIDATE_INSTRUCTION;

    yield {
      content: {role: 'model', parts: [{text: `\`\`\`\n${rewrite}\n\`\`\``}]},
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('The offline reflection model has no live connection.');
  }
}

LLMRegistry.register(OfflineReflectionLlm);

/** The skill whose instructions the optimizer rewrites alongside the agent's. */
export const refundSkill: Skill = {
  frontmatter: {
    name: SKILL_NAME,
    description: 'How to decide whether an order can be refunded.',
  },
  instructions: 'Refund an order when the user asks.',
};

/** The agent the optimizer rewrites, together with its skill. */
export const startingAgent = new LlmAgent({
  name: 'support_agent',
  instruction: 'Help the user with their order.',
  tools: [new SkillToolset([refundSkill])],
});

/** Reports a candidate agent's instruction and each skill's instructions. */
function describeAgent(agent: LlmAgent): string {
  const lines = [`agent: ${requireStaticInstruction(agent)}`];
  for (const tool of agent.tools) {
    if (!isSkillToolset(tool)) {
      continue;
    }
    for (const skill of Object.values(tool.skills)) {
      lines.push(`skill ${skill.frontmatter.name}: ${skill.instructions}`);
    }
  }
  return lines.join(' | ');
}

/**
 * Budget for one reflection round: the seed's validation pass, the parent and
 * the child over the three training examples, and the child's validation pass.
 */
export const SAMPLE_METRIC_BUDGET = 8;

const optimizeAgent = node(
  async (_ctx: NodeContext) => {
    const {optimizedAgents} = await new GEPARootAgentOptimizer({
      optimizerModel: SAMPLE_REFLECTION_MODEL,
      maxMetricCalls: SAMPLE_METRIC_BUDGET,
    }).optimize({
      initialAgent: startingAgent,
      sampler: new PhraseCoverageSampler(),
    });

    return optimizedAgents
      .map(
        ({optimizedAgent, overallScore}) =>
          `validation score ${overallScore}: ${describeAgent(optimizedAgent)}`,
      )
      .join('\n');
  },
  {name: 'optimize_agent'},
);

export const rootAgent = new Workflow({
  name: 'gepa_root_agent_optimizer_workflow',
  edges: [['START', optimizeAgent]],
});
