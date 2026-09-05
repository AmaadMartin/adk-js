/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the `{status: "ERROR", error_details: ...}` envelope every BigQuery
 * tool returns instead of throwing, as adk-python
 * `src/google/adk/integrations/bigquery/` does (branch `main`).
 */

import {
  bigQueryToolError,
  isBigQueryToolError,
  runBigQueryTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('runBigQueryTool', () => {
  it('returns the body value when the body resolves', async () => {
    await expect(runBigQueryTool(async () => ['a', 'b'])).resolves.toEqual([
      'a',
      'b',
    ]);
  });

  it('turns a thrown error into the failure envelope', async () => {
    const result = await runBigQueryTool(async () => {
      throw new Error('Not found: Table my-table');
    });

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'Not found: Table my-table',
    });
  });

  it('turns a thrown non-error into the failure envelope', async () => {
    const result = await runBigQueryTool(async () => {
      throw 'plain string failure';
    });

    expect(isBigQueryToolError(result)).toBe(true);
    expect(result).toMatchObject({status: 'ERROR'});
  });
});

describe('isBigQueryToolError', () => {
  it('recognises the envelope', () => {
    expect(isBigQueryToolError(bigQueryToolError('boom'))).toBe(true);
  });

  it.each([
    {id: 'success payload', value: {status: 'SUCCESS', rows: []}},
    {id: 'plain list', value: ['a']},
    {id: 'null', value: null},
    {id: 'string', value: 'ERROR'},
  ])('rejects a $id', ({value}) => {
    expect(isBigQueryToolError(value)).toBe(false);
  });
});
