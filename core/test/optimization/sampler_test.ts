/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  LlmAgent,
  SampleAndScoreParams,
  Sampler,
  SamplingResult,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const TRAIN_IDS = ['t1', 't2'];
const VALIDATION_IDS = ['a', 'b'];

interface ScoredSamplingResult extends SamplingResult {
  captured: boolean;
  evaluatedSet: string;
}

/** Resolves the signature defaults the way `LocalEvalSampler` does. */
class TestSampler extends Sampler<ScoredSamplingResult> {
  override getTrainExampleIds(): string[] {
    return TRAIN_IDS;
  }

  override getValidationExampleIds(): string[] {
    return VALIDATION_IDS;
  }

  override async sampleAndScore({
    exampleSet = Sampler.VALIDATION_SET,
    batch,
    captureFullEvalData = false,
  }: SampleAndScoreParams): Promise<ScoredSamplingResult> {
    const ids =
      batch ??
      (exampleSet === Sampler.TRAIN_SET
        ? this.getTrainExampleIds()
        : this.getValidationExampleIds());
    const scores: Record<string, number> = {};
    for (const [index, id] of ids.entries()) {
      scores[id] = index;
    }
    return {scores, captured: captureFullEvalData, evaluatedSet: exampleSet};
  }
}

describe('Sampler', () => {
  const candidate = new LlmAgent({name: 'candidate'});
  const sampler = new TestSampler();

  it('names the two example sets', () => {
    expect(Sampler.TRAIN_SET).toBe('train');
    expect(Sampler.VALIDATION_SET).toBe('validation');
  });

  it('reports the two distinct example id lists', () => {
    expect(sampler.getTrainExampleIds()).toEqual(['t1', 't2']);
    expect(sampler.getValidationExampleIds()).toEqual(['a', 'b']);
  });

  it('evaluates the validation set and captures no extra data by default', async () => {
    const result = await sampler.sampleAndScore({candidate});

    expect(result.evaluatedSet).toBe('validation');
    expect(result.captured).toBe(false);
  });

  it('evaluates the train set when asked for it', async () => {
    const result = await sampler.sampleAndScore({
      candidate,
      exampleSet: Sampler.TRAIN_SET,
    });

    expect(result.evaluatedSet).toBe('train');
    expect(Object.keys(result.scores)).toEqual(['t1', 't2']);
  });

  it('scores every example of the chosen set when batch is omitted', async () => {
    const result = await sampler.sampleAndScore({candidate});

    expect(Object.keys(result.scores)).toEqual(['a', 'b']);
  });

  it('scores only the requested batch', async () => {
    const result = await sampler.sampleAndScore({candidate, batch: ['b']});

    expect(Object.keys(result.scores)).toEqual(['b']);
    expect(result.scores['b']).toBe(0);
  });

  it('passes captureFullEvalData through to the implementation', async () => {
    const result = await sampler.sampleAndScore({
      candidate,
      captureFullEvalData: true,
    });

    expect(result.captured).toBe(true);
  });

  it('resolves asynchronously', async () => {
    const pending = sampler.sampleAndScore({candidate});

    await expect(pending).resolves.toHaveProperty('scores');
  });
});
