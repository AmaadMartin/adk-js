/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * GEPARootAgentPromptOptimizer: reflective prompt evolution over a root agent.
 *
 * ADK bundles a GEPA search engine, so `config.engine` is optional.
 * {@link optimizeWithBundledEngine} runs that search; it reflects, so it calls
 * `config.optimizerModel` and needs an API key.
 *
 * The workflow below stays offline instead. It passes a two-candidate engine
 * that never reflects, which is how the sample runs with no credentials and
 * also shows what `config.engine` is for.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/optimization/gepa_root_agent_prompt_optimizer/agent.ts
 *
 * This file is the one copy of the demo sampler and engine. The guide and
 * `tests/integration/optimization/gepa_root_agent_prompt_optimizer_test.ts`
 * both point at it, and that test imports these classes and drives the
 * workflow below, so the suite executes the sample rather than only
 * type-checking it.
 */

import {
  AGENT_PROMPT_NAME,
  GEPARootAgentPromptOptimizer,
  LlmAgent,
  node,
  NodeContext,
  requireStaticInstruction,
  SampleAndScoreParams,
  Sampler,
  UnstructuredSamplingResult,
  Workflow,
  type GepaEngine,
  type GepaOptimizeParams,
  type GepaRunResult,
} from '@google/adk';

/** The instruction the engine tries in place of the starting one. */
export const CANDIDATE_INSTRUCTION =
  'Help the user with their order. Confirm the order id before you act.';

/** The phrases each example rewards. */
export const EXPECTED_PHRASES: Record<string, string[]> = {
  'case-1': ['order'],
  'case-2': ['order', 'confirm'],
  'holdout-1': ['order', 'confirm'],
};

function scoreInstruction(instruction: string, exampleId: string): number {
  const phrases = EXPECTED_PHRASES[exampleId];
  const text = instruction.toLowerCase();
  const hits = phrases.filter((phrase) => text.includes(phrase)).length;
  return hits / phrases.length;
}

export function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** A sampler over three hardcoded examples. A real one runs the agent. */
export class PhraseCoverageSampler extends Sampler<UnstructuredSamplingResult> {
  override getTrainExampleIds(): string[] {
    return ['case-1', 'case-2'];
  }

  override getValidationExampleIds(): string[] {
    return ['holdout-1'];
  }

  override async sampleAndScore({
    candidate,
    exampleSet = 'validation',
    batch,
    captureFullEvalData = false,
  }: SampleAndScoreParams): Promise<UnstructuredSamplingResult> {
    const ids =
      batch ??
      (exampleSet === 'train'
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());
    const instruction = requireStaticInstruction(candidate);

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

/** A stand-in engine that scores the seed and one fixed rewrite. */
export class TwoCandidateEngine implements GepaEngine {
  async optimize(params: GepaOptimizeParams): Promise<GepaRunResult> {
    const candidates = [
      params.seedCandidate,
      {[AGENT_PROMPT_NAME]: CANDIDATE_INSTRUCTION},
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
      details: {tried: candidates.length},
    };
  }
}

/** The agent the optimizer rewrites. Only its instruction is ever read. */
export const startingAgent = new LlmAgent({
  name: 'support_agent',
  instruction: 'Help the user with their order.',
});

/** The reflection model the bundled search asks for each rewrite. */
export const DEFAULT_OPTIMIZER_MODEL = 'gemini-2.5-flash';

/**
 * Runs the bundled search, which is what an optimization with no
 * `config.engine` does.
 *
 * @param optimizerModel The model that writes each rewrite. The default calls
 *     Gemini, so it needs an API key.
 * @returns One line per candidate the search kept: its score and instruction.
 */
export async function optimizeWithBundledEngine(
  optimizerModel = DEFAULT_OPTIMIZER_MODEL,
): Promise<string[]> {
  const {optimizedAgents} = await new GEPARootAgentPromptOptimizer({
    optimizerModel,
    maxMetricCalls: 8,
    reflectionMinibatchSize: 2,
  }).optimize({
    initialAgent: startingAgent,
    sampler: new PhraseCoverageSampler(),
  });

  return optimizedAgents.map(
    ({optimizedAgent, overallScore}) =>
      `validation score ${overallScore}: ${optimizedAgent.instruction}`,
  );
}

const optimizeInstruction = node(
  async (_ctx: NodeContext) => {
    const {optimizedAgents} = await new GEPARootAgentPromptOptimizer({
      engine: new TwoCandidateEngine(),
    }).optimize({
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
  name: 'gepa_root_agent_prompt_optimizer_workflow',
  edges: [['START', optimizeInstruction]],
});
