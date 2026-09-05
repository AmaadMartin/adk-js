/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/optimization/simple_prompt_optimizer_test.py` from
 * google/adk-python (commit `44e0b2a8`), covering
 * `src/google/adk/optimization/simple_prompt_optimizer.py`.
 */

import {
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  SimplePromptOptimizer,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  createFakeOptimizerLlmClass,
  FakeSampler,
  IMPROVED_INSTRUCTION,
  IMPROVED_SCORE,
} from './simple_prompt_optimizer_test_utils.js';

describe('SimplePromptOptimizer', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('test_simple_prompt_optimizer', async () => {
    const requests: LlmRequest[] = [];
    vi.spyOn(LLMRegistry, 'resolve').mockReturnValue(
      createFakeOptimizerLlmClass({requests}),
    );
    const sampler = new FakeSampler();
    const optimizer = new SimplePromptOptimizer({
      numIterations: 2,
      batchSize: 2,
    });
    const initialAgent = new LlmAgent({
      name: 'test_agent',
      instruction: 'Initial Prompt',
    });

    const result = await optimizer.optimize({initialAgent, sampler});

    expect(result.optimizedAgents).toHaveLength(1);
    expect(result.optimizedAgents[0].optimizedAgent.instruction).toBe(
      IMPROVED_INSTRUCTION,
    );
    expect(result.optimizedAgents[0].overallScore).toBe(IMPROVED_SCORE);
    expect(sampler.trainIdCallCount).toBe(1);
    // 1 initial, 2 iterations, 1 final validation.
    expect(sampler.calls).toHaveLength(4);
    expect(requests).toHaveLength(2);
  });
});
