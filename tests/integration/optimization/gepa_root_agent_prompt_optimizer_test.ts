/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives a whole GEPA optimization: a search engine that evaluates, reflects
 * and evaluates again, an agent whose instruction changes between rounds, and
 * a sampler that scores the wording. Nothing here is stubbed inside ADK, and
 * it needs no credentials and no network.
 */

import {
  AGENT_PROMPT_NAME,
  BaseLlm,
  GEPARootAgentPromptOptimizer,
  LLMRegistry,
  LlmAgent,
  Sampler,
  type BaseLlmConnection,
  type GepaEngine,
  type GepaOptimizeParams,
  type GepaRunResult,
  type LlmRequest,
  type LlmResponse,
  type SampleAndScoreParams,
  type UnstructuredSamplingResult,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';

const REFLECTION_MODEL = 'integration-gepa-reflector';

const STARTING_INSTRUCTION = 'Help the user with their order.';

/** The phrases each example rewards, so a longer instruction scores higher. */
const EXPECTED_PHRASES: Record<string, string[]> = {
  'train-1': ['order'],
  'train-2': ['order', 'confirm'],
  'val-1': ['order', 'confirm'],
};

/** The two rewrites the reflection model proposes, in order. */
const REWRITES = [
  'Help the user with their order. Confirm the order id first.',
  'Confirm the order id, then help the user with their order politely.',
];

/** A model that hands back the next rewrite on each reflection call. */
class ScriptedReflectionLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /integration-gepa-.*/,
  ];

  private static callCount = 0;

  /** The prompt text of every reflection request, across the suite. */
  static readonly prompts: string[] = [];

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    ScriptedReflectionLlm.prompts.push(
      llmRequest.contents[0].parts?.[0].text ?? '',
    );
    const rewrite = REWRITES[ScriptedReflectionLlm.callCount];
    ScriptedReflectionLlm.callCount += 1;
    yield {
      content: {
        role: 'model',
        parts: [
          {text: 'Deciding what to change. ', thought: true},
          {text: rewrite},
        ],
      },
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedReflectionLlm has no live connection.');
  }
}

/** Scores an instruction by the phrases the example asks for. */
class PhraseCoverageSampler extends Sampler<UnstructuredSamplingResult> {
  /** The instruction of every candidate it scored, in order. */
  readonly scoredInstructions: string[] = [];

  override getTrainExampleIds(): string[] {
    return ['train-1', 'train-2'];
  }

  override getValidationExampleIds(): string[] {
    return ['val-1'];
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
    const instruction = String(candidate.instruction);
    this.scoredInstructions.push(instruction);

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

function scoreInstruction(instruction: string, exampleId: string): number {
  const phrases = EXPECTED_PHRASES[exampleId];
  const text = instruction.toLowerCase();
  const hits = phrases.filter((phrase) => text.includes(phrase)).length;
  return hits / phrases.length;
}

function mean(values: number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/**
 * A minimal hill-climbing GEPA engine: score the seed, reflect on the worst
 * examples, score the rewrite, and repeat. It keeps every candidate it tried.
 */
class HillClimbingEngine implements GepaEngine {
  /** The reflective-dataset records the adapter produced, per round. */
  readonly reflectiveRecords: Array<Array<Record<string, unknown>>> = [];

  constructor(private readonly rounds: number) {}

  async optimize(params: GepaOptimizeParams): Promise<GepaRunResult> {
    const candidates = [params.seedCandidate];
    let current = params.seedCandidate;

    for (let round = 0; round < this.rounds; round++) {
      const evalBatch = await params.adapter.evaluate(
        params.trainset,
        current,
        true,
      );
      const dataset = params.adapter.makeReflectiveDataset(current, evalBatch, [
        AGENT_PROMPT_NAME,
      ]);
      this.reflectiveRecords.push(dataset[AGENT_PROMPT_NAME]);

      const rewrite = await params.reflectionLm(
        JSON.stringify(dataset[AGENT_PROMPT_NAME]),
      );
      current = {[AGENT_PROMPT_NAME]: rewrite};
      candidates.push(current);
    }

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
      toDict: () => ({rounds: this.rounds, tried: candidates.length}),
    };
  }
}

describe('GEPARootAgentPromptOptimizer end to end', () => {
  beforeAll(() => {
    LLMRegistry.register(ScriptedReflectionLlm);
  });

  it('rewrites the root instruction and reports the scored front', async () => {
    const sampler = new PhraseCoverageSampler();
    const engine = new HillClimbingEngine(2);
    const initialAgent = new LlmAgent({
      name: 'support_agent',
      instruction: STARTING_INSTRUCTION,
    });

    const result = await new GEPARootAgentPromptOptimizer({
      engine,
      optimizerModel: REFLECTION_MODEL,
      maxMetricCalls: 12,
      reflectionMinibatchSize: 2,
    }).optimize({initialAgent, sampler});

    expect(
      result.optimizedAgents.map(({optimizedAgent}) =>
        String(optimizedAgent.instruction),
      ),
    ).toEqual([STARTING_INSTRUCTION, ...REWRITES]);
    expect(
      result.optimizedAgents.map(({overallScore}) => overallScore),
    ).toEqual([0.5, 1, 1]);
    expect(result.gepaResult).toEqual({rounds: 2, tried: 3});

    // The starting agent is untouched; every candidate is a fresh clone.
    expect(initialAgent.instruction).toBe(STARTING_INSTRUCTION);
    expect(sampler.scoredInstructions).toContain(REWRITES[1]);

    // The reflection prompt carries the scores the sampler produced, and the
    // model's thought part never reaches the rewritten instruction.
    expect(ScriptedReflectionLlm.prompts[0]).toContain('"score"');
    expect(ScriptedReflectionLlm.prompts[0]).not.toContain('Deciding what');
    expect(engine.reflectiveRecords[0]).toEqual([
      {
        agent_prompt: STARTING_INSTRUCTION,
        score: 1,
        eval_data: {
          instruction: STARTING_INSTRUCTION,
          expected: ['order'],
        },
      },
      {
        agent_prompt: STARTING_INSTRUCTION,
        score: 0.5,
        eval_data: {
          instruction: STARTING_INSTRUCTION,
          expected: ['order', 'confirm'],
        },
      },
    ]);
  });
});
