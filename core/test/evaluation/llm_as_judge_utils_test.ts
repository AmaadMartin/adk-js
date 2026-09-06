/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalStatus, getEvalStatus} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('getEvalStatus', () => {
  it('reports nothing evaluated for an absent score', () => {
    expect(getEvalStatus(undefined, 0.5)).toBe(EvalStatus.NOT_EVALUATED);
  });

  it('passes a score equal to the threshold', () => {
    expect(getEvalStatus(0.5, 0.5)).toBe(EvalStatus.PASSED);
  });

  it('fails a score below the threshold', () => {
    expect(getEvalStatus(0.49, 0.5)).toBe(EvalStatus.FAILED);
  });
});
