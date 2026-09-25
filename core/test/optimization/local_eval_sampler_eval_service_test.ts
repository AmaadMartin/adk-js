/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives `LocalEvalSampler` over a real `LocalEvalService`, a real
 * `InMemoryEvalSetsManager` and a real `MetricEvaluatorRegistry`. Nothing in
 * ADK is mocked. Only the model is scripted, so the run needs no credentials
 * and no network.
 */

import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {
  BaseLlm,
  InMemoryEvalSetsManager,
  LlmAgent,
  LocalEvalSampler,
  Sampler,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {logger} from '../../src/utils/logger.js';
import {createInvocation, TEST_APP} from './local_eval_sampler_test_utils.js';

/** The one answer the scripted model gives, whatever it is asked. */
const SCRIPTED_ANSWER = 'The capital of France is Paris.';

/** A model that answers with a fixed sentence. A real one calls Gemini. */
class ScriptedLlm extends BaseLlm {
  constructor() {
    super({model: 'scripted-eval-model'});
  }

  override async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: SCRIPTED_ANSWER}]}};
  }

  override connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm has no live connection.');
  }
}

/** Builds a manager holding one eval set with a matching and a missing case. */
async function createEvalSet(): Promise<InMemoryEvalSetsManager> {
  const evalSetsManager = new InMemoryEvalSetsManager();
  await evalSetsManager.createEvalSet(TEST_APP, 'geography');
  await evalSetsManager.addEvalCase(TEST_APP, 'geography', {
    evalId: 'capital_of_france',
    conversation: [
      createInvocation(
        {role: 'user', parts: [{text: 'What is the capital of France?'}]},
        {role: 'model', parts: [{text: SCRIPTED_ANSWER}]},
      ),
    ],
  });
  await evalSetsManager.addEvalCase(TEST_APP, 'geography', {
    evalId: 'capital_of_japan',
    conversation: [
      createInvocation(
        {role: 'user', parts: [{text: 'What is the capital of Japan?'}]},
        {role: 'model', parts: [{text: 'The capital of Japan is Tokyo.'}]},
      ),
    ],
  });
  return evalSetsManager;
}

describe('LocalEvalSampler over a real LocalEvalService', () => {
  beforeEach(() => {
    vi.spyOn(logger, 'info').mockImplementation(() => {});
  });

  it('scores the matching case 1 and the missing one 0', async () => {
    const sampler = await LocalEvalSampler.create({
      config: {
        evalConfig: {criteria: {response_match_score: 0.8}},
        appName: TEST_APP,
        trainEvalSet: 'geography',
      },
      evalSetsManager: await createEvalSet(),
    });
    const candidate = new LlmAgent({
      name: 'geography_agent',
      model: new ScriptedLlm(),
      instruction: 'Answer the question.',
    });

    const result = await sampler.sampleAndScore({
      candidate,
      exampleSet: Sampler.TRAIN_SET,
      captureFullEvalData: true,
    });

    expect(sampler.getTrainExampleIds()).toEqual([
      'capital_of_france',
      'capital_of_japan',
    ]);
    expect(result.scores).toEqual({
      capital_of_france: 1.0,
      capital_of_japan: 0.0,
    });

    const captured = result.data?.['capital_of_france'];
    expect(captured?.['invocations']).toEqual([
      {
        actualInvocation: {
          userPrompt: 'What is the capital of France?',
          agentResponse: SCRIPTED_ANSWER,
          toolCalls: [],
        },
        expectedInvocation: {
          userPrompt: 'What is the capital of France?',
          agentResponse: SCRIPTED_ANSWER,
        },
        evalMetricResults: [
          {
            metricName: 'response_match_score',
            score: 1,
            evalStatus: 'PASSED',
          },
        ],
      },
    ]);
  });
});
