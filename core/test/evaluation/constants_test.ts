/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DEFAULT_LIVE_TIMEOUT_SECONDS,
  MISSING_EVAL_DEPENDENCIES_MESSAGE,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('evaluation/constants', () => {
  it('exposes the default live timeout', () => {
    expect(DEFAULT_LIVE_TIMEOUT_SECONDS).toBe(300);
  });

  it('exposes the missing eval dependencies message', () => {
    expect(MISSING_EVAL_DEPENDENCIES_MESSAGE).toBe(
      'Eval module is not installed, please install via `pip install' +
        ' "google-adk[eval]"`.',
    );
  });
});
