/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/bigquery/test_bigquery_tool_config.py`
 * (branch `main`).
 */

import {
  createBigQueryToolConfig,
  WriteMode,
  type BigQueryToolConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  DEFAULT_MAX_QUERY_RESULT_ROWS,
  MINIMUM_BYTES_BILLED,
} from '../../../src/tools/bigquery/config.js';

/** Builds `count` distinct, valid job labels. */
function labels(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({length: count}, (_, i) => [`key_${i}`, 'value']),
  );
}

describe('createBigQueryToolConfig', () => {
  it('test_bigquery_tool_config_invalid_application_name', () => {
    expect(() =>
      createBigQueryToolConfig({applicationName: 'my agent'}),
    ).toThrow('Application name should not contain spaces.');
  });

  it('accepts an application name without a space', () => {
    expect(
      createBigQueryToolConfig({applicationName: 'my-agent'}),
    ).toMatchObject({applicationName: 'my-agent'});
  });

  it('test_bigquery_tool_config_max_query_result_rows_default', () => {
    expect(createBigQueryToolConfig().maxQueryResultRows).toBe(50);
    expect(DEFAULT_MAX_QUERY_RESULT_ROWS).toBe(50);
  });

  it('test_bigquery_tool_config_max_query_result_rows_custom', () => {
    expect(
      createBigQueryToolConfig({maxQueryResultRows: 100}).maxQueryResultRows,
    ).toBe(100);
  });

  it('test_bigquery_tool_config_valid_maximum_bytes_billed', () => {
    expect(
      createBigQueryToolConfig({maximumBytesBilled: MINIMUM_BYTES_BILLED})
        .maximumBytesBilled,
    ).toBe(10_485_760);
  });

  it('test_bigquery_tool_config_invalid_maximum_bytes_billed', () => {
    expect(() =>
      createBigQueryToolConfig({maximumBytesBilled: 10_485_759}),
    ).toThrow(
      'In BigQuery on-demand pricing, charges are rounded up to the nearest' +
        ' MB, with a minimum 10 MB data processed per table referenced by the' +
        ' query, and with a minimum 10 MB data processed per query. So' +
        ' max_bytes_billed must be set >=10485760.',
    );
  });

  it('accepts a maximumBytesBilled of zero, which means no cap', () => {
    expect(
      createBigQueryToolConfig({maximumBytesBilled: 0}).maximumBytesBilled,
    ).toBe(0);
  });

  const validLabelCases: Array<{
    id: string;
    value?: Record<string, string>;
  }> = [
    {id: 'valid-labels', value: {environment: 'test', team: 'data'}},
    {id: 'empty-labels', value: {}},
    {id: 'none-labels', value: undefined},
  ];

  it.each(validLabelCases)(
    'test_bigquery_tool_config_valid_labels ($id)',
    ({value}) => {
      expect(createBigQueryToolConfig({jobLabels: value}).jobLabels).toEqual(
        value,
      );
    },
  );

  it.each([
    {
      id: 'empty-label-key',
      value: {'': 'value'},
      message: 'Label keys cannot be empty.',
    },
    {
      id: 'internal-label-key',
      value: {'adk-bigquery-test': 'value'},
      message: 'Label key cannot start with "adk-bigquery-"',
    },
    {
      id: 'too-many-labels',
      value: labels(21),
      message: 'Only up to 20 job labels can be provided',
    },
  ])('test_bigquery_tool_config_invalid_labels ($id)', ({value, message}) => {
    expect(() => createBigQueryToolConfig({jobLabels: value})).toThrow(message);
  });

  it('test_bigquery_tool_config_accepts_exactly_twenty_labels', () => {
    const twenty = labels(20);
    expect(createBigQueryToolConfig({jobLabels: twenty}).jobLabels).toEqual(
      twenty,
    );
  });

  it('test_bigquery_tool_config_allows_reserved_prefix_inside_a_key', () => {
    const value = {'team-adk-bigquery-owner': 'value'};
    expect(createBigQueryToolConfig({jobLabels: value}).jobLabels).toEqual(
      value,
    );
  });

  it('defaults the write mode to BLOCKED', () => {
    expect(createBigQueryToolConfig().writeMode).toBe(WriteMode.BLOCKED);
    expect(
      createBigQueryToolConfig({writeMode: WriteMode.ALLOWED}).writeMode,
    ).toBe(WriteMode.ALLOWED);
  });

  it('copies the job labels, so a later change cannot reach the tools', () => {
    const jobLabels = {team: 'data'};
    const resolved = createBigQueryToolConfig({jobLabels});

    jobLabels.team = 'other';

    expect(resolved.jobLabels).toEqual({team: 'data'});
  });

  it('does not change the config it was given', () => {
    const config: BigQueryToolConfig = {};

    createBigQueryToolConfig(config);

    expect(config).toEqual({});
  });
});
