/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Sampler,
  type GepaEngine,
  type GepaOptimizeParams,
  type GepaRunResult,
  type SampleAndScoreParams,
  type UnstructuredSamplingResult,
} from '@google/adk';
import {expect} from 'vitest';
import {resetLogger, setLogger} from '../../src/utils/logger.js';

/** Parameters for the {@link RecordingSampler} constructor. */
export interface RecordingSamplerParams {
  /** The UIDs reported as the training set. */
  trainIds: string[];

  /** The UIDs reported as the validation set. */
  validationIds: string[];

  /** The result every `sampleAndScore` call returns. */
  result: UnstructuredSamplingResult;
}

/** A sampler that records every call and returns one fixed result. */
export class RecordingSampler extends Sampler<UnstructuredSamplingResult> {
  /** Every `sampleAndScore` call, in order. */
  readonly calls: SampleAndScoreParams[] = [];

  private readonly trainIds: string[];
  private readonly validationIds: string[];
  private readonly result: UnstructuredSamplingResult;

  constructor({trainIds, validationIds, result}: RecordingSamplerParams) {
    super();
    this.trainIds = trainIds;
    this.validationIds = validationIds;
    this.result = result;
  }

  override getTrainExampleIds(): string[] {
    return this.trainIds;
  }

  override getValidationExampleIds(): string[] {
    return this.validationIds;
  }

  override async sampleAndScore(
    params: SampleAndScoreParams,
  ): Promise<UnstructuredSamplingResult> {
    this.calls.push(params);
    return this.result;
  }
}

/** An engine that records its params and reports a fixed run result. */
export class FakeGepaEngine implements GepaEngine {
  /** Every `optimize` call, in order. */
  readonly calls: GepaOptimizeParams[] = [];

  constructor(private readonly result: GepaRunResult) {}

  async optimize(params: GepaOptimizeParams): Promise<GepaRunResult> {
    this.calls.push(params);
    return this.result;
  }
}

/**
 * Builds the result a GEPA engine reports.
 *
 * @param candidates The candidates on the Pareto front.
 * @param valAggregateScores One validation score per candidate.
 * @param dict What `toDict` reports.
 */
export function runResult(
  candidates: Array<Record<string, string>>,
  valAggregateScores: number[],
  dict: Record<string, unknown> = {},
): GepaRunResult {
  return {candidates, valAggregateScores, toDict: () => dict};
}

/** Returns the single `optimize` call the engine received. */
export function onlyOptimizeCall(engine: FakeGepaEngine): GepaOptimizeParams {
  expect(engine.calls).toHaveLength(1);
  return engine.calls[0];
}

/**
 * Runs `body` with a logger that collects warnings.
 *
 * @returns Every warning logged while `body` ran, in order.
 */
export async function collectWarnings(
  body: () => Promise<void>,
): Promise<string[]> {
  const warnings: string[] = [];
  setLogger({
    setLogLevel: () => {},
    log: () => {},
    debug: () => {},
    info: () => {},
    warn: (...args: unknown[]) => {
      warnings.push(args.map((arg) => String(arg)).join(' '));
    },
    error: () => {},
  });
  try {
    await body();
  } finally {
    resetLogger();
  }
  return warnings;
}
