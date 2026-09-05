/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  EvalCase,
  EvalCaseResult,
  EvalSetsManager,
  EvalStatus,
  InferenceResult,
  InferenceStatus,
  InMemoryEvalSetsManager,
  LlmResponse,
  LocalEvalService,
} from '@google/adk';
import {vi} from 'vitest';

/** The app every sampler test evaluates against. */
export const APP_NAME = 'test_app';

/** What a stubbed {@link LocalEvalService} received and returned. */
export interface EvalServiceStub {
  /** The requests `performInference` was called with, in order. */
  inferenceRequests: Array<Parameters<LocalEvalService['performInference']>[0]>;

  /** The requests `evaluate` was called with, in order. */
  evaluateRequests: Array<Parameters<LocalEvalService['evaluate']>[0]>;
}

/**
 * Replaces the two `LocalEvalService` generators with ones that replay fixed
 * results, so a sampler test runs no agent and needs no credentials.
 *
 * `vi.restoreAllMocks` (or `restoreMocks: true`) undoes it.
 *
 * @param inferenceResults What `performInference` yields.
 * @param evalResults What `evaluate` yields.
 * @returns The recorder holding the requests the sampler sent.
 */
export function stubEvalService(
  inferenceResults: InferenceResult[],
  evalResults: EvalCaseResult[],
): EvalServiceStub {
  const stub: EvalServiceStub = {
    inferenceRequests: [],
    evaluateRequests: [],
  };
  vi.spyOn(LocalEvalService.prototype, 'performInference').mockImplementation(
    async function* (request) {
      stub.inferenceRequests.push(request);
      yield* inferenceResults;
    },
  );
  vi.spyOn(LocalEvalService.prototype, 'evaluate').mockImplementation(
    async function* (request) {
      stub.evaluateRequests.push(request);
      yield* evalResults;
    },
  );
  return stub;
}

/** Builds an eval case result carrying only what the sampler reads. */
export function createEvalCaseResult(
  evalId: string,
  finalEvalStatus: EvalStatus,
  overrides: Partial<EvalCaseResult> = {},
): EvalCaseResult {
  return {
    evalSetId: 'train_set',
    evalId,
    finalEvalStatus,
    evalMetricResultPerInvocation: [],
    sessionId: '',
    ...overrides,
  };
}

/** Builds a successful inference result carrying no invocations. */
export function createInferenceResult(
  evalSetId: string,
  evalCaseId: string,
): InferenceResult {
  return {
    appName: APP_NAME,
    evalSetId,
    evalCaseId,
    status: InferenceStatus.SUCCESS,
  };
}

/**
 * Builds an eval sets manager holding one set per entry, each seeded with the
 * eval cases given for it.
 */
export async function createEvalSetsManager(
  sets: Record<string, EvalCase[]>,
): Promise<EvalSetsManager> {
  const manager = new InMemoryEvalSetsManager();
  for (const [evalSetId, evalCases] of Object.entries(sets)) {
    await manager.createEvalSet(APP_NAME, evalSetId);
    for (const evalCase of evalCases) {
      await manager.addEvalCase(APP_NAME, evalSetId, evalCase);
    }
  }
  return manager;
}

/** Builds an eval case with a one-turn static conversation. */
export function createEvalCase(
  evalId: string,
  overrides: Partial<EvalCase> = {},
): EvalCase {
  return {
    evalId,
    conversation: [
      {
        userContent: {role: 'user', parts: [{text: 'hello'}]},
        finalResponse: {role: 'model', parts: [{text: 'hi'}]},
      },
    ],
    ...overrides,
  };
}

/**
 * A model that replays a fixed reply instead of calling a service, so an
 * end-to-end eval run is deterministic and needs no credentials.
 */
export class ScriptedLlm extends BaseLlm {
  constructor(private readonly reply: string) {
    super({model: 'scripted-llm'});
  }

  async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {content: {role: 'model', parts: [{text: this.reply}]}};
  }

  async connect(): Promise<BaseLlmConnection> {
    throw new Error('ScriptedLlm does not support live connections.');
  }
}
