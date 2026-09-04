/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Migration cases `google/adk-python`'s test suite does not have, because they
 * are specific to how adk-js reads a column or reports a failure. The ported
 * reference tests live in `migrate_from_sqlalchemy_pickle_test.ts`.
 */

import {MikroORM} from '@mikro-orm/core';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

import {getConnectionOptionsFromUri} from '../../../src/sessions/db/operations.js';
import {
  SCHEMA_VERSION_KEY,
  StorageEvent,
  StorageMetadata,
} from '../../../src/sessions/db/schema.js';
import {
  getStateObject,
  migrate,
  rowToEvent,
  toDateObject,
  toSyncUrl,
} from '../../../src/sessions/migration/migrate_from_sqlalchemy_pickle.js';
import {logger} from '../../../src/utils/logger.js';
import {fromBase64} from '../../utils/pickle_payload_test_utils.js';
import {SIMPLE_STATE_DELTA} from '../pickled_actions_fixtures.js';
import {
  createV0Database,
  openRawDatabase,
  V0_TIMESTAMP,
} from './v0_database.js';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'adk-migration-extra-'));
});

afterAll(async () => {
  await rm(workDir, {recursive: true, force: true});
});

beforeEach(() => {
  vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

function databasePaths(name: string): {source: string; dest: string} {
  return {
    source: join(workDir, `${name}-source.db`),
    dest: join(workDir, `${name}-dest.db`),
  };
}

async function openDestination(dbPath: string): Promise<MikroORM> {
  return MikroORM.init(await getConnectionOptionsFromUri(`sqlite://${dbPath}`));
}

describe('migrate reports a missing table', () => {
  it('skips a table the source does not have', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const {source, dest} = databasePaths('missing-tables');
    await createV0Database(source, {
      omitTables: ['app_states', 'user_states', 'events'],
      sessions: [
        {appName: 'app1', userId: 'user1', id: 'session1', state: '{}'},
      ],
    });

    await migrate({
      sourceDbUrl: `sqlite://${source}`,
      destDbUrl: `sqlite://${dest}`,
    });

    const written = info.mock.calls.flat().join('\n');
    expect(written).toContain("No 'app_states' table found in source db.");
    expect(written).toContain("No 'user_states' table found in source db.");
    // The reference words the events line differently from the other three.
    expect(written).toContain("No 'events' table found in source database.");
    expect(written).toContain('Migrated 1 sessions.');
  });
});

describe('migrate handles a bad row', () => {
  it('skips an event row with no id and keeps the rest', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const {source, dest} = databasePaths('bad-event');
    await createV0Database(source, {
      sessions: [
        {appName: 'app1', userId: 'user1', id: 'session1', state: '{}'},
      ],
      events: [
        {id: '', actions: fromBase64(SIMPLE_STATE_DELTA)},
        {id: 'event2', actions: fromBase64(SIMPLE_STATE_DELTA)},
      ],
    });

    await migrate({
      sourceDbUrl: `sqlite://${source}`,
      destDbUrl: `sqlite://${dest}`,
    });

    expect(warn.mock.calls.flat().join('\n')).toContain(
      'Failed to migrate event row : Event must have an id.',
    );
    const orm = await openDestination(dest);
    try {
      const events = await orm.em.fork().findAll(StorageEvent);
      expect(events.map((event) => event.id)).toEqual(['event2']);
    } finally {
      await orm.close(true);
    }
  });

  it('fails the migration when a state row has no key', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const {source, dest} = databasePaths('empty-key');
    await createV0Database(source, {
      appStates: [{appName: '', state: '{}'}],
    });

    await expect(
      migrate({
        sourceDbUrl: `sqlite://${source}`,
        destDbUrl: `sqlite://${dest}`,
      }),
    ).rejects.toThrow("Row in 'app_states' has no app_name.");
  });

  it('rolls the destination back when a row cannot be read at all', async () => {
    vi.spyOn(logger, 'error').mockImplementation(() => {});
    const {source, dest} = databasePaths('rollback');
    await createV0Database(source, {
      sessions: [
        {appName: 'app1', userId: 'user1', id: 'session1', state: '{}'},
      ],
    });
    const raw = await openRawDatabase(source);
    try {
      await raw.execute("UPDATE sessions SET update_time = 'not a timestamp'");
    } finally {
      await raw.close();
    }

    await expect(
      migrate({
        sourceDbUrl: `sqlite://${source}`,
        destDbUrl: `sqlite://${dest}`,
      }),
    ).rejects.toThrow('An error occurred during migration');

    // The metadata row is written first, so its absence proves the rollback.
    const orm = await openDestination(dest);
    try {
      const metadata = await orm.em
        .fork()
        .findOne(StorageMetadata, {key: SCHEMA_VERSION_KEY});
      expect(metadata).toBeNull();
    } finally {
      await orm.close(true);
    }
  });
});

describe('rowToEvent reads a column defensively', () => {
  const BASE_ROW = {
    id: 'event1',
    invocation_id: 'invoke1',
    author: 'user',
    timestamp: V0_TIMESTAMP,
  };

  it('rejects a row with no id', () => {
    expect(() => rowToEvent({...BASE_ROW, id: undefined})).toThrow(
      'Event must have an id.',
    );
  });

  it('rejects a row with no readable timestamp', () => {
    expect(() => rowToEvent({...BASE_ROW, timestamp: 'yesterday'})).toThrow(
      'Event event1 must have a timestamp.',
    );
  });

  it('defaults the invocation id and the author', () => {
    const event = rowToEvent({
      id: 'event1',
      timestamp: V0_TIMESTAMP,
    });
    expect(event.invocationId).toBe('');
    expect(event.author).toBe('agent');
  });

  it('keeps the branch when the column holds one', () => {
    expect(rowToEvent({...BASE_ROW, branch: 'a.b'}).branch).toBe('a.b');
    expect(rowToEvent({...BASE_ROW, branch: null}).branch).toBeUndefined();
  });

  it('reads the SQLite integer spelling of a boolean column', () => {
    const event = rowToEvent({
      ...BASE_ROW,
      partial: 1,
      turn_complete: 0,
      interrupted: true,
      error_code: 'BLOCKED',
      error_message: 'nope',
    });
    expect(event.partial).toBe(true);
    expect(event.turnComplete).toBe(false);
    expect(event.interrupted).toBe(true);
    expect(event.errorCode).toBe('BLOCKED');
    expect(event.errorMessage).toBe('nope');
  });

  it('leaves an absent boolean or text column undefined', () => {
    const event = rowToEvent({...BASE_ROW, partial: null, error_code: null});
    expect(event.partial).toBeUndefined();
    expect(event.errorCode).toBeUndefined();
  });

  it('decodes an object column that arrives already decoded', () => {
    const event = rowToEvent({
      ...BASE_ROW,
      content: {parts: [{text: 'hi'}], role: 'user'},
    });
    expect(event.content).toEqual({parts: [{text: 'hi'}], role: 'user'});
  });

  it('drops an object column whose JSON does not parse', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const event = rowToEvent({...BASE_ROW, content: '{not json'});
    expect(event.content).toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'Failed to decode JSON for event event1',
    );
  });

  it('drops an object column that holds a scalar', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const event = rowToEvent({...BASE_ROW, grounding_metadata: '7'});
    expect(event.groundingMetadata).toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'Expected JSON object for event event1, got number.',
    );
  });

  it('names an array or a null in the report, which typeof cannot', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    rowToEvent({...BASE_ROW, content: '[1]', custom_metadata: 'null'});
    const written = warn.mock.calls.flat().join('\n');
    expect(written).toContain(
      'Expected JSON object for event event1, got array.',
    );
    expect(written).toContain(
      'Expected JSON object for event event1, got null.',
    );
  });

  it('reads every remaining JSON column', () => {
    const event = rowToEvent({
      ...BASE_ROW,
      custom_metadata: JSON.stringify({a: 1}),
      usage_metadata: JSON.stringify({totalTokenCount: 2}),
      citation_metadata: JSON.stringify({citations: []}),
      input_transcription: JSON.stringify({text: 'in'}),
      output_transcription: JSON.stringify({text: 'out'}),
    });
    expect(event.customMetadata).toEqual({a: 1});
    expect(event.usageMetadata).toEqual({totalTokenCount: 2});
    expect(event.citationMetadata).toEqual({citations: []});
    expect(event.inputTranscription).toEqual({text: 'in'});
    expect(event.outputTranscription).toEqual({text: 'out'});
  });

  it('reads the long running tool ids', () => {
    expect(
      rowToEvent({
        ...BASE_ROW,
        long_running_tool_ids_json: JSON.stringify(['fc-1']),
      }).longRunningToolIds,
    ).toEqual(['fc-1']);
    expect(
      rowToEvent({...BASE_ROW, long_running_tool_ids_json: ''})
        .longRunningToolIds,
    ).toEqual([]);
    expect(
      rowToEvent({...BASE_ROW, long_running_tool_ids_json: '"one"'})
        .longRunningToolIds,
    ).toEqual([]);
  });

  it('falls back to no tool ids when their JSON does not parse', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(
      rowToEvent({...BASE_ROW, long_running_tool_ids_json: '[1,'})
        .longRunningToolIds,
    ).toEqual([]);
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'Failed to decode long_running_tool_ids_json for event event1',
    );
  });

  it('takes an actions column a driver already decoded', () => {
    const event = rowToEvent({
      ...BASE_ROW,
      actions: {state_delta: {skey: 4}, escalate: true},
    });
    expect(event.actions.stateDelta).toEqual({skey: 4});
    expect(event.actions.escalate).toBe(true);
  });

  it('reads an actions column held in a bare ArrayBuffer', () => {
    const bytes = fromBase64(SIMPLE_STATE_DELTA);
    const buffer = bytes.buffer.slice(
      bytes.byteOffset,
      bytes.byteOffset + bytes.byteLength,
    );
    expect(
      rowToEvent({...BASE_ROW, actions: buffer}).actions.stateDelta,
    ).toEqual({skey: 4});
  });

  it('leaves the actions empty when the column is null or unusable', () => {
    expect(rowToEvent({...BASE_ROW, actions: null}).actions.stateDelta).toEqual(
      {},
    );
    expect(rowToEvent({...BASE_ROW}).actions.stateDelta).toEqual({});
    expect(
      rowToEvent({...BASE_ROW, actions: 'not a blob'}).actions.stateDelta,
    ).toEqual({});
  });

  it('reports a blob it cannot decode and keeps the event', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const event = rowToEvent({
      ...BASE_ROW,
      actions: Uint8Array.from([0x80, 0x05, 0x2e]),
    });
    expect(event.actions.stateDelta).toEqual({});
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'Failed to unpickle actions for event event1',
    );
  });
});

describe('a SQLite URL resolves its path verbatim', () => {
  // Pins what the guide tells a user coming from an adk-python configuration:
  // SQLAlchemy reads `sqlite:///x.db` as relative, adk-js as absolute.
  it.each([
    ['sqlite:///abs/path.db', '/abs/path.db'],
    ['sqlite://./rel.db', './rel.db'],
    ['sqlite:///./rel.db', '/./rel.db'],
  ])('%s resolves to %s', async (url, dbName) => {
    expect((await getConnectionOptionsFromUri(toSyncUrl(url))).dbName).toBe(
      dbName,
    );
  });
});

describe('toDateObject', () => {
  it('returns a Date unchanged', () => {
    const value = new Date(1234);
    expect(toDateObject(value)).toBe(value);
  });

  it('reads a number as epoch milliseconds', () => {
    expect(toDateObject(1234)?.getTime()).toBe(1234);
  });

  it('reads both SQLite timestamp shapes', () => {
    expect(toDateObject('2026-01-02 03:04:05')?.getTime()).toBe(
      new Date(2026, 0, 2, 3, 4, 5, 0).getTime(),
    );
    expect(toDateObject('2026-01-02 03:04:05.123456')?.getTime()).toBe(
      new Date(2026, 0, 2, 3, 4, 5, 123).getTime(),
    );
    expect(toDateObject('2026-01-02 03:04:05.1')?.getTime()).toBe(
      new Date(2026, 0, 2, 3, 4, 5, 100).getTime(),
    );
  });

  it('returns undefined for anything else', () => {
    expect(toDateObject('2026-01-02T03:04:05Z')).toBeUndefined();
    expect(toDateObject(null)).toBeUndefined();
    expect(toDateObject(undefined)).toBeUndefined();
  });
});

describe('getStateObject', () => {
  it('passes an object through', () => {
    expect(getStateObject({a: 1})).toEqual({a: 1});
  });

  it('parses a JSON object string', () => {
    expect(getStateObject('{"a": 1}')).toEqual({a: 1});
  });

  it('reports a string that is not JSON', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(getStateObject('{not json')).toEqual({});
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'Failed to parse state JSON string, defaulting to empty dict.',
    );
  });

  it('reports JSON that is not an object', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    expect(getStateObject('[1, 2]')).toEqual({});
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'State JSON was not an object, defaulting to empty dict.',
    );
  });

  it('returns an empty object for anything else', () => {
    expect(getStateObject(null)).toEqual({});
    expect(getStateObject(7)).toEqual({});
  });
});
