/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AgentOptimizer and Sampler: the offline prompt-optimization contract.
 *
 * An `AgentOptimizer` is the search: it proposes candidate instructions. A
 * `Sampler` is the scoring: it says how well a candidate did on each example.
 * This sample implements both with hardcoded numbers, so it runs offline with
 * no credentials and no model call.
 *
 * The agent being optimized is an `LlmAgent`, because that is what
 * `OptimizeParams.initialAgent` takes. The optimizer only reads its
 * `instruction`, so it never needs a model. A `Workflow` runs the optimization
 * and reports the winning instruction, which keeps the whole sample offline.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/optimization/agent_optimizer/agent.ts
 */

import {
  AgentOptimizer,
  AgentWithScores,
  LlmAgent,
  node,
  NodeContext,
  OptimizeParams,
  OptimizerResult,
  SampleAndScoreParams,
  Sampler,
  UnstructuredSamplingResult,
  Workflow,
} from '@google/adk';

/** The instruction the optimizer tries in place of the starting one. */
const CANDIDATE_INSTRUCTION =
  'Help the user with their order. Confirm the order id before you act.';

/** Scores a candidate by how many of the phrases an example asks for it uses. */
const EXPECTED_PHRASES: Record<string, string[]> = {
  'case-1': ['order'],
  'case-2': ['order', 'confirm'],
  'case-3': ['confirm'],
  'holdout-1': ['order', 'confirm'],
  'holdout-2': ['order'],
};

function scoreInstruction(instruction: string, exampleId: string): number {
  const phrases = EXPECTED_PHRASES[exampleId];
  const text = instruction.toLowerCase();
  const hits = phrases.filter((phrase) => text.includes(phrase)).length;
  return hits / phrases.length;
}

/** A sampler over five hardcoded examples. A real one runs the agent. */
class PhraseCoverageSampler extends Sampler<UnstructuredSamplingResult> {
  override getTrainExampleIds(): string[] {
    return ['case-1', 'case-2', 'case-3'];
  }

  override getValidationExampleIds(): string[] {
    return ['holdout-1', 'holdout-2'];
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

    const instruction =
      typeof candidate.instruction === 'string' ? candidate.instruction : '';
    const result: UnstructuredSamplingResult = {
      scores: Object.fromEntries(
        ids.map((id) => [id, scoreInstruction(instruction, id)]),
      ),
    };
    if (captureFullEvalData) {
      result.data = Object.fromEntries(
        ids.map((id) => [id, {instruction, expected: EXPECTED_PHRASES[id]}]),
      );
    }
    return result;
  }
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Tries one rewrite, keeps whichever instruction scored higher on training. */
class TwoInstructionOptimizer extends AgentOptimizer<
  UnstructuredSamplingResult,
  AgentWithScores
> {
  override async optimize({
    initialAgent,
    sampler,
  }: OptimizeParams<UnstructuredSamplingResult>): Promise<
    OptimizerResult<AgentWithScores>
  > {
    const candidates = [
      initialAgent,
      new LlmAgent({
        name: initialAgent.name,
        instruction: CANDIDATE_INSTRUCTION,
      }),
    ];

    let best = initialAgent;
    let bestTrainScore = -Infinity;
    for (const candidate of candidates) {
      const {scores} = await sampler.sampleAndScore({
        candidate,
        exampleSet: Sampler.TRAIN_SET,
      });
      const trainScore = mean(Object.values(scores));
      if (trainScore > bestTrainScore) {
        best = candidate;
        bestTrainScore = trainScore;
      }
    }

    const {scores} = await sampler.sampleAndScore({candidate: best});
    return {
      optimizedAgents: [
        {optimizedAgent: best, overallScore: mean(Object.values(scores))},
      ],
    };
  }
}

/** The agent the optimizer rewrites. Only its instruction is ever read. */
const startingAgent = new LlmAgent({
  name: 'support_agent',
  instruction: 'Help the user with their order.',
});

const optimizeInstruction = node(
  async (_ctx: NodeContext) => {
    const {optimizedAgents} = await new TwoInstructionOptimizer().optimize({
      initialAgent: startingAgent,
      sampler: new PhraseCoverageSampler(),
    });
    return optimizedAgents
      .map(
        ({optimizedAgent, overallScore}) =>
          `validation score ${overallScore}: ${optimizedAgent.instruction}`,
      )
      .join('\n');
  },
  {name: 'optimize_instruction'},
);

export const rootAgent = new Workflow({
  name: 'agent_optimizer_workflow',
  edges: [['START', optimizeInstruction]],
});
