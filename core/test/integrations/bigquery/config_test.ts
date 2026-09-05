/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/integrations/bigquery/test_bigquery_tool_config.py`
 * from google/adk-python (`main`), and adds the cases that cover the defaults,
 * the strict key validation and the enum string values.
 */

import {
  BigQueryToolConfig,
  InputValidationError,
  ResolvedBigQueryToolConfig,
  WriteMode,
  createBigQueryToolConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const BYTES_BILLED_MESSAGE =
  'In BigQuery on-demand pricing, charges are rounded up to the nearest MB,' +
  ' with a minimum 10 MB data processed per table referenced by the query,' +
  ' and with a minimum 10 MB data processed per query. So maximumBytesBilled' +
  ' must be set >=10485760.';

/**
 * Feeds the factory a JSON document, which is how unchecked input reaches it
 * in practice. TypeScript's excess-property check rejects an unknown key in an
 * object literal at compile time, so a parsed document is the only way to
 * exercise the runtime strictness.
 */
function createFromJson(json: string): ResolvedBigQueryToolConfig {
  return createBigQueryToolConfig(JSON.parse(json));
}

function makeLabels(count: number): Record<string, string> {
  return Object.fromEntries(
    Array.from({length: count}, (_unused, i) => [`key_${i}`, 'value']),
  );
}

describe('BigQuery tool config', () => {
  // The cases below carry the names of the reference tests.
  describe('ported from adk-python', () => {
    it('test_bigquery_tool_config_invalid_property', () => {
      expect(() =>
        createFromJson('{"nonExistentField": "some value"}'),
      ).toThrow(InputValidationError);
    });

    it('test_bigquery_tool_config_invalid_application_name', () => {
      expect(() =>
        createBigQueryToolConfig({applicationName: 'my agent'}),
      ).toThrow('Application name should not contain spaces.');
    });

    it('test_bigquery_tool_config_max_query_result_rows_default', () => {
      expect(createBigQueryToolConfig().maxQueryResultRows).toBe(50);
    });

    it('test_bigquery_tool_config_max_query_result_rows_custom', () => {
      const config = createBigQueryToolConfig({maxQueryResultRows: 100});

      expect(config.maxQueryResultRows).toBe(100);
    });

    it('test_bigquery_tool_config_valid_maximum_bytes_billed', () => {
      const config = createBigQueryToolConfig({
        maximumBytesBilled: 10_485_760,
      });

      expect(config.maximumBytesBilled).toBe(10_485_760);
    });

    it('test_bigquery_tool_config_invalid_maximum_bytes_billed', () => {
      expect(() =>
        createBigQueryToolConfig({maximumBytesBilled: 10_485_759}),
      ).toThrow(BYTES_BILLED_MESSAGE);
    });

    it('test_bigquery_tool_config_valid_labels[valid-labels]', () => {
      const jobLabels = {environment: 'test', team: 'data'};

      expect(createBigQueryToolConfig({jobLabels}).jobLabels).toEqual(
        jobLabels,
      );
    });

    it('test_bigquery_tool_config_valid_labels[empty-labels]', () => {
      expect(createBigQueryToolConfig({jobLabels: {}}).jobLabels).toEqual({});
    });

    // `undefined` stands in for Python's `None`.
    it('test_bigquery_tool_config_valid_labels[none-labels]', () => {
      const config = createBigQueryToolConfig({jobLabels: undefined});

      expect(config.jobLabels).toBeUndefined();
    });

    it('test_bigquery_tool_config_invalid_labels[invalid-type]', () => {
      expect(() => createFromJson('{"jobLabels": "invalid"}')).toThrow(
        'expected record, received string',
      );
    });

    it('test_bigquery_tool_config_invalid_labels[non-str-value]', () => {
      expect(() => createFromJson('{"jobLabels": {"key": 123}}')).toThrow(
        'expected string, received number',
      );
    });

    it('test_bigquery_tool_config_invalid_labels[empty-label-key]', () => {
      expect(() =>
        createBigQueryToolConfig({jobLabels: {'': 'value'}}),
      ).toThrow('Label keys cannot be empty.');
    });

    it('test_bigquery_tool_config_invalid_labels[internal-label-key]', () => {
      expect(() =>
        createBigQueryToolConfig({jobLabels: {'adk-bigquery-test': 'value'}}),
      ).toThrow(
        'Label key cannot start with "adk-bigquery-" as it is reserved for' +
          ' internal usage, found "adk-bigquery-test".',
      );
    });

    it('test_bigquery_tool_config_invalid_labels[too-many-labels]', () => {
      expect(() =>
        createBigQueryToolConfig({jobLabels: makeLabels(21)}),
      ).toThrow('Only up to 20 job labels can be provided');
    });

    it('test_bigquery_tool_config_accepts_exactly_twenty_labels', () => {
      const jobLabels = makeLabels(20);

      expect(createBigQueryToolConfig({jobLabels}).jobLabels).toEqual(
        jobLabels,
      );
    });

    it('test_bigquery_tool_config_allows_reserved_prefix_inside_a_key', () => {
      const jobLabels = {'team-adk-bigquery-owner': 'value'};

      expect(createBigQueryToolConfig({jobLabels}).jobLabels).toEqual(
        jobLabels,
      );
    });
  });

  describe('createBigQueryToolConfig', () => {
    it('resolves no argument to the full set of defaults', () => {
      expect(createBigQueryToolConfig()).toEqual({
        writeMode: WriteMode.BLOCKED,
        maximumBytesBilled: undefined,
        maxQueryResultRows: 50,
        applicationName: undefined,
        computeProjectId: undefined,
        location: undefined,
        jobLabels: undefined,
      });
    });

    it('defaults writeMode to BLOCKED', () => {
      expect(createBigQueryToolConfig({}).writeMode).toBe(WriteMode.BLOCKED);
    });

    it('spells the write modes as adk-python does', () => {
      expect(WriteMode.BLOCKED).toBe('blocked');
      expect(WriteMode.PROTECTED).toBe('protected');
      expect(WriteMode.ALLOWED).toBe('allowed');
    });

    it.each([WriteMode.BLOCKED, WriteMode.PROTECTED, WriteMode.ALLOWED])(
      'round-trips the %s write mode',
      (writeMode) => {
        expect(createBigQueryToolConfig({writeMode}).writeMode).toBe(writeMode);
      },
    );

    it('rejects an unknown writeMode string', () => {
      expect(() => createFromJson('{"writeMode": "readonly"}')).toThrow(
        'Invalid option: expected one of "blocked"|"protected"|"allowed"',
      );
    });

    it('passes the remaining fields through unchanged', () => {
      const config = createBigQueryToolConfig({
        applicationName: 'my-agent',
        computeProjectId: 'my-compute-project',
        location: 'us-central1',
      });

      expect(config).toMatchObject({
        applicationName: 'my-agent',
        computeProjectId: 'my-compute-project',
        location: 'us-central1',
      });
    });

    // adk-python's guard reads `if v and v < 10_485_760`, so a zero budget
    // skips the check. The two SDKs must agree on what they accept.
    it('accepts a zero maximumBytesBilled', () => {
      expect(createBigQueryToolConfig({maximumBytesBilled: 0})).toMatchObject({
        maximumBytesBilled: 0,
      });
    });

    it('accepts a maximumBytesBilled above the minimum', () => {
      const config = createBigQueryToolConfig({maximumBytesBilled: 10_485_761});

      expect(config.maximumBytesBilled).toBe(10_485_761);
    });

    it('rejects a maximumBytesBilled of 1', () => {
      expect(() => createBigQueryToolConfig({maximumBytesBilled: 1})).toThrow(
        BYTES_BILLED_MESSAGE,
      );
    });

    it('accepts an applicationName without a space', () => {
      const config = createBigQueryToolConfig({applicationName: 'my-agent'});

      expect(config.applicationName).toBe('my-agent');
    });

    // The count check runs before the per-key checks, as it does in the
    // reference, so a 21-label object with an empty key reports the count.
    it('reports the label count before it reports an empty key', () => {
      const jobLabels = {...makeLabels(20), '': 'value'};

      expect(() => createBigQueryToolConfig({jobLabels})).toThrow(
        'Only up to 20 job labels can be provided',
      );
    });

    // A JavaScript object key is a string by construction, so the reference's
    // non-string-key case has nothing to reject here.
    it('accepts a numeric-looking label key', () => {
      const config = createFromJson('{"jobLabels": {"123": "value"}}');

      expect(config.jobLabels).toEqual({'123': 'value'});
    });

    // adk-python accepts the snake_case spellings and this port rejects them,
    // so each one gets its own case.
    it.each(['write_mode', 'maximum_bytes_billed', 'job_labels'])(
      'rejects the snake_case %s spelling',
      (key) => {
        expect(() => createFromJson(`{"${key}": "allowed"}`)).toThrow(
          `Unrecognized key: "${key}"`,
        );
      },
    );

    it('returns a fresh object, not the caller object', () => {
      const params: BigQueryToolConfig = {location: 'us-central1'};

      const config = createBigQueryToolConfig(params);
      config.location = 'eu';

      expect(params.location).toBe('us-central1');
    });

    it('does not follow a later change to the caller object', () => {
      const params: BigQueryToolConfig = {jobLabels: {team: 'data'}};

      const config = createBigQueryToolConfig(params);
      params.location = 'eu';
      params.jobLabels!['team'] = 'other';

      expect(config.location).toBeUndefined();
      expect(config.jobLabels).toEqual({team: 'data'});
    });
  });
});
