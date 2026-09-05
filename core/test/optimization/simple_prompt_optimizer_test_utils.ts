/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Fakes shared by `simple_prompt_optimizer_test.ts` and
 * `simple_prompt_optimizer_behaviour_test.ts`.
 *
 * `FakeSampler` reproduces the `mock_sampler` fixture in
 * `tests/unittests/optimization/simple_prompt_optimizer_test.py` from
 * google/adk-python (commit `44e0b2a8`).
 */

import {
  BaseLlm,
  BaseLlmConnection,
  BaseLlmType,
  LlmRequest,
  LlmResponse,
  SampleAndScoreParams,
  Sampler,
  UnstructuredSamplingResult,
} from '@google/adk';

/** Instruction the fake sampler rewards. */
export const IMPROVED_INSTRUCTION = 'IMPROVED PROMPT';

/** Score the fake sampler gives an instruction containing `IMPROVED`. */
export const IMPROVED_SCORE = 0.9;

/** Score the fake sampler gives every other instruction. */
export const BASELINE_SCORE = 0.5;

/** Training example UIDs of the Python fixture. */
export const TRAIN_EXAMPLE_IDS = ['1', '2', '3', '4', '5'];

/** Validation example UIDs of the Python fixture. */
export const VALIDATION_EXAMPLE_IDS = ['v1', 'v2'];

/** Options for {@link FakeSampler}. */
export interface FakeSamplerOptions {
  /** Training example UIDs. Defaults to the Python fixture's five. */
  trainIds?: string[];

  /**
   * Validation example UIDs. Defaults to the Python fixture's two. An empty
   * array makes the final validation return an empty scores map.
   */
  validationIds?: string[];
}

/**
 * Scores a candidate by whether its instruction says `IMPROVED`, and records
 * every call so a test can assert the counts the Python test asserts.
 */
export class FakeSampler extends Sampler<UnstructuredSamplingResult> {
  /** Every `sampleAndScore` call, in order. */
  readonly calls: SampleAndScoreParams[] = [];

  /** How many times `getTrainExampleIds` was called. */
  trainIdCallCount = 0;

  private readonly trainIds: string[];
  private readonly validationIds: string[];

  constructor({
    trainIds = TRAIN_EXAMPLE_IDS,
    validationIds = VALIDATION_EXAMPLE_IDS,
  }: FakeSamplerOptions = {}) {
    super();
    this.trainIds = trainIds;
    this.validationIds = validationIds;
  }

  override getTrainExampleIds(): string[] {
    this.trainIdCallCount++;
    return [...this.trainIds];
  }

  override getValidationExampleIds(): string[] {
    return [...this.validationIds];
  }

  override async sampleAndScore({
    candidate,
    exampleSet = Sampler.VALIDATION_SET,
    batch,
    captureFullEvalData = false,
  }: SampleAndScoreParams): Promise<UnstructuredSamplingResult> {
    this.calls.push({candidate, exampleSet, batch, captureFullEvalData});

    const ids =
      batch ??
      (exampleSet === Sampler.TRAIN_SET
        ? [...this.trainIds]
        : [...this.validationIds]);
    const instruction =
      typeof candidate.instruction === 'string' ? candidate.instruction : '';
    const score = instruction.includes('IMPROVED')
      ? IMPROVED_SCORE
      : BASELINE_SCORE;

    return {scores: Object.fromEntries(ids.map((id) => [id, score]))};
  }
}

/** Options for {@link createFakeOptimizerLlmClass}. */
export interface FakeOptimizerLlmOptions {
  /** Every request the fake received is pushed here, in order. */
  requests: LlmRequest[];

  /**
   * Responses yielded per call. Defaults to one response carrying
   * {@link IMPROVED_INSTRUCTION}.
   */
  responses?: LlmResponse[];
}

/**
 * Builds a `BaseLlm` subclass that records its requests and replays fixed
 * responses.
 *
 * Returned as a class rather than an instance because `LLMRegistry.newLlm`
 * constructs whatever `LLMRegistry.resolve` hands back. Install it with
 * `vi.spyOn(LLMRegistry, 'resolve').mockReturnValue(...)`, which is the method
 * the Python test patches and which bypasses the registry's cache.
 */
export function createFakeOptimizerLlmClass({
  requests,
  responses = [{content: {parts: [{text: IMPROVED_INSTRUCTION}]}}],
}: FakeOptimizerLlmOptions): BaseLlmType {
  return class FakeOptimizerLlm extends BaseLlm {
    static override readonly supportedModels: Array<string | RegExp> = [];

    override async *generateContentAsync(
      llmRequest: LlmRequest,
    ): AsyncGenerator<LlmResponse, void> {
      requests.push(llmRequest);
      for (const response of responses) {
        yield response;
      }
    }

    override connect(): Promise<BaseLlmConnection> {
      throw new Error('FakeOptimizerLlm has no live connection.');
    }
  };
}

/** Reads the prompt text out of a recorded request. */
export function promptTextOf(llmRequest: LlmRequest): string {
  return llmRequest.contents[0]?.parts?.[0]?.text ?? '';
}
