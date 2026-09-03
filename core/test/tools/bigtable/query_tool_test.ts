/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bigtable} from '@google-cloud/bigtable';
import {describe, expect, it, vi} from 'vitest';

import {BigtableClientPool} from '../../../src/tools/bigtable/client.js';
import {executeSql} from '../../../src/tools/bigtable/query_tool.js';
import {GoogleToolStatus} from '../../../src/tools/google_tool.js';

import {
  type FakeInstanceData,
  fakeBigtableState,
  resetFakeBigtable,
} from './bigtable_fakes.js';

vi.mock('@google-cloud/bigtable', async () => ({
  Bigtable: (await import('./bigtable_fakes.js')).FakeBigtable,
}));

const PROJECT = 'test-project';
const INSTANCE = 'test-instance';
const QUERY = 'SELECT * FROM users';

/** A client backed by the fake SDK, loaded the way the tools load it. */
async function clientWith(data: FakeInstanceData): Promise<Bigtable> {
  resetFakeBigtable({instanceData: {[INSTANCE]: data}});
  return new BigtableClientPool().get(PROJECT);
}

describe('executeSql', () => {
  it('returns the rows the query matched', async () => {
    const client = await clientWith({
      rows: [
        [
          ['user_id', 1n],
          ['user_name', 'Alice'],
        ],
      ],
    });

    const result = await executeSql(client, {
      instanceId: INSTANCE,
      query: QUERY,
      maxRows: 50,
    });

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      rows: [{user_id: '1', user_name: 'Alice'}],
    });
  });

  it('stops at the row cap and flags the result as truncated', async () => {
    const client = await clientWith({
      rows: [[['n', 1]], [['n', 2]], [['n', 3]]],
    });

    const result = await executeSql(client, {
      instanceId: INSTANCE,
      query: QUERY,
      maxRows: 2,
    });

    expect(result.rows).toEqual([{n: 1}, {n: 2}]);
    expect(result.resultIsLikelyTruncated).toBe(true);
  });

  it('does not flag a result the cap exactly fits', async () => {
    const client = await clientWith({rows: [[['n', 1]], [['n', 2]]]});

    const result = await executeSql(client, {
      instanceId: INSTANCE,
      query: QUERY,
      maxRows: 2,
    });

    expect(result.rows).toHaveLength(2);
    expect(result.resultIsLikelyTruncated).toBeUndefined();
  });

  it('returns no rows when the cap is zero', async () => {
    const client = await clientWith({rows: [[['n', 1]]]});

    const result = await executeSql(client, {
      instanceId: INSTANCE,
      query: QUERY,
      maxRows: 0,
    });

    expect(result.rows).toEqual([]);
    expect(result.resultIsLikelyTruncated).toBe(true);
  });

  it('declares each parameter type the model named', async () => {
    const client = await clientWith({rows: []});

    await executeSql(client, {
      instanceId: INSTANCE,
      query: 'SELECT * FROM users WHERE user_id = @id AND active = @active',
      parameters: {id: 'u1', active: true},
      parameterTypes: {id: 'string', active: 'bool'},
      maxRows: 50,
    });

    expect(fakeBigtableState.calls.prepared[0]).toEqual({
      query: 'SELECT * FROM users WHERE user_id = @id AND active = @active',
      parameterTypes: {id: {type: 'string'}, active: {type: 'bool'}},
    });
    expect(fakeBigtableState.calls.queried[0]['parameters']).toEqual({
      id: 'u1',
      active: true,
    });
  });

  it('declares no parameter types when the query takes none', async () => {
    const client = await clientWith({rows: []});

    await executeSql(client, {
      instanceId: INSTANCE,
      query: QUERY,
      maxRows: 50,
    });

    expect(fakeBigtableState.calls.prepared[0]['parameterTypes']).toEqual({});
  });

  it('skips a stream element that is not a row', async () => {
    const client = await clientWith({streamValues: ['not a row', null]});

    const result = await executeSql(client, {
      instanceId: INSTANCE,
      query: QUERY,
      maxRows: 50,
    });

    expect(result.rows).toEqual([]);
  });

  it('closes the stream even when the query fails', async () => {
    const client = await clientWith({
      rows: [],
      prepareError: new Error('invalid query'),
    });

    await expect(
      executeSql(client, {instanceId: INSTANCE, query: QUERY, maxRows: 50}),
    ).rejects.toThrow('invalid query');
    expect(fakeBigtableState.calls.queried).toEqual([]);
  });

  it('closes the stream once the rows are read', async () => {
    const client = await clientWith({rows: [[['n', 1]]]});

    await executeSql(client, {
      instanceId: INSTANCE,
      query: QUERY,
      maxRows: 50,
    });

    expect(fakeBigtableState.calls.streamsEnded).toBe(1);
  });
});
