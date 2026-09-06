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
 *
 * The sampler, the phrase table and the workflow come from
 * `samples/optimization/gepa_root_agent_prompt_optimizer/agent.ts`, so those
 * fixtures have one copy and this suite executes the sample.
 */

import {
  AGENT_PROMPT_NAME,
  BaseLlm,
  GEPARootAgentPromptOptimizer,
  LlmAgent,
  LLMRegistry,
  requireStaticInstruction,
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
import {
  EXPECTED_PHRASES,
  mean,
  optimizeWithBundledEngine,
  PhraseCoverageSampler,
  rootAgent,
  startingAgent,
} from '../../../samples/optimization/gepa_root_agent_prompt_optimizer/agent.js';
import {
  allEvents,
  finalOutput,
  runSample,
} from '../workflows/_harness/sample_harness.js';

const REFLECTION_MODEL = 'integration-gepa-reflector';

const STARTING_INSTRUCTION = requireStaticInstruction(startingAgent);

/** The two rewrites the reflection model proposes, in order. */
const REWRITES = [
  'Help the user with their order. Confirm the order id first.',
  'Confirm the order id, then help the user with their order politely.',
];

/** The reflection model the bundled-engine cases use. */
const BUNDLED_REFLECTION_MODEL = 'bundled-gepa-reflector';

/** The one rewrite that model proposes. It covers every rewarded phrase. */
const BUNDLED_REWRITE =
  'Confirm the order id, then help the user with their order.';

/** The budget those cases give the search, matching the sample's. */
const BUNDLED_BUDGET = 8;

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

/** A model that answers every reflection call with {@link BUNDLED_REWRITE}. */
class BundledEngineReflectionLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /bundled-gepa-.*/,
  ];

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: BUNDLED_REWRITE}]}};
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('BundledEngineReflectionLlm has no live connection.');
  }
}

/** The sample's sampler, counting the examples it was asked to score. */
class BatchRecordingSampler extends PhraseCoverageSampler {
  /** How many examples the search has spent so far. */
  examplesScored = 0;

  override async sampleAndScore(
    params: SampleAndScoreParams,
  ): Promise<UnstructuredSamplingResult> {
    const result = await super.sampleAndScore(params);
    this.examplesScored += Object.keys(result.scores).length;
    return result;
  }
}

/** The sample's sampler, recording which candidates it was asked to score. */
class RecordingPhraseCoverageSampler extends PhraseCoverageSampler {
  readonly scoredInstructions: string[] = [];

  override async sampleAndScore(
    params: SampleAndScoreParams,
  ): Promise<UnstructuredSamplingResult> {
    this.scoredInstructions.push(requireStaticInstruction(params.candidate));
    return super.sampleAndScore(params);
  }
}

/**
 * A minimal hill-climbing GEPA engine: score the seed, reflect on the results,
 * score the rewrite, and repeat. It keeps every candidate it tried.
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
    const sampler = new RecordingPhraseCoverageSampler();
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
        requireStaticInstruction(optimizedAgent),
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
          expected: EXPECTED_PHRASES['case-1'],
        },
      },
      {
        agent_prompt: STARTING_INSTRUCTION,
        score: 0.5,
        eval_data: {
          instruction: STARTING_INSTRUCTION,
          expected: EXPECTED_PHRASES['case-2'],
        },
      },
    ]);
  });

  it('refuses to score a candidate carrying an instruction provider', async () => {
    await expect(
      new PhraseCoverageSampler().sampleAndScore({
        candidate: new LlmAgent({
          name: 'support_agent',
          instruction: async () => 'Built per request.',
        }),
      }),
    ).rejects.toThrow(/static string/);
  });

  it('runs the sample workflow without a model', async () => {
    const perTurn = await runSample({
      name: 'optimization/gepa_root_agent_prompt_optimizer',
      rootAgent,
      turns: ['optimize the instruction'],
      offline: true,
    });

    expect(finalOutput(allEvents(perTurn))).toBe(
      'validation score 0.5: Help the user with their order.\n' +
        'validation score 1: Help the user with their order. Confirm the ' +
        'order id before you act.',
    );
  });
});

describe('GEPARootAgentPromptOptimizer on the bundled engine', () => {
  beforeAll(() => {
    LLMRegistry.register(BundledEngineReflectionLlm);
  });

  it('rewrites the instruction and stays inside its budget', async () => {
    const sampler = new BatchRecordingSampler();
    const initialAgent = new LlmAgent({
      name: 'support_agent',
      instruction: STARTING_INSTRUCTION,
    });

    const result = await new GEPARootAgentPromptOptimizer({
      optimizerModel: BUNDLED_REFLECTION_MODEL,
      maxMetricCalls: BUNDLED_BUDGET,
      reflectionMinibatchSize: 2,
    }).optimize({initialAgent, sampler});

    expect(
      result.optimizedAgents.map(({optimizedAgent}) =>
        requireStaticInstruction(optimizedAgent),
      ),
    ).toEqual([STARTING_INSTRUCTION, BUNDLED_REWRITE]);
    expect(
      result.optimizedAgents.map(({overallScore}) => overallScore),
    ).toEqual([0.5, 1]);
    expect(result.gepaResult).toMatchObject({
      bestScore: 1,
      totalMetricCalls: sampler.examplesScored,
    });
    expect(sampler.examplesScored).toBeLessThanOrEqual(BUNDLED_BUDGET);
    expect(initialAgent.instruction).toBe(STARTING_INSTRUCTION);
  });

  it('runs the sample without a caller-written engine', async () => {
    const lines = await optimizeWithBundledEngine(BUNDLED_REFLECTION_MODEL);

    expect(lines).toEqual([
      `validation score 0.5: ${STARTING_INSTRUCTION}`,
      `validation score 1: ${BUNDLED_REWRITE}`,
    ]);
  });
});
