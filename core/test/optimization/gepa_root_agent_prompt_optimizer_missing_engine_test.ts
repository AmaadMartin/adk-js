/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What the optimizer reports when the bundled search engine cannot be loaded.
 *
 * This file imports through module paths rather than `@google/adk`, and it is
 * the one place in the suite that does. The public entry point re-exports
 * `DefaultGepaEngine`, so importing it would load the very module this file
 * makes fail. The mock below is hoisted and applies to the whole file, which
 * is why this case lives apart from the other engine-resolution tests.
 */

import {describe, expect, it, vi} from 'vitest';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import type {UnstructuredSamplingResult} from '../../src/optimization/data_types.js';
import {
  GEPARootAgentPromptOptimizer,
  MISSING_GEPA_DEPENDENCIES_MESSAGE,
} from '../../src/optimization/gepa_root_agent_prompt_optimizer.js';
import {Sampler} from '../../src/optimization/sampler.js';

/** The failure the mocked module raises when the optimizer imports it. */
const {LOAD_FAILURE} = vi.hoisted(() => ({
  LOAD_FAILURE: 'default_gepa_engine.js is not available in this build',
}));

vi.mock('../../src/optimization/default_gepa_engine.js', () => {
  throw new Error(LOAD_FAILURE);
});

/** Returns the message of `error` and of every cause behind it. */
function causeMessages(error: Error): string[] {
  const messages = [error.message];
  let cause = error.cause;
  while (cause instanceof Error) {
    messages.push(cause.message);
    cause = cause.cause;
  }
  return messages;
}

/** A sampler that fails the test if the optimizer reaches it. */
class UnusedSampler extends Sampler<UnstructuredSamplingResult> {
  override getTrainExampleIds(): string[] {
    return ['train1'];
  }

  override getValidationExampleIds(): string[] {
    return ['val1'];
  }

  override async sampleAndScore(): Promise<UnstructuredSamplingResult> {
    expect.fail('the optimizer scored a candidate without a search engine');
  }
}

describe('GEPARootAgentPromptOptimizer without a loadable engine', () => {
  it('reports the missing search engine and keeps the cause', async () => {
    const initialAgent = new LlmAgent({
      name: 'support_agent',
      instruction: 'Help the user.',
    });

    const thrown = await new GEPARootAgentPromptOptimizer()
      .optimize({initialAgent, sampler: new UnusedSampler()})
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    if (!(thrown instanceof Error)) {
      expect.fail('optimize resolved without a search engine');
    }
    expect(thrown.message).toBe(MISSING_GEPA_DEPENDENCIES_MESSAGE);
    expect(thrown.cause).toBeInstanceOf(Error);
    // Vitest reports a module-factory failure through a wrapper error, so the
    // original failure sits one level further down the cause chain.
    expect(causeMessages(thrown)).toContain(LOAD_FAILURE);
  });
});
