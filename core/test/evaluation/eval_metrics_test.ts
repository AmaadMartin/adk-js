/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalStatus} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('EvalStatus', () => {
  it('names the statuses the way the CSV output reports them', () => {
    expect(EvalStatus[EvalStatus.PASSED]).toBe('PASSED');
    expect(EvalStatus[EvalStatus.FAILED]).toBe('FAILED');
    expect(EvalStatus[EvalStatus.NOT_EVALUATED]).toBe('NOT_EVALUATED');
  });
});
