/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * LocalEvalSampler: scoring a candidate agent against an eval set.
 *
 * The sampler runs the candidate through ADK's `LocalEvalService` over the
 * eval cases of an eval set, and returns one score per case: 1 for a case that
 * passed, 0 for anything else.
 *
 * A real run calls Gemini. This sample stays offline: it gives the candidate a
 * local `BaseLlm` that answers with one fixed sentence, and scores with
 * `response_match_score`, which compares the answer to the eval case's
 * reference answer with ROUGE and needs no network.
 *
 * Run (offline, no API key):
 *   npm run sample -- samples/optimization/local_eval_sampler/agent.ts
 */

import type {BaseLlmConnection, LlmRequest, LlmResponse} from '@google/adk';
import {
  BaseLlm,
  InMemoryEvalSetsManager,
  LlmAgent,
  LocalEvalSampler,
  node,
  NodeContext,
  Sampler,
  Workflow,
} from '@google/adk';

/** The app the eval set belongs to. */
const APP_NAME = 'geography_app';

/** The eval set the sampler scores. */
const EVAL_SET_ID = 'capitals';

/** The one answer the offline model gives, whatever it is asked. */
const OFFLINE_ANSWER = 'The capital of France is Paris.';

/** A model that answers with a fixed sentence. A real one calls Gemini. */
class OfflineAnswerLlm extends BaseLlm {
  constructor() {
    super({model: 'offline-answer-model'});
  }

  override async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: OFFLINE_ANSWER}]}};
  }

  override connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('OfflineAnswerLlm has no live connection.');
  }
}

/** Builds an eval set with one case the agent answers and one it does not. */
async function buildEvalSetsManager(): Promise<InMemoryEvalSetsManager> {
  const evalSetsManager = new InMemoryEvalSetsManager();
  await evalSetsManager.createEvalSet(APP_NAME, EVAL_SET_ID);
  await evalSetsManager.addEvalCase(APP_NAME, EVAL_SET_ID, {
    evalId: 'capital_of_france',
    conversation: [
      {
        userContent: {
          role: 'user',
          parts: [{text: 'What is the capital of France?'}],
        },
        finalResponse: {role: 'model', parts: [{text: OFFLINE_ANSWER}]},
      },
    ],
  });
  await evalSetsManager.addEvalCase(APP_NAME, EVAL_SET_ID, {
    evalId: 'capital_of_japan',
    conversation: [
      {
        userContent: {
          role: 'user',
          parts: [{text: 'What is the capital of Japan?'}],
        },
        finalResponse: {
          role: 'model',
          parts: [{text: 'The capital of Japan is Tokyo.'}],
        },
      },
    ],
  });
  return evalSetsManager;
}

/** The candidate an optimizer would propose. The sampler scores it. */
const candidate = new LlmAgent({
  name: 'geography_agent',
  model: new OfflineAnswerLlm(),
  instruction: 'Answer the question in one sentence.',
});

const scoreCandidate = node(
  async (_ctx: NodeContext) => {
    const sampler = await LocalEvalSampler.create({
      config: {
        evalConfig: {criteria: {response_match_score: 0.8}},
        appName: APP_NAME,
        trainEvalSet: EVAL_SET_ID,
      },
      evalSetsManager: await buildEvalSetsManager(),
    });

    const {scores, data} = await sampler.sampleAndScore({
      candidate,
      exampleSet: Sampler.TRAIN_SET,
      captureFullEvalData: true,
    });

    return Object.entries(scores)
      .map(([evalId, score]) => {
        const turns = data?.[evalId]?.invocations.length ?? 0;
        return `${evalId}: score ${score} over ${turns} invocation(s)`;
      })
      .join('\n');
  },
  {name: 'score_candidate'},
);

export const rootAgent = new Workflow({
  name: 'local_eval_sampler_workflow',
  edges: [['START', scoreCandidate]],
});

// Prints `capital_of_france: score 1 over 1 invocation(s)` and
// `capital_of_japan: score 0 over 1 invocation(s)`.
