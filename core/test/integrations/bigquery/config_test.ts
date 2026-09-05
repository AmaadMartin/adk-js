/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/integrations/bigquery/test_bigquery_tool_config.py`. The
 * ported cases keep their Python names, including the pytest parameter id.
 *
 * Python constructs a pydantic model; here the equivalent is parsing the same
 * fields with {@link createBigQueryToolSettings}, which the toolset calls from
 * its constructor. Three parameter cases of
 * `test_bigquery_tool_config_invalid_labels` are not ported: `invalid-type`,
 * `non-str-key` and `non-str-value` pass a value TypeScript rejects at compile
 * time, so there is no runtime path to exercise.
 */

import {
  MINIMUM_BYTES_BILLED,
  WriteMode,
  bigQueryToolConfigSchema,
  createBigQueryToolSettings,
} from '@google/adk/integrations/bigquery/index.js';
import {describe, expect, it} from 'vitest';

/** A label map with `count` distinct keys. */
function labels(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({length: count}, (_unused, index) => [`key_${index}`, 'value']),
  );
}

describe('BigQueryToolConfig', () => {
  it('test_bigquery_tool_config_invalid_property', () => {
    // TypeScript rejects an unknown property at compile time, so the runtime
    // guard is reached only through a value whose type is not known
    // statically, which is how a configuration read from a file arrives.
    const fromFile: unknown = {nonExistentField: 'some value'};
    expect(() => bigQueryToolConfigSchema.parse(fromFile)).toThrow(
      'Unrecognized key',
    );
  });

  it('test_bigquery_tool_config_invalid_application_name', () => {
    expect(() =>
      createBigQueryToolSettings({applicationName: 'my agent'}),
    ).toThrow('Application name should not contain spaces.');
  });

  it('test_bigquery_tool_config_max_query_result_rows_default', () => {
    expect(createBigQueryToolSettings().maxQueryResultRows).toBe(50);
  });

  it('test_bigquery_tool_config_max_query_result_rows_custom', () => {
    const config = createBigQueryToolSettings({maxQueryResultRows: 100});
    expect(config.maxQueryResultRows).toBe(100);
  });

  it('test_bigquery_tool_config_valid_maximum_bytes_billed', () => {
    const config = createBigQueryToolSettings({
      maximumBytesBilled: 10_485_760,
    });
    expect(config.maximumBytesBilled).toBe(10_485_760);
  });

  it('test_bigquery_tool_config_invalid_maximum_bytes_billed', () => {
    expect(() =>
      createBigQueryToolSettings({maximumBytesBilled: 10_485_759}),
    ).toThrow(
      'In BigQuery on-demand pricing, charges are rounded up to the nearest' +
        ' MB, with a minimum 10 MB data processed per table referenced by the' +
        ' query, and with a minimum 10 MB data processed per query. So' +
        ' max_bytes_billed must be set >=10485760.',
    );
  });

  const validLabelCases: Array<{
    id: string;
    jobLabels?: Record<string, string>;
  }> = [
    {id: 'valid-labels', jobLabels: {environment: 'test', team: 'data'}},
    {id: 'empty-labels', jobLabels: {}},
    {id: 'none-labels', jobLabels: undefined},
  ];

  it.each(validLabelCases)(
    'test_bigquery_tool_config_valid_labels[$id]',
    ({jobLabels}) => {
      expect(createBigQueryToolSettings({jobLabels}).jobLabels).toEqual(
        jobLabels,
      );
    },
  );

  it.each([
    {
      id: 'empty-label-key',
      jobLabels: {'': 'value'},
      message: 'Label keys cannot be empty',
    },
    {
      id: 'internal-label-key',
      jobLabels: {'adk-bigquery-test': 'value'},
      // ZodError renders its issues as JSON, so the quotes the reference
      // message carries arrive escaped.
      message: 'Label key cannot start with \\"adk-bigquery-\\"',
    },
    {
      id: 'too-many-labels',
      jobLabels: labels(21),
      message: 'Only up to 20 job labels can be provided',
    },
  ])(
    'test_bigquery_tool_config_invalid_labels[$id]',
    ({jobLabels, message}) => {
      expect(() => createBigQueryToolSettings({jobLabels})).toThrow(message);
    },
  );

  it('test_bigquery_tool_config_accepts_exactly_twenty_labels', () => {
    const jobLabels = labels(20);
    expect(createBigQueryToolSettings({jobLabels}).jobLabels).toEqual(
      jobLabels,
    );
  });

  it('test_bigquery_tool_config_allows_reserved_prefix_inside_a_key', () => {
    const jobLabels = {'team-adk-bigquery-owner': 'value'};
    expect(createBigQueryToolSettings({jobLabels}).jobLabels).toEqual(
      jobLabels,
    );
  });
});

describe('BigQueryToolConfig boundaries', () => {
  it('accepts the smallest byte budget BigQuery bills for', () => {
    const config = createBigQueryToolSettings({
      maximumBytesBilled: MINIMUM_BYTES_BILLED,
    });
    expect(config.maximumBytesBilled).toBe(MINIMUM_BYTES_BILLED);
  });

  it('accepts a zero byte budget, matching the reference guard', () => {
    // adk-python guards with `if v and v < 10_485_760`, so a falsy value skips
    // the check. The behaviour crosses the language boundary, so it is kept.
    expect(
      createBigQueryToolSettings({maximumBytesBilled: 0}).maximumBytesBilled,
    ).toBe(0);
  });

  it('defaults the write mode to blocked', () => {
    expect(createBigQueryToolSettings().writeMode).toBe(WriteMode.BLOCKED);
  });

  it('keeps every field the caller sets', () => {
    expect(
      createBigQueryToolSettings({
        writeMode: WriteMode.ALLOWED,
        applicationName: 'my-agent',
        computeProjectId: 'compute-project',
        location: 'us-central1',
        maxQueryResultRows: 7,
      }),
    ).toEqual({
      writeMode: WriteMode.ALLOWED,
      applicationName: 'my-agent',
      computeProjectId: 'compute-project',
      location: 'us-central1',
      maxQueryResultRows: 7,
    });
  });
});
