/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';

import {
  BigtableToolSettings,
  DEFAULT_MAX_QUERY_RESULT_ROWS,
} from '../../../src/tools/bigtable/settings.js';

describe('BigtableToolSettings', () => {
  it('caps a query at 50 rows by default', () => {
    expect(new BigtableToolSettings().maxQueryResultRows).toBe(50);
    expect(DEFAULT_MAX_QUERY_RESULT_ROWS).toBe(50);
  });

  it('takes the row cap the caller names', () => {
    expect(
      new BigtableToolSettings({maxQueryResultRows: 20}).maxQueryResultRows,
    ).toBe(20);
  });

  it('keeps a row cap of zero rather than reading it as unset', () => {
    expect(
      new BigtableToolSettings({maxQueryResultRows: 0}).maxQueryResultRows,
    ).toBe(0);
  });
});
