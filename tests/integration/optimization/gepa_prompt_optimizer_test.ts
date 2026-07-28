/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Agent,
  BaseLlm,
  BaseLlmConnection,
  GEPARootAgentPromptOptimizer,
  GEPARootAgentPromptOptimizerConfig,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  Sampler,
  UnstructuredSamplingResult,
} from '@google/adk';
import {beforeAll, describe, expect, it} from 'vitest';

const OPTIMIZER_MODEL = 'fake-optimizer-llm';
const IMPROVED_INSTRUCTION = 'Improved instruction';

/**
 * A deterministic optimizer LLM that always proposes the improved instruction.
 * Its first yielded response has no content (exercising the skip path) and its
 * second mixes a thought part with the real answer.
 */
class FakeOptimizerLlm extends BaseLlm {
  static override readonly supportedModels = [OPTIMIZER_MODEL];

  constructor({model}: {model: string}) {
    super({model});
  }

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
    _stream?: boolean,
    _abortSignal?: AbortSignal,
  ): AsyncGenerator<LlmResponse, void> {
    yield {content: undefined};
    yield {
      content: {
        role: 'model',
        parts: [
          {text: 'internal reasoning', thought: true},
          {text: IMPROVED_INSTRUCTION},
        ],
      },
    };
  }

  override async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('connect is not supported by FakeOptimizerLlm');
  }
}

/**
 * A fake in-memory sampler that scores the improved instruction higher than any
 * other instruction, regardless of which examples are in the batch.
 */
class FakeSampler extends Sampler<UnstructuredSamplingResult> {
  getTrainExampleIds(): string[] {
    return ['t1', 't2', 't3', 't4'];
  }

  getValidationExampleIds(): string[] {
    return ['v1', 'v2'];
  }

  async sampleAndScore(
    candidate: Agent,
    exampleSet: 'train' | 'validation' = 'validation',
    batch: string[] = [],
    captureFullEvalData = false,
  ): Promise<UnstructuredSamplingResult> {
    const isImproved = candidate.instruction === IMPROVED_INSTRUCTION;
    const scores: Record<string, number> = {};
    const data: Record<string, Record<string, unknown>> = {};
    for (const id of batch) {
      scores[id] = isImproved ? 1 : 0;
      data[id] = {instruction: candidate.instruction, exampleSet};
    }
    return captureFullEvalData ? {scores, data} : {scores};
  }
}

describe('GEPARootAgentPromptOptimizer (end-to-end)', () => {
  beforeAll(() => {
    LLMRegistry.register(FakeOptimizerLlm);
  });

  it('optimizes a root agent prompt with the native GEPA engine', async () => {
    const agent = new LlmAgent({
      name: 'root_agent',
      model: OPTIMIZER_MODEL,
      instruction: 'Initial instruction',
    });
    const optimizer = new GEPARootAgentPromptOptimizer(
      new GEPARootAgentPromptOptimizerConfig({
        optimizerModel: OPTIMIZER_MODEL,
        maxMetricCalls: 20,
        reflectionMinibatchSize: 2,
      }),
    );

    const result = await optimizer.optimize(agent, new FakeSampler());

    expect(result.optimizedAgents.length).toBeGreaterThan(0);
    expect(
      result.optimizedAgents.every((a) => typeof a.overallScore === 'number'),
    ).toBe(true);

    // The improved instruction is the top scorer (the fake sampler scores it 1).
    const best = result.optimizedAgents.find((a) => a.overallScore === 1);
    expect(best?.optimizedAgent.instruction).toBe(IMPROVED_INSTRUCTION);

    const instructions = result.optimizedAgents.map(
      (optimized) => optimized.optimizedAgent.instruction,
    );
    expect(instructions).toContain('Initial instruction');
    expect(instructions).toContain(IMPROVED_INSTRUCTION);

    expect(result.gepaResult).toBeDefined();
    expect(result.gepaResult).toHaveProperty('candidates');
    expect(result.gepaResult).toHaveProperty('bestScore', 1);
  });
});
