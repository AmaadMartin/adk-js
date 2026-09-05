/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GEPARootAgentOptimizer: rewriting a root agent's instruction and the
 * instructions of every skill it exposes, in one search.
 *
 * ADK bundles no GEPA search engine, so the optimizer takes one as
 * `config.engine`. This sample supplies a two-candidate engine and scores with
 * phrase coverage, so it runs offline with no credentials.
 *
 * The engine here never reflects, which is why no model is ever called. A real
 * engine calls `adapter.proposeNewTexts` or `params.reflectionLm` to have
 * `config.optimizerModel` write the next candidate.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/optimization/gepa_root_agent_optimizer/agent.ts
 *
 * This file is the one copy of the demo sampler and engine. The guide and
 * `tests/integration/optimization/gepa_root_agent_optimizer_test.ts` both point
 * at it, and that test imports these classes and drives the workflow below, so
 * the suite executes the sample rather than only type-checking it.
 */

import {
  AGENT_PROMPT_NAME,
  GEPARootAgentOptimizer,
  isSkillToolset,
  LlmAgent,
  node,
  NodeContext,
  requireStaticInstruction,
  SampleAndScoreParams,
  Sampler,
  skillComponentKey,
  SkillToolset,
  UnstructuredSamplingResult,
  Workflow,
  type GepaEngine,
  type GepaOptimizeParams,
  type GepaRunResult,
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

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
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

/** A stand-in engine that scores the seed and one fixed rewrite. */
export class TwoCandidateEngine implements GepaEngine {
  async optimize(params: GepaOptimizeParams): Promise<GepaRunResult> {
    const candidates = [
      params.seedCandidate,
      {
        [skillComponentKey(SKILL_NAME)]: CANDIDATE_SKILL_INSTRUCTIONS,
        [AGENT_PROMPT_NAME]: CANDIDATE_INSTRUCTION,
      },
    ];

    const valAggregateScores: number[] = [];
    for (const candidate of candidates) {
      const {scores} = await params.adapter.evaluate(
        params.valset,
        candidate,
        false,
      );
      valAggregateScores.push(mean(scores));
    }

    return {
      candidates,
      valAggregateScores,
      toDict: () => ({tried: candidates.length}),
    };
  }
}

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

const optimizeAgent = node(
  async (_ctx: NodeContext) => {
    const {optimizedAgents} = await new GEPARootAgentOptimizer({
      engine: new TwoCandidateEngine(),
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
