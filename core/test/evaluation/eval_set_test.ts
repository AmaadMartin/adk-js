/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {EvalSetSchema} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('evaluation/eval_set', () => {
  it('parses with required fields and defaults creationTimestamp', () => {
    const evalSet = EvalSetSchema.parse({
      evalSetId: 'set-1',
      evalCases: [{evalId: 'case-1', conversation: []}],
    });
    expect(evalSet.evalSetId).toBe('set-1');
    expect(evalSet.evalCases).toHaveLength(1);
    expect(evalSet.creationTimestamp).toBe(0);
    expect(evalSet.name).toBeUndefined();
    expect(evalSet.description).toBeUndefined();
  });

  it('requires evalCases', () => {
    expect(EvalSetSchema.safeParse({evalSetId: 'set-1'}).success).toBe(false);
  });

  it('rejects unknown keys (strict)', () => {
    expect(
      EvalSetSchema.safeParse({
        evalSetId: 'set-1',
        evalCases: [],
        extra: 1,
      }).success,
    ).toBe(false);
  });

  it('survives JSON round-trip', () => {
    const evalSet = EvalSetSchema.parse({
      evalSetId: 'set-1',
      name: 'My set',
      evalCases: [{evalId: 'case-1', conversation: []}],
    });
    expect(EvalSetSchema.parse(JSON.parse(JSON.stringify(evalSet)))).toEqual(
      evalSet,
    );
  });
});
