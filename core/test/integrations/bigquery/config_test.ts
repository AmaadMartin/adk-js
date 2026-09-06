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
import {
  MINIMUM_BYTES_BILLED,
  bigQueryToolConfigSchema,
  createBigQueryToolSettings,
} from '@google/adk/integrations/bigquery/index.js';
import {describe, expect, it} from 'vitest';

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
