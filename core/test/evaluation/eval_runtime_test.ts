/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {MISSING_EVAL_DEPENDENCIES_MESSAGE} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  isEvalRuntime,
  loadEvalRuntime,
} from '../../src/evaluation/eval_runtime.js';

describe('loadEvalRuntime', () => {
  it('reports that the local eval service is not part of this build', async () => {
    await expect(loadEvalRuntime()).rejects.toThrowError(
      MISSING_EVAL_DEPENDENCIES_MESSAGE,
    );
  });

  it('keeps the load failure as the cause', async () => {
    const error = await loadEvalRuntime().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('cause');
  });
});

describe('isEvalRuntime', () => {
  it('accepts a module that exports createEvalService', () => {
    expect(isEvalRuntime({createEvalService: () => undefined})).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['a module with no createEvalService', {}],
    [
      'a module whose createEvalService is not callable',
      {createEvalService: 1},
    ],
  ])('rejects %s', (_name, value) => {
    expect(isEvalRuntime(value)).toBe(false);
  });
});
