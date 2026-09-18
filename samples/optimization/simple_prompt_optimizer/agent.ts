/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * SimplePromptOptimizer: hill-climbing on an agent's instruction.
 *
 * Each round asks an optimizer model to rewrite the current best instruction,
 * then scores the rewrite on a random batch of training examples. A rewrite
 * wins only when it scores strictly higher.
 *
 * A real run calls Gemini and a real eval harness. This sample stays offline:
 * it registers a local `BaseLlm` under a name of its own, so
 * `LLMRegistry.resolve` finds it instead of Gemini, and it scores instructions
 * with hardcoded phrase counting instead of running the agent.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/optimization/simple_prompt_optimizer/agent.ts
 */

import {
  BaseLlm,
  BaseLlmConnection,
  LlmAgent,
  LLMRegistry,
  LlmResponse,
  node,
  NodeContext,
  SampleAndScoreParams,
  Sampler,
  SimplePromptOptimizer,
  UnstructuredSamplingResult,
  Workflow,
} from '@google/adk';

/** Model name the sample registers, so no request ever leaves the process. */
const OFFLINE_OPTIMIZER_MODEL = 'offline-prompt-rewriter';

/** Rewrites the sample's optimizer model returns, one per round. */
const REWRITES = [
  'Help the user with their order.',
  'Help the user with their order. Confirm the order id before you act.',
  'Confirm the order id, then help the user with their order.',
];

/** Phrases each example expects the instruction to contain. */
const EXPECTED_PHRASES: Record<string, string[]> = {
  'case-1': ['order'],
  'case-2': ['order', 'confirm'],
  'case-3': ['confirm'],
  'holdout-1': ['order', 'confirm'],
  'holdout-2': ['order'],
};

function scoreInstruction(instruction: string, exampleId: string): number {
  const phrases = EXPECTED_PHRASES[exampleId];
  if (!phrases) {
    throw new Error(`No expected phrases for example id: ${exampleId}`);
  }
  const text = instruction.toLowerCase();
  const hits = phrases.filter((phrase) => text.includes(phrase)).length;
  return hits / phrases.length;
}

/** A model that answers with the next canned rewrite. A real one calls Gemini. */
class OfflineRewriterLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    OFFLINE_OPTIMIZER_MODEL,
  ];

  private static round = 0;

  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    const rewrite = REWRITES[OfflineRewriterLlm.round % REWRITES.length];
    OfflineRewriterLlm.round++;
    yield {content: {role: 'model', parts: [{text: rewrite}]}};
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('OfflineRewriterLlm has no live connection.');
  }
}

LLMRegistry.register(OfflineRewriterLlm);

/** Scores a candidate by the phrases its instruction uses. */
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
  }: SampleAndScoreParams): Promise<UnstructuredSamplingResult> {
    const ids =
      batch ??
      (exampleSet === Sampler.TRAIN_SET
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());
    const instruction =
      typeof candidate.instruction === 'string' ? candidate.instruction : '';
    return {
      scores: Object.fromEntries(
        ids.map((id) => [id, scoreInstruction(instruction, id)]),
      ),
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
    const {optimizedAgents} = await new SimplePromptOptimizer({
      optimizerModel: OFFLINE_OPTIMIZER_MODEL,
      numIterations: 3,
      batchSize: 3,
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
  name: 'simple_prompt_optimizer_workflow',
  edges: [['START', optimizeInstruction]],
});

// Prints a validation score of 1 and the instruction that mentions both the
// order and confirming it. The starting instruction scores 0.75.
