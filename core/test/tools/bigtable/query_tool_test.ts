/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Buffer} from 'node:buffer';
import {describe, expect, it, vi} from 'vitest';
import {BaseTool} from '../../../src/tools/base_tool.js';
import {BigtableClientCache} from '../../../src/tools/bigtable/client.js';
import {
  convertSqlValue,
  createQueryTool,
  toQueryParameters,
} from '../../../src/tools/bigtable/query_tool.js';
import {BigtableToolSettings} from '../../../src/tools/bigtable/settings.js';
import {
  createToolContext,
  FakeBigtable,
  FakeBigtableSetup,
  FakeEncodedKeyMap,
  fakeRow,
  FakeRow,
} from './bigtable_fakes.js';

vi.mock('@google-cloud/bigtable', () => ({Bigtable: FakeBigtable}));

const PROJECT = 'test-project';
const INSTANCE = 'test-instance';

/** Sets the SDK up to answer a query with `rows`, and builds the query tool. */
function queryToolFor(
  rows: FakeRow[],
  settings?: BigtableToolSettings,
  extra: FakeBigtableSetup = {},
): BaseTool {
  FakeBigtable.reset({
    ...extra,
    instances: {[INSTANCE]: {rows, ...extra.instances?.[INSTANCE]}},
  });
  return createQueryTool(new BigtableClientCache(), settings);
}

/** The instance the fake client opened, so a test can read what it recorded. */
function recordedInstance() {
  return FakeBigtable.created[0].instance(INSTANCE);
}

async function run(
  tool: BaseTool,
  args: Record<string, unknown>,
): Promise<unknown> {
  return tool.runAsync({args, toolContext: await createToolContext()});
}

describe('execute_sql', () => {
  it('returns the rows keyed by column name', async () => {
    const tool = queryToolFor([
      fakeRow([
        ['user_id', 1n],
        ['user_name', 'Alice'],
      ]),
    ]);

    const result = await run(tool, {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT * FROM mytable',
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [{user_id: '1', user_name: 'Alice'}],
    });
  });

  it('omits result_is_likely_truncated when the cap did not stop the read', async () => {
    const tool = queryToolFor([fakeRow([['a', 1]])], {maxQueryResultRows: 5});

    const result = await run(tool, {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT a FROM mytable',
    });

    expect(result).not.toHaveProperty('result_is_likely_truncated');
  });

  it('stops at the cap and flags the result as truncated', async () => {
    const rows = [1, 2, 3, 4].map((value) => fakeRow([['a', value]]));
    const tool = queryToolFor(rows, {maxQueryResultRows: 2});

    const result = await run(tool, {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT a FROM mytable',
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      rows: [{a: 1}, {a: 2}],
      result_is_likely_truncated: true,
    });
  });

  it('falls back to 50 rows when the settings ask for a non-positive cap', async () => {
    const rows = Array.from({length: 51}, (unused, index) =>
      fakeRow([['a', index]]),
    );
    const tool = queryToolFor(rows, {maxQueryResultRows: 0});

    const result = await run(tool, {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT a FROM mytable',
    });

    expect(result).toMatchObject({result_is_likely_truncated: true});
    expect((result as {rows: unknown[]}).rows).toHaveLength(50);
  });

  it('closes the query stream once the read is done', async () => {
    const tool = queryToolFor([fakeRow([['a', 1]])]);

    await run(tool, {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT a FROM mytable',
    });

    expect(recordedInstance().destroyedStreams).toBe(1);
  });

  it('converts each parameter to the native value its declared type needs', async () => {
    const tool = queryToolFor([]);

    await run(tool, {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT * FROM t WHERE id = @id AND live = @live AND k = @k',
      parameters: {id: 7, live: true, k: 'AQID'},
      parameter_types: {id: 'int64', live: 'bool', k: 'bytes'},
    });

    expect(recordedInstance().queries).toEqual([
      {
        query: 'SELECT * FROM t WHERE id = @id AND live = @live AND k = @k',
        parameterTypes: {
          id: {type: 'int64'},
          live: {type: 'bool'},
          k: {type: 'bytes'},
        },
        parameters: {id: 7n, live: true, k: Buffer.from([1, 2, 3])},
      },
    ]);
  });

  it('leaves the parameter types unset when the model declared none', async () => {
    const tool = queryToolFor([]);

    await run(tool, {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT 1',
    });

    expect(recordedInstance().queries[0].parameterTypes).toBeUndefined();
  });

  it('rejects a parameter type the SDK does not accept, before running', async () => {
    const tool = queryToolFor([]);

    // `FunctionTool` validates the arguments against the schema and rethrows,
    // so a malformed argument never reaches the tool body or its envelope.
    await expect(
      run(tool, {
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameter_types: {id: 'uint128'},
      }),
    ).rejects.toThrow(/parameter_types/);
    expect(FakeBigtable.created).toHaveLength(0);
  });

  it('returns the ERROR envelope when a parameter has no declared type', async () => {
    const tool = queryToolFor([]);

    const result = await run(tool, {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT * FROM t WHERE id = @id',
      parameters: {id: 7},
    });

    expect(result).toMatchObject({status: 'ERROR'});
    expect((result as {error_details: string}).error_details).toMatch(
      /'id' has no entry in parameter_types/,
    );
  });

  it('returns the ERROR envelope when the query fails', async () => {
    FakeBigtable.reset({
      instances: {[INSTANCE]: {error: new Error('invalid query')}},
    });
    const tool = createQueryTool(new BigtableClientCache());

    const result = await run(tool, {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT bad',
    });

    expect(result).toEqual({status: 'ERROR', error_details: 'invalid query'});
  });
});

describe('convertSqlValue', () => {
  it.each([
    ['null', null, null],
    ['undefined', undefined, null],
    ['a string', 'Alice', 'Alice'],
    ['a number', 42, 42],
    ['a boolean', true, true],
    ['an int64', 9007199254740993n, '9007199254740993'],
  ])('converts %s', (unused, value, expected) => {
    expect(convertSqlValue(value)).toBe(expected);
  });

  it('base64-encodes bytes', () => {
    expect(convertSqlValue(new Uint8Array([1, 2, 3]))).toBe('AQID');
  });

  it('renders a timestamp as ISO 8601', () => {
    expect(convertSqlValue(new Date(Date.UTC(2026, 0, 2, 3, 4, 5)))).toBe(
      '2026-01-02T03:04:05.000Z',
    );
  });

  it('renders a calendar date as YYYY-MM-DD', () => {
    expect(convertSqlValue({year: 2026, month: 1, day: 2})).toBe('2026-01-02');
  });

  it('converts an array element by element', () => {
    expect(convertSqlValue([1n, new Uint8Array([255])])).toEqual(['1', '/w==']);
  });

  it('converts a map into a plain object, encoding its keys', () => {
    const map = new Map<unknown, unknown>([
      ['name', 'Alice'],
      [7n, 'seven'],
    ]);

    expect(convertSqlValue(map)).toEqual({name: 'Alice', '7': 'seven'});
  });

  it('converts a struct into a plain object keyed by field name', () => {
    expect(
      convertSqlValue(
        fakeRow([
          ['id', 1n],
          ['ok', false],
        ]),
      ),
    ).toEqual({id: '1', ok: false});
  });

  it('drops a struct field the result set did not name', () => {
    expect(
      convertSqlValue(
        fakeRow([
          [null, 'anonymous'],
          ['named', 'kept'],
        ]),
      ),
    ).toEqual({named: 'kept'});
  });

  it('converts the SDK map, which implements Map without extending it', () => {
    const map = new FakeEncodedKeyMap([
      ['name', 'Alice'],
      [7n, 'seven'],
    ]);

    expect(map instanceof Map).toBe(false);
    expect(convertSqlValue(map)).toEqual({name: 'Alice', '7': 'seven'});
  });

  it('falls back to the string form of a value it cannot convert', () => {
    class Opaque {
      toString(): string {
        return 'opaque-value';
      }
    }

    expect(convertSqlValue(new Opaque())).toBe('opaque-value');
  });
});

describe('toQueryParameters', () => {
  it('accepts an int64 given as a decimal string', () => {
    expect(
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameters: {id: '9007199254740993'},
        parameter_types: {id: 'int64'},
      }),
    ).toEqual({id: 9007199254740993n});
  });

  it('rejects an int64 that is not a whole number', () => {
    expect(() =>
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameters: {id: 1.5},
        parameter_types: {id: 'int64'},
      }),
    ).toThrow(/'id' is not a valid int64: 1.5 is not a whole number/);
  });

  it('rejects an int64 that is not a number at all', () => {
    expect(() =>
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameters: {id: true},
        parameter_types: {id: 'int64'},
      }),
    ).toThrow(/'id' is not a valid int64: got a boolean/);
  });

  it('rejects bytes that are not canonical base64', () => {
    expect(() =>
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameters: {k: 'not base64!'},
        parameter_types: {k: 'bytes'},
      }),
    ).toThrow(/'k' is not a valid bytes: expected canonical base64/);
  });

  it('rejects bytes that are not a string', () => {
    expect(() =>
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameters: {k: 3},
        parameter_types: {k: 'bytes'},
      }),
    ).toThrow(/'k' is not a valid bytes: got a number/);
  });

  it.each([
    ['bool', 'yes'],
    ['string', 7],
    ['float32', 'x'],
    ['float64', 'x'],
  ] as const)('rejects a %s built from the wrong JSON type', (type, value) => {
    expect(() =>
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameters: {v: value},
        parameter_types: {v: type},
      }),
    ).toThrow(new RegExp(`'v' is not a valid ${type}: got a`));
  });

  it.each([
    ['bool', true],
    ['string', 'x'],
    ['float32', 1.5],
    ['float64', 1.5],
  ] as const)('passes a %s through unchanged', (type, value) => {
    expect(
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameters: {v: value},
        parameter_types: {v: type},
      }),
    ).toEqual({v: value});
  });

  it('keeps a null value, whatever its declared type', () => {
    expect(
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameters: {id: null},
        parameter_types: {id: 'int64'},
      }),
    ).toEqual({id: null});
  });

  it('rejects a parameter with no declared type', () => {
    expect(() =>
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameters: {id: 7},
      }),
    ).toThrow(/'id' has no entry in parameter_types/);
  });

  it('rejects a declared type with no value', () => {
    expect(() =>
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
        parameter_types: {id: 'int64'},
      }),
    ).toThrow(/'id' is declared in parameter_types but has no value/);
  });

  it('returns an empty bag when the query takes no parameters', () => {
    expect(
      toQueryParameters({
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT 1',
      }),
    ).toEqual({});
  });
});
