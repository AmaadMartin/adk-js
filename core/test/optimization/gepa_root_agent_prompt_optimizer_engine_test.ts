/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * How the optimizer resolves its search engine, what it reports when the
 * bundled one cannot be loaded, and the progress it logs.
 */

import {
  AGENT_PROMPT_NAME,
  AgentGepaAdapter,
  BaseLlm,
  GEPARootAgentPromptOptimizer,
  LlmAgent,
  LLMRegistry,
  requireStaticInstruction,
  Sampler,
  type BaseLlmConnection,
  type LlmRequest,
  type LlmResponse,
  type SampleAndScoreParams,
  type UnstructuredSamplingResult,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';
import {
  collectLogs,
  FakeGepaEngine,
  RecordingSampler,
  runResult,
} from './gepa_test_utils.js';

const REFLECTION_MODEL = 'engine-gepa-reflector';

const SEED_INSTRUCTION = 'Help the user.';
const REWRITE = 'Help the user and confirm the order id.';

const TRAIN_IDS = ['train1', 'train2'];
const VALIDATION_IDS = ['val1', 'val2'];

/** A model that answers every reflection request with the same rewrite. */
class FixedRewriteLlm extends BaseLlm {
  static override readonly supportedModels: Array<string | RegExp> = [
    /engine-gepa-.*/,
  ];

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: REWRITE}]}};
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('FixedRewriteLlm has no live connection.');
  }
}

/** A sampler that rewards the instruction for naming the order id. */
class OrderIdSampler extends Sampler<UnstructuredSamplingResult> {
  /** The instruction of every candidate it was asked to score, in order. */
  readonly scored: string[] = [];

  override getTrainExampleIds(): string[] {
    return TRAIN_IDS;
  }

  override getValidationExampleIds(): string[] {
    return VALIDATION_IDS;
  }

  override async sampleAndScore({
    candidate,
    batch,
    captureFullEvalData = false,
  }: SampleAndScoreParams): Promise<UnstructuredSamplingResult> {
    const instruction = requireStaticInstruction(candidate);
    this.scored.push(instruction);
    const score = instruction.includes('order id') ? 1 : 0.25;
    const ids = batch ?? [];
    const result: UnstructuredSamplingResult = {
      scores: Object.fromEntries(ids.map((id) => [id, score])),
    };
    if (captureFullEvalData) {
      result.data = Object.fromEntries(ids.map((id) => [id, {instruction}]));
    }
    return result;
  }
}

function createAgent(): LlmAgent {
  return new LlmAgent({
    name: 'support_agent',
    instruction: SEED_INSTRUCTION,
  });
}

beforeAll(() => {
  LLMRegistry.register(FixedRewriteLlm);
});

describe('GEPARootAgentPromptOptimizer engine resolution', () => {
  it('runs the bundled engine when the caller configures none', async () => {
    const sampler = new OrderIdSampler();

    const result = await new GEPARootAgentPromptOptimizer({
      optimizerModel: REFLECTION_MODEL,
      maxMetricCalls: 8,
      reflectionMinibatchSize: 2,
    }).optimize({initialAgent: createAgent(), sampler});

    expect(
      result.optimizedAgents.map(({optimizedAgent}) =>
        requireStaticInstruction(optimizedAgent),
      ),
    ).toEqual([SEED_INSTRUCTION, REWRITE]);
    expect(result.optimizedAgents[1].overallScore).toBe(1);
    expect(result.gepaResult).toEqual({
      candidates: [
        {[AGENT_PROMPT_NAME]: SEED_INSTRUCTION},
        {[AGENT_PROMPT_NAME]: REWRITE},
      ],
      valAggregateScores: [0.25, 1],
      bestScore: 1,
      totalMetricCalls: 8,
    });
    expect(sampler.scored).toContain(REWRITE);
  });

  it('prefers the configured engine and never runs the bundled one', async () => {
    const sampler = new RecordingSampler({
      trainIds: TRAIN_IDS,
      validationIds: VALIDATION_IDS,
      result: {scores: {}},
    });
    const engine = new FakeGepaEngine(
      runResult([{[AGENT_PROMPT_NAME]: REWRITE}], [0.75], {source: 'caller'}),
    );

    const result = await new GEPARootAgentPromptOptimizer({engine}).optimize({
      initialAgent: createAgent(),
      sampler,
    });

    expect(engine.calls).toHaveLength(1);
    expect(result.gepaResult).toEqual({source: 'caller'});
    expect(sampler.calls).toEqual([]);
  });
});

describe('GEPARootAgentPromptOptimizer progress logs', () => {
  it('logs each phase of the run at info, in order', async () => {
    const engine = new FakeGepaEngine(runResult([], []));

    const {infos} = await collectLogs(async () => {
      await new GEPARootAgentPromptOptimizer({engine}).optimize({
        initialAgent: createAgent(),
        sampler: new OrderIdSampler(),
      });
    });

    expect(infos).toEqual([
      'Setting up the GEPA optimizer...',
      'Running the GEPA optimizer...',
      'GEPA optimization finished. Preparing final results...',
    ]);
  });

  it('logs each evaluated batch at info', async () => {
    const adapter = new AgentGepaAdapter({
      initialAgent: createAgent(),
      sampler: new OrderIdSampler(),
    });

    const {infos, debugs} = await collectLogs(async () => {
      await adapter.evaluate(TRAIN_IDS, {[AGENT_PROMPT_NAME]: REWRITE});
    });

    expect(infos).toEqual([
      `Evaluating agent on batch [${TRAIN_IDS}] with prompt:\n${REWRITE}`,
    ]);
    expect(debugs).toEqual([]);
  });
});
