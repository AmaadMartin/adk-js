/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Behaviour tests for `core/src/optimization/simple_prompt_optimizer.ts` that
 * the single ported test in `simple_prompt_optimizer_test.ts` does not reach.
 */

import {
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  ReadonlyContext,
  SimplePromptOptimizer,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

// `logger` is deliberately not on the public barrel; the repo's tests reach it
// by path, e.g. core/test/workflow/graph_test.ts.
import {logger} from '../../src/utils/logger.js';

import {
  createFakeOptimizerLlmClass,
  FakeSampler,
  IMPROVED_INSTRUCTION,
  promptTextOf,
  TRAIN_EXAMPLE_IDS,
} from './simple_prompt_optimizer_test_utils.js';

const INITIAL_INSTRUCTION = 'Initial Prompt';

/** Installs the fake model and returns the array recording its requests. */
function installFakeLlm(responses?: LlmResponse[]): LlmRequest[] {
  const requests: LlmRequest[] = [];
  vi.spyOn(LLMRegistry, 'resolve').mockReturnValue(
    createFakeOptimizerLlmClass({requests, responses}),
  );
  return requests;
}

function newInitialAgent(instruction = INITIAL_INSTRUCTION): LlmAgent {
  return new LlmAgent({name: 'test_agent', instruction});
}

describe('SimplePromptOptimizer behaviour', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('applies the adk-python defaults for iterations and batch size', async () => {
    const requests = installFakeLlm();
    const sampler = new FakeSampler();

    await new SimplePromptOptimizer().optimize({
      initialAgent: newInitialAgent(),
      sampler,
    });

    expect(requests).toHaveLength(10);
    // Baseline, ten iterations, final validation.
    expect(sampler.calls).toHaveLength(12);
    for (const call of sampler.calls.slice(0, 11)) {
      expect(call.batch).toHaveLength(5);
    }
  });

  it('keeps a $ pattern in the instruction character for character', async () => {
    const instruction = "Refund $& if $`the$1 policy$' allows.";
    const requests = installFakeLlm();

    await new SimplePromptOptimizer({numIterations: 1}).optimize({
      initialAgent: newInitialAgent(instruction),
      sampler: new FakeSampler(),
    });

    expect(promptTextOf(requests[0])).toContain(instruction);
  });

  it('formats the current score with two decimal places', async () => {
    const requests = installFakeLlm();

    await new SimplePromptOptimizer({numIterations: 1}).optimize({
      initialAgent: newInitialAgent(),
      sampler: new FakeSampler(),
    });

    expect(promptTextOf(requests[0])).toContain('average score of 0.50');
  });

  it('drops thought parts from the rewritten instruction', async () => {
    installFakeLlm([
      {
        content: {
          parts: [
            {text: 'reasoning', thought: true},
            {text: 'REAL IMPROVED PROMPT'},
          ],
        },
      },
    ]);

    const result = await new SimplePromptOptimizer({numIterations: 1}).optimize(
      {initialAgent: newInitialAgent(), sampler: new FakeSampler()},
    );

    expect(result.optimizedAgents[0].optimizedAgent.instruction).toBe(
      'REAL IMPROVED PROMPT',
    );
  });

  it('concatenates every response and skips the empty ones', async () => {
    installFakeLlm([
      {},
      {content: {parts: []}},
      {content: {parts: [{text: 'IMPROVED '}]}},
      {content: {parts: [{text: 'AND SPLIT'}]}},
    ]);

    const result = await new SimplePromptOptimizer({numIterations: 1}).optimize(
      {initialAgent: newInitialAgent(), sampler: new FakeSampler()},
    );

    expect(result.optimizedAgents[0].optimizedAgent.instruction).toBe(
      'IMPROVED AND SPLIT',
    );
  });

  it('keeps the incumbent when a candidate ties its score', async () => {
    // The fake sampler scores every instruction without "IMPROVED" the same,
    // so each candidate ties the agent it came from.
    installFakeLlm([{content: {parts: [{text: 'A DIFFERENT PROMPT'}]}}]);
    const initialAgent = newInitialAgent();

    const result = await new SimplePromptOptimizer({numIterations: 3}).optimize(
      {initialAgent, sampler: new FakeSampler()},
    );

    expect(result.optimizedAgents[0].optimizedAgent.instruction).toBe(
      INITIAL_INSTRUCTION,
    );
    expect(result.optimizedAgents[0].optimizedAgent).toBe(initialAgent);
  });

  it('clamps the batch size to the training set and warns', async () => {
    installFakeLlm();
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const trainIds = ['1', '2', '3'];
    const sampler = new FakeSampler({trainIds});

    await new SimplePromptOptimizer({
      numIterations: 1,
      batchSize: 10,
    }).optimize({initialAgent: newInitialAgent(), sampler});

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Batch size (10) is larger'),
    );
    for (const call of sampler.calls.slice(0, 2)) {
      expect(call.batch).toHaveLength(trainIds.length);
    }
  });

  it('scores an empty validation result as 0 rather than NaN', async () => {
    installFakeLlm();

    const result = await new SimplePromptOptimizer({numIterations: 1}).optimize(
      {
        initialAgent: newInitialAgent(),
        sampler: new FakeSampler({validationIds: []}),
      },
    );

    expect(result.optimizedAgents[0].overallScore).toBe(0);
  });

  it('rejects an InstructionProvider before it calls anything', async () => {
    const requests = installFakeLlm();
    const sampler = new FakeSampler();
    const initialAgent = new LlmAgent({
      name: 'test_agent',
      instruction: (_ctx: ReadonlyContext) => 'Initial Prompt',
    });

    await expect(
      new SimplePromptOptimizer({numIterations: 1}).optimize({
        initialAgent,
        sampler,
      }),
    ).rejects.toThrow(/only supports a string instruction/);
    expect(sampler.calls).toHaveLength(0);
    expect(sampler.trainIdCallCount).toBe(0);
    expect(requests).toHaveLength(0);
  });

  it('throws from the constructor when the model does not resolve', () => {
    expect(
      () => new SimplePromptOptimizer({optimizerModel: 'not-a-real-model'}),
    ).toThrow(/not found/);
  });

  it('never mutates the initial agent', async () => {
    installFakeLlm();
    const initialAgent = newInitialAgent();

    const result = await new SimplePromptOptimizer({numIterations: 1}).optimize(
      {initialAgent, sampler: new FakeSampler()},
    );

    expect(result.optimizedAgents[0].optimizedAgent.instruction).toBe(
      IMPROVED_INSTRUCTION,
    );
    expect(initialAgent.instruction).toBe(INITIAL_INSTRUCTION);
  });

  it('never mutates the caller modelConfiguration', async () => {
    const requests = installFakeLlm();
    const modelConfiguration = {thinkingConfig: {includeThoughts: false}};

    await new SimplePromptOptimizer({
      numIterations: 2,
      modelConfiguration,
    }).optimize({initialAgent: newInitialAgent(), sampler: new FakeSampler()});

    expect(modelConfiguration).not.toHaveProperty('httpOptions');
    expect(requests[1].config?.thinkingConfig?.includeThoughts).toBe(false);
  });

  it('stamps the default retry options onto every request', async () => {
    const requests = installFakeLlm();

    await new SimplePromptOptimizer({numIterations: 1}).optimize({
      initialAgent: newInitialAgent(),
      sampler: new FakeSampler(),
    });

    expect(requests[0].config?.httpOptions?.retryOptions?.attempts).toBe(7);
  });

  it('sends the default thinking config when the caller sets none', async () => {
    const requests = installFakeLlm();

    await new SimplePromptOptimizer({numIterations: 1}).optimize({
      initialAgent: newInitialAgent(),
      sampler: new FakeSampler(),
    });

    expect(requests[0].config?.thinkingConfig).toEqual({
      includeThoughts: true,
      thinkingBudget: 10240,
    });
    expect(requests[0].model).toBe('gemini-2.5-flash');
  });

  it('draws a batch of distinct training ids', async () => {
    installFakeLlm();
    vi.spyOn(Math, 'random').mockReturnValue(0.999999);
    const sampler = new FakeSampler();

    await new SimplePromptOptimizer({
      numIterations: 1,
      batchSize: 3,
    }).optimize({initialAgent: newInitialAgent(), sampler});

    const batch = sampler.calls[0].batch ?? [];
    expect(batch).toHaveLength(3);
    expect(new Set(batch).size).toBe(3);
    for (const id of batch) {
      expect(TRAIN_EXAMPLE_IDS).toContain(id);
    }
  });
});
