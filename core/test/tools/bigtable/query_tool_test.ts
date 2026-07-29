/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Bigtable, SqlTypes} from '@google-cloud/bigtable';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import * as queryTool from '../../../src/tools/bigtable/query_tool.js';

import type {FakeBigtable, FakeInstance} from './bigtable_test_utils.js';
import {
  expectErrorDetails,
  expectSuccess,
  fakeInstance,
  fakeNamedList,
  fakeQueryStream,
} from './bigtable_test_utils.js';

const {bigtableMock, BigtableMock} = vi.hoisted(() => {
  const bigtableMock: FakeBigtable = {
    projectId: 'proj',
    getInstances: vi.fn(),
    instance: vi.fn(),
    close: vi.fn(async () => []),
  };
  return {bigtableMock, BigtableMock: vi.fn(() => bigtableMock)};
});

vi.mock('@google-cloud/bigtable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google-cloud/bigtable')>()),
  Bigtable: BigtableMock,
}));

const PREPARED_STATEMENT = {handle: 'prepared'};

describe('Bigtable Query Tool', () => {
  // Runtime value is `bigtableMock`; the type is the real client, which is
  // what the tools are declared against.
  let client: Bigtable;
  let instance: FakeInstance;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new Bigtable({projectId: 'proj'});
    instance = fakeInstance();
    instance.prepareStatement.mockResolvedValue([PREPARED_STATEMENT]);
    bigtableMock.instance.mockReturnValue(instance);
  });

  it('prepares the statement and streams the rows column-wise', async () => {
    instance.createExecuteQueryStream.mockReturnValue(
      fakeQueryStream([
        fakeNamedList([
          ['name', 'Alice'],
          ['age', 30n],
        ]),
        fakeNamedList([
          ['name', 'Bob'],
          ['age', 40n],
        ]),
      ]),
    );

    const result = expectSuccess(
      await queryTool.executeSql(client, {
        instanceId: 'inst',
        query: 'SELECT name, age FROM users WHERE name = @name',
        parameters: {name: 'Alice'},
        parameterTypes: {name: 'string'},
        settings: {maxQueryResultRows: 50},
      }),
    );

    expect(result.rows).toEqual([
      {name: 'Alice', age: '30'},
      {name: 'Bob', age: '40'},
    ]);
    expect(result.result_is_likely_truncated).toBe(false);
    expect(instance.prepareStatement).toHaveBeenCalledWith({
      query: 'SELECT name, age FROM users WHERE name = @name',
      parameterTypes: {name: SqlTypes.String()},
    });
    expect(instance.createExecuteQueryStream).toHaveBeenCalledWith({
      preparedStatement: PREPARED_STATEMENT,
      parameters: {name: 'Alice'},
    });
  });

  it('lets trusted view parameters override model-supplied values', async () => {
    instance.createExecuteQueryStream.mockReturnValue(fakeQueryStream([]));

    await queryTool.executeSql(client, {
      instanceId: 'inst',
      query: 'SELECT * FROM v WHERE user = @user_id',
      parameters: {user_id: 'attacker', other: 'kept'},
      viewParameters: {user_id: 'alice123'},
    });

    expect(instance.createExecuteQueryStream).toHaveBeenCalledWith({
      preparedStatement: PREPARED_STATEMENT,
      parameters: {user_id: 'alice123', other: 'kept'},
    });
  });

  it('encodes bytes, structs, maps and arrays as JSON-safe values', async () => {
    instance.createExecuteQueryStream.mockReturnValue(
      fakeQueryStream([
        fakeNamedList([
          ['bytes', new Uint8Array([1, 2, 3])],
          [
            'struct',
            fakeNamedList([
              ['inner', 7n],
              [null, 'unnamed'],
            ]),
          ],
          ['map', new Map([['k', 'v']])],
          ['when', new Date('2026-01-02T03:04:05.000Z')],
          ['list', [1n, 'two', null]],
          // A `BigtableDate` is a plain year/month/day object.
          ['day', {year: 2026, month: 1, day: 2}],
          ['missing', null],
          ['unset', undefined],
        ]),
      ]),
    );

    const result = expectSuccess(
      await queryTool.executeSql(client, {
        instanceId: 'inst',
        query: 'SELECT *',
      }),
    );

    expect(result.rows).toEqual([
      {
        bytes: 'AQID',
        struct: {inner: '7', '1': 'unnamed'},
        map: {k: 'v'},
        when: '2026-01-02T03:04:05.000Z',
        list: ['1', 'two', null],
        day: {year: 2026, month: 1, day: 2},
        missing: null,
        unset: null,
      },
    ]);
  });

  it('truncates at the configured row limit', async () => {
    instance.createExecuteQueryStream.mockReturnValue(
      fakeQueryStream([
        fakeNamedList([['id', 1]]),
        fakeNamedList([['id', 2]]),
        fakeNamedList([['id', 3]]),
      ]),
    );

    const result = expectSuccess(
      await queryTool.executeSql(client, {
        instanceId: 'inst',
        query: 'SELECT id FROM t',
        settings: {maxQueryResultRows: 2},
      }),
    );

    expect(result.rows).toEqual([{id: 1}, {id: 2}]);
    expect(result.result_is_likely_truncated).toBe(true);
  });

  it('omits parameterTypes when the model declares none', async () => {
    instance.createExecuteQueryStream.mockReturnValue(fakeQueryStream([]));

    await queryTool.executeSql(client, {
      instanceId: 'inst',
      query: 'SELECT 1',
    });

    expect(instance.prepareStatement).toHaveBeenCalledWith({
      query: 'SELECT 1',
      parameterTypes: undefined,
    });
  });

  it('reports the failure instead of throwing', async () => {
    instance.createExecuteQueryStream.mockImplementation(() => {
      throw new Error('fail');
    });

    expect(
      expectErrorDetails(
        await queryTool.executeSql(client, {
          instanceId: 'inst',
          query: 'SELECT 1',
        }),
      ),
    ).toContain('fail');
  });

  it('reports a row that is not a QueryResultRow', async () => {
    instance.createExecuteQueryStream.mockReturnValue(
      (async function* () {
        yield {name: 'Alice'};
      })(),
    );

    expect(
      expectErrorDetails(
        await queryTool.executeSql(client, {
          instanceId: 'inst',
          query: 'SELECT 1',
        }),
      ),
    ).toContain('not a QueryResultRow');
  });
});
