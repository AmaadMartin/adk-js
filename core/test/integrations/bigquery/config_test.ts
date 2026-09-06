/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/integrations/bigquery/test_bigquery_tool_config.py`
 * from google/adk-python (`main`), and adds the cases that cover the strict
 * key validation, the defaults and the freshness of the returned object.
 */

import {
  BigQueryToolConfig,
  InputValidationError,
  WriteMode,
  createBigQueryToolConfig,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const MINIMUM_BYTES_BILLED = 10_485_760;

/**
 * The factory reports every shape rejection under its own prefix. The tests
 * pin that prefix rather than zod's wording, which is not this port's
 * contract.
 */
const INVALID_SHAPE_MESSAGE = /^Invalid BigQueryToolConfig:/;

const INVALID_BYTES_BILLED_MESSAGE =
  'In BigQuery on-demand pricing, charges are rounded up to the nearest MB,' +
  ' with a minimum 10 MB data processed per table referenced by the query,' +
  ' and with a minimum 10 MB data processed per query. So maximumBytesBilled' +
  ' must be set >=10485760.';

/**
 * Feeds the factory a JSON document, which is how unchecked input reaches it
 * in practice. TypeScript cannot check a parsed document, so this exercises
 * the runtime validation rather than the compiler's excess-property check.
 */
function createFromJson(json: string): BigQueryToolConfig {
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
        createFromJson('{"non_existent_field": "some value"}'),
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
        maximumBytesBilled: MINIMUM_BYTES_BILLED,
      });

      expect(config.maximumBytesBilled).toBe(MINIMUM_BYTES_BILLED);
    });

    it('test_bigquery_tool_config_invalid_maximum_bytes_billed', () => {
      expect(() =>
        createBigQueryToolConfig({maximumBytesBilled: 10_485_759}),
      ).toThrow(INVALID_BYTES_BILLED_MESSAGE);
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

    it('test_bigquery_tool_config_valid_labels[none-labels]', () => {
      const config = createBigQueryToolConfig({jobLabels: undefined});

      expect(config.jobLabels).toBeUndefined();
    });

    it('test_bigquery_tool_config_invalid_labels[invalid-type]', () => {
      expect(() => createFromJson('{"jobLabels": "invalid"}')).toThrow(
        INVALID_SHAPE_MESSAGE,
      );
    });

    it('test_bigquery_tool_config_invalid_labels[non-str-value]', () => {
      expect(() => createFromJson('{"jobLabels": {"key": 123}}')).toThrow(
        INVALID_SHAPE_MESSAGE,
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
    it('gives WriteMode the wire values adk-python uses', () => {
      expect(WriteMode.BLOCKED).toBe('blocked');
      expect(WriteMode.PROTECTED).toBe('protected');
      expect(WriteMode.ALLOWED).toBe('allowed');
    });

    it('defaults to a read-only write mode', () => {
      expect(createBigQueryToolConfig().writeMode).toBe(WriteMode.BLOCKED);
    });

    it('keeps an explicit write mode', () => {
      const config = createBigQueryToolConfig({writeMode: WriteMode.ALLOWED});

      expect(config.writeMode).toBe(WriteMode.ALLOWED);
    });

    it('leaves every optional field unset by default', () => {
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

    it('round-trips the compute project and the location', () => {
      const config = createBigQueryToolConfig({
        computeProjectId: 'my-compute-project',
        location: 'us-central1',
      });

      expect(config.computeProjectId).toBe('my-compute-project');
      expect(config.location).toBe('us-central1');
    });

    it('accepts the minimum bytes billed and rejects one byte below it', () => {
      expect(
        createBigQueryToolConfig({maximumBytesBilled: MINIMUM_BYTES_BILLED})
          .maximumBytesBilled,
      ).toBe(MINIMUM_BYTES_BILLED);
      expect(() =>
        createBigQueryToolConfig({
          maximumBytesBilled: MINIMUM_BYTES_BILLED - 1,
        }),
      ).toThrow(InputValidationError);
    });

    // adk-python guards with `if v and v < ...`, so zero skips the check.
    it('accepts a zero bytes-billed cap', () => {
      expect(
        createBigQueryToolConfig({maximumBytesBilled: 0}).maximumBytesBilled,
      ).toBe(0);
    });

    it('rejects a negative bytes-billed cap', () => {
      expect(() => createBigQueryToolConfig({maximumBytesBilled: -1})).toThrow(
        INVALID_BYTES_BILLED_MESSAGE,
      );
    });

    it('accepts an application name without a space', () => {
      const config = createBigQueryToolConfig({applicationName: 'my-agent'});

      expect(config.applicationName).toBe('my-agent');
    });

    // adk-python guards with `if v and ' ' in v`, so an empty name skips the
    // check.
    it('accepts an empty application name', () => {
      expect(
        createBigQueryToolConfig({applicationName: ''}).applicationName,
      ).toBe('');
    });

    it('rejects an unknown key', () => {
      expect(() => createFromJson('{"region": "us-central1"}')).toThrow(
        INVALID_SHAPE_MESSAGE,
      );
    });

    // adk-python names its fields in snake_case; this port names them in
    // camelCase, so the snake_case spellings are unknown keys here.
    it('rejects the snake_case write_mode spelling', () => {
      expect(() => createFromJson('{"write_mode": "blocked"}')).toThrow(
        InputValidationError,
      );
    });

    it('rejects the snake_case job_labels spelling', () => {
      expect(() => createFromJson('{"job_labels": {}}')).toThrow(
        InputValidationError,
      );
    });

    it('rejects a write mode outside the enum', () => {
      expect(() => createFromJson('{"writeMode": "readonly"}')).toThrow(
        INVALID_SHAPE_MESSAGE,
      );
    });

    it('rejects a fractional row cap', () => {
      expect(() => createFromJson('{"maxQueryResultRows": 1.5}')).toThrow(
        INVALID_SHAPE_MESSAGE,
      );
    });

    it('rejects params that are not an object', () => {
      expect(() => createFromJson('"not-an-object"')).toThrow(
        INVALID_SHAPE_MESSAGE,
      );
    });

    it('returns a fresh object, not the caller object', () => {
      const params: Partial<BigQueryToolConfig> = {
        applicationName: 'my-agent',
        jobLabels: {environment: 'prod'},
      };

      const config = createBigQueryToolConfig(params);
      config.applicationName = 'another-agent';
      if (!config.jobLabels) {
        expect.fail('the returned config should carry jobLabels');
      }
      config.jobLabels['environment'] = 'dev';

      expect(params.applicationName).toBe('my-agent');
      expect(params.jobLabels).toEqual({environment: 'prod'});
    });
  });
});
