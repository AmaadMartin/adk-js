/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {DEFAULT_MAX_QUERY_RESULT_ROWS} from '../../../src/tools/bigtable/settings.js';

describe('DEFAULT_MAX_QUERY_RESULT_ROWS', () => {
  it('caps a query at 50 rows, as adk-python does', () => {
    expect(DEFAULT_MAX_QUERY_RESULT_ROWS).toBe(50);
  });
});
