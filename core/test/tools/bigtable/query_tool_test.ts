/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {BaseTool} from '../../../src/tools/base_tool.js';
import {BigtableClientCache} from '../../../src/tools/bigtable/client.js';
import {
  convertSqlValue,
  createParameterizedQueryTool,
  createQueryTool,
  resolveViewParameters,
} from '../../../src/tools/bigtable/query_tool.js';
import {BigtableToolSettings} from '../../../src/tools/bigtable/settings.js';
import {logger} from '../../../src/utils/logger.js';
import {
  createToolContext,
  FakeBigtable,
  FakeBigtableSetup,
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

  it('passes the declared parameter types through to the SDK', async () => {
    const tool = queryToolFor([]);

    await run(tool, {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT * FROM t WHERE id = @id AND live = @live',
      parameters: {id: 7, live: true},
      parameter_types: {id: 'int64', live: 'bool'},
    });

    expect(recordedInstance().queries).toEqual([
      {
        query: 'SELECT * FROM t WHERE id = @id AND live = @live',
        parameterTypes: {id: {type: 'int64'}, live: {type: 'bool'}},
        parameters: {id: 7, live: true},
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

  it('falls back to the string form of a value it cannot convert', () => {
    class Opaque {
      toString(): string {
        return 'opaque-value';
      }
    }

    expect(convertSqlValue(new Opaque())).toBe('opaque-value');
  });
});

describe('resolveViewParameters', () => {
  it('reads a name the invocation answers', async () => {
    const context = await createToolContext({userId: 'test-user-123'});

    expect(resolveViewParameters(['user_id'], context)).toEqual({
      user_id: 'test-user-123',
    });
  });

  it('reads the camelCase spelling of the same name', async () => {
    const context = await createToolContext({userId: 'test-user-123'});

    expect(resolveViewParameters(['userId'], context)).toEqual({
      userId: 'test-user-123',
    });
  });

  it('resolves the session, invocation and agent names', async () => {
    const context = await createToolContext({agentName: 'bigtable_agent'});

    const resolved = resolveViewParameters(
      ['session_id', 'invocation_id', 'agent_name'],
      context,
    );

    expect(resolved).toEqual({
      session_id: context.sessionId,
      invocation_id: 'invocation-1',
      agent_name: 'bigtable_agent',
    });
  });

  it('resolves the camelCase spellings of the same three names', async () => {
    const context = await createToolContext({agentName: 'bigtable_agent'});

    const resolved = resolveViewParameters(
      ['sessionId', 'invocationId', 'agentName'],
      context,
    );

    expect(resolved).toEqual({
      sessionId: context.sessionId,
      invocationId: 'invocation-1',
      agentName: 'bigtable_agent',
    });
  });

  it('falls back to session state for a name the invocation does not answer', async () => {
    const context = await createToolContext({state: {tenant_id: 'tenant-xyz'}});

    expect(resolveViewParameters(['tenant_id'], context)).toEqual({
      tenant_id: 'tenant-xyz',
    });
  });

  it('resolves several names from both sources at once', async () => {
    const context = await createToolContext({
      userId: 'user-123',
      state: {tenant_id: 'tenant-xyz', agent_id: 'agent-123'},
    });

    expect(
      resolveViewParameters(['user_id', 'tenant_id', 'agent_id'], context),
    ).toEqual({
      user_id: 'user-123',
      tenant_id: 'tenant-xyz',
      agent_id: 'agent-123',
    });
  });

  it('skips a name that resolves nowhere', async () => {
    const context = await createToolContext();

    expect(resolveViewParameters(['unknown_name'], context)).toEqual({});
  });

  it('skips a state value Bigtable does not accept, and says so', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const context = await createToolContext({state: {tenant_id: {id: 1}}});

    expect(resolveViewParameters(['tenant_id'], context)).toEqual({});
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("Skipping view parameter 'tenant_id'"),
    );
    warn.mockRestore();
  });

  it('refuses to resolve anything without a context', () => {
    expect(() => resolveViewParameters(['user_id'])).toThrow(
      /needs a tool context/,
    );
  });
});

describe('execute_sql_parameterized', () => {
  it('sends the value the invocation resolved, not one the model supplied', async () => {
    FakeBigtable.reset({instances: {[INSTANCE]: {rows: []}}});
    const tool = createParameterizedQueryTool(new BigtableClientCache(), [
      'user_id',
    ]);

    await tool.runAsync({
      args: {
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT * FROM purchases',
        parameters: {user_id: 'attacker', other: 'kept'},
      },
      toolContext: await createToolContext({userId: 'test-user-123'}),
    });

    expect(recordedInstance().queries[0].parameters).toEqual({
      user_id: 'test-user-123',
      other: 'kept',
    });
  });

  it('reads the value at call time, so a login between calls is picked up', async () => {
    FakeBigtable.reset({instances: {[INSTANCE]: {rows: []}}});
    const tool = createParameterizedQueryTool(new BigtableClientCache(), [
      'user_id',
    ]);
    const args = {
      project_id: PROJECT,
      instance_id: INSTANCE,
      query: 'SELECT * FROM purchases',
    };

    await tool.runAsync({
      args,
      toolContext: await createToolContext({userId: 'anonymous'}),
    });
    await tool.runAsync({
      args,
      toolContext: await createToolContext({userId: 'authenticated-user-999'}),
    });

    expect(
      recordedInstance().queries.map((recorded) => recorded.parameters),
    ).toEqual([{user_id: 'anonymous'}, {user_id: 'authenticated-user-999'}]);
  });

  it('resolves several view parameters in one call', async () => {
    FakeBigtable.reset({instances: {[INSTANCE]: {rows: []}}});
    const tool = createParameterizedQueryTool(new BigtableClientCache(), [
      'user_id',
      'tenant_id',
    ]);

    await tool.runAsync({
      args: {
        project_id: PROJECT,
        instance_id: INSTANCE,
        query: 'SELECT * FROM purchases',
      },
      toolContext: await createToolContext({
        userId: 'user-123',
        state: {tenant_id: 'tenant-xyz'},
      }),
    });

    expect(recordedInstance().queries[0].parameters).toEqual({
      user_id: 'user-123',
      tenant_id: 'tenant-xyz',
    });
  });
});
