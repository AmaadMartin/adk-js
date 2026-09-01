/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {MISSING_EVAL_DEPENDENCIES_MESSAGE} from '../../src/evaluation/constants.js';
import {loadCreateEvalService} from '../../src/evaluation/eval_runtime.js';

describe('loadCreateEvalService', () => {
  it('reports that the local eval service is not part of this build', async () => {
    await expect(loadCreateEvalService()).rejects.toThrowError(
      MISSING_EVAL_DEPENDENCIES_MESSAGE,
    );
  });

  it('keeps the load failure as the cause', async () => {
    const error = await loadCreateEvalService().catch((err: unknown) => err);

    expect(error).toBeInstanceOf(Error);
    expect(error).toHaveProperty('cause');
  });
});
