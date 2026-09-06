/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers what the adk-python reference tests have no equivalent for: the
 * command-line surface, the timestamp reader, the source-table probe, the
 * rollback, and the promise that the source is never written to.
 */

import {DatabaseSessionService} from '@google/adk';
import {spawnSync} from 'node:child_process';
import {rmSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  main,
  migrateFromSqlalchemyPickle,
  normalizeLegacyDatabaseUri,
  parseMigrationArgs,
  rowToEvent,
  toEpochMillis,
} from '../../../src/sessions/migration/index.js';
import {toStateRecord} from '../../../src/sessions/migration/migrate_from_sqlalchemy_pickle.js';
import {captureLogs, type CapturedLogs} from './testdata/capture_logs.js';
import {fixtureBytes, SIMPLE_STATE_DELTA} from './testdata/pickled_actions.js';
import {
  databasePath,
  makeTempDir,
  SqliteFixture,
  sqliteUrl,
} from './testdata/v0_database.js';

const NOW = '2026-01-01 10:00:00.000000';

/**
 * Test budget (ms) for a case that opens a database.
 *
 * Each of these creates one or two MikroORM instances over a real sqlite file.
 * That runs well inside Vitest's 5s default on Linux, and past it on a loaded
 * Windows runner, where the same case took over five seconds in CI.
 */
const DATABASE_TEST_TIMEOUT_MS = 30_000;

describe('parseMigrationArgs', () => {
  it('accepts a value separated by a space', () => {
    expect(
      parseMigrationArgs([
        '--source_db_url',
        'sqlite:///a.db',
        '--dest_db_url',
        'sqlite:///b.db',
      ]),
    ).toEqual({
      sourceDbUrl: 'sqlite:///a.db',
      destDbUrl: 'sqlite:///b.db',
      allowUnsafeUnpickling: false,
    });
  });

  it('accepts a value joined by an equals sign', () => {
    expect(
      parseMigrationArgs([
        '--source_db_url=sqlite:///a.db',
        '--dest_db_url=sqlite:///b.db',
      ]),
    ).toMatchObject({
      sourceDbUrl: 'sqlite:///a.db',
      destDbUrl: 'sqlite:///b.db',
    });
  });

  it.each(['--allow_unsafe_unpickling', '--allow-unsafe-unpickling'])(
    'accepts the %s spelling of the opt-in',
    (flag) => {
      expect(
        parseMigrationArgs(['--source_db_url=a', '--dest_db_url=b', flag])
          .allowUnsafeUnpickling,
      ).toBe(true);
    },
  );

  it('rejects a missing required flag', () => {
    expect(() => parseMigrationArgs(['--source_db_url=a'])).toThrow(
      'Both --source_db_url and --dest_db_url are required.',
    );
  });

  it('rejects an unknown argument', () => {
    expect(() => parseMigrationArgs(['--nope=1'])).toThrow(
      'Unknown argument: --nope=1',
    );
  });

  it('rejects a flag whose value is missing', () => {
    expect(() => parseMigrationArgs(['--source_db_url'])).toThrow(
      '--source_db_url needs a value.',
    );
  });
});

describe('normalizeLegacyDatabaseUri', () => {
  it('rewrites the in-memory form adk-js recognises', () => {
    expect(normalizeLegacyDatabaseUri('sqlite:///:memory:')).toBe(
      'sqlite://:memory:',
    );
  });
});

describe('toStateRecord', () => {
  it('takes an already-decoded object, as Postgres returns it', () => {
    expect(toStateRecord({akey: 1})).toEqual({akey: 1});
  });

  it('parses a JSON object string, as every other backend returns it', () => {
    expect(toStateRecord('{"akey": 1}')).toEqual({akey: 1});
  });

  it.each([
    ['a value of another type', 7],
    ['nothing at all', undefined],
  ])('defaults %s to an empty object', (_name, value) => {
    expect(toStateRecord(value)).toEqual({});
  });
});

describe('toEpochMillis', () => {
  it('reads a Date straight through', () => {
    const when = new Date(Date.UTC(2026, 0, 1, 5, 0, 0));

    expect(toEpochMillis(when)).toBe(when.getTime());
  });

  it('reads a number as milliseconds', () => {
    expect(toEpochMillis(1_700_000_000_000)).toBe(1_700_000_000_000);
  });

  it('reads a fractional naive timestamp as local time', () => {
    expect(toEpochMillis('2026-01-01 12:30:00.250000')).toBe(
      new Date(2026, 0, 1, 12, 30, 0, 250).getTime(),
    );
  });

  it('reads a whole-second naive timestamp as local time', () => {
    expect(toEpochMillis('2026-01-01 12:30:00')).toBe(
      new Date(2026, 0, 1, 12, 30, 0, 0).getTime(),
    );
  });

  it.each([
    ['an unparseable string', 'yesterday'],
    ['an ISO string with a zone marker', '2026-01-01T12:30:00Z'],
    ['a value of another type', {}],
    ['nothing at all', undefined],
  ])('returns undefined for %s', (_name, value) => {
    expect(toEpochMillis(value)).toBeUndefined();
  });
});

describe('rowToEvent', () => {
  let logs: CapturedLogs;

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  const BASE = {
    id: 'event1',
    invocation_id: 'invoke1',
    author: 'user',
    timestamp: NOW,
  };

  it.each([
    ['a missing id', {...BASE, id: undefined}, 'Event must have an id.'],
    ['an empty id', {...BASE, id: ''}, 'Event must have an id.'],
    [
      'a missing timestamp',
      {...BASE, timestamp: undefined},
      'Event event1 must have a timestamp.',
    ],
    [
      'an unreadable timestamp',
      {...BASE, timestamp: 'yesterday'},
      'Event event1 must have a timestamp.',
    ],
  ])('rejects a row with %s', (_name, row, message) => {
    expect(() => rowToEvent(row)).toThrow(message);
  });

  it('defaults the author and the invocation id, as the reference does', () => {
    const event = rowToEvent({id: 'event1', timestamp: NOW});

    expect(event.author).toBe('agent');
    expect(event.invocationId).toBe('');
  });

  it('copies the remaining scalar columns across', () => {
    const event = rowToEvent({
      ...BASE,
      branch: 'root.child',
      partial: true,
      turn_complete: false,
      error_code: 'BOOM',
      error_message: 'it broke',
      interrupted: true,
    });

    expect(event).toMatchObject({
      branch: 'root.child',
      partial: true,
      turnComplete: false,
      errorCode: 'BOOM',
      errorMessage: 'it broke',
      interrupted: true,
    });
  });

  it('takes an already-decoded JSON column as-is, as Postgres JSONB returns it', () => {
    const event = rowToEvent({...BASE, content: {role: 'user'}});

    expect(event.content).toEqual({role: 'user'});
  });

  it('parses a JSON column that arrives as a string', () => {
    const event = rowToEvent({
      ...BASE,
      content: '{"role": "user", "parts": [{"text": "hi"}]}',
    });

    expect(event.content).toEqual({role: 'user', parts: [{text: 'hi'}]});
  });

  it('takes an already-decoded actions object, as Spanner returns it', () => {
    const event = rowToEvent({...BASE, actions: {escalate: true}});

    expect(event.actions.escalate).toBe(true);
  });

  it('ignores an actions column that is neither binary nor an object', () => {
    const event = rowToEvent({...BASE, actions: 'not-a-pickle'});

    expect(event.actions.stateDelta).toEqual({});
  });

  it('warns and unsets a JSON column that will not parse', () => {
    const event = rowToEvent({...BASE, content: '{not json'});

    expect(event.content).toBeUndefined();
    expect(logs.text()).toContain('Failed to decode JSON for event event1');
  });

  it('names the type of a JSON column that parses to a scalar', () => {
    const event = rowToEvent({...BASE, grounding_metadata: '7'});

    expect(event.groundingMetadata).toBeUndefined();
    expect(logs.text()).toContain(
      'Expected JSON object for event event1, got number.',
    );
  });

  it('names null as the type of a JSON column holding it', () => {
    const event = rowToEvent({...BASE, usage_metadata: 'null'});

    expect(event.usageMetadata).toBeUndefined();
    expect(logs.text()).toContain(
      'Expected JSON object for event event1, got null.',
    );
  });

  it('deduplicates the long running tool ids, which adk-js models as an array', () => {
    const event = rowToEvent({
      ...BASE,
      long_running_tool_ids_json: '["fc-1", "fc-1", "fc-2"]',
    });

    expect(event.longRunningToolIds).toEqual(['fc-1', 'fc-2']);
  });

  it.each([
    ['an empty column', '', []],
    ['a value of another type', 42, []],
    ['a JSON object rather than an array', '{"a": 1}', []],
  ])('reads no long running tool ids from %s', (_name, value, expected) => {
    expect(
      rowToEvent({...BASE, long_running_tool_ids_json: value})
        .longRunningToolIds,
    ).toEqual(expected);
  });

  it('warns when the long running tool ids will not parse', () => {
    const event = rowToEvent({
      ...BASE,
      long_running_tool_ids_json: '[not json',
    });

    expect(event.longRunningToolIds).toEqual([]);
    expect(logs.text()).toContain(
      'Failed to decode long_running_tool_ids_json for event event1',
    );
  });
});

describe(
  'migrateFromSqlalchemyPickle side effects',
  {timeout: DATABASE_TEST_TIMEOUT_MS},
  () => {
    let directory: string;
    let logs: CapturedLogs;

    beforeAll(() => {
      directory = makeTempDir();
    });

    afterAll(() => {
      rmSync(directory, {recursive: true, force: true});
    });

    beforeEach(() => {
      logs = captureLogs();
    });

    afterEach(() => {
      logs.restore();
    });

    it('migrates what it finds and reports each absent table', async () => {
      const source = await SqliteFixture.open(
        databasePath(directory, 'partial-source.db'),
      );
      await source.createV0Tables(['sessions']);
      await source.insert('sessions', {
        app_name: 'app1',
        user_id: 'user1',
        id: 'session1',
        state: '{"skey": 1}',
        create_time: NOW,
        update_time: NOW,
      });
      const sourceDbUrl = source.url;
      await source.close();
      const destPath = databasePath(directory, 'partial-dest.db');

      const summary = await migrateFromSqlalchemyPickle({
        sourceDbUrl,
        destDbUrl: sqliteUrl(destPath),
      });

      expect(summary).toEqual({
        appStates: 0,
        userStates: 0,
        sessions: 1,
        events: 0,
        skippedEvents: 0,
      });
      expect(logs.text()).toContain(
        "No 'app_states' table found in source db.",
      );
      expect(logs.text()).toContain(
        "No 'user_states' table found in source db.",
      );
      expect(logs.text()).toContain(
        "No 'events' table found in source database.",
      );
    });

    it('leaves the source database untouched', async () => {
      const source = await SqliteFixture.open(
        databasePath(directory, 'readonly-source.db'),
      );
      await source.createV0Tables();
      await source.insert('sessions', {
        app_name: 'app1',
        user_id: 'user1',
        id: 'session1',
        state: '{}',
        create_time: NOW,
        update_time: NOW,
      });
      await source.insert('events', {
        id: 'event1',
        app_name: 'app1',
        user_id: 'user1',
        session_id: 'session1',
        invocation_id: 'invoke1',
        author: 'user',
        actions: fixtureBytes(SIMPLE_STATE_DELTA),
        timestamp: NOW,
      });
      const before = await source.columnsOf('events');
      const sourceDbUrl = source.url;
      const sourcePath = source.path;
      await source.close();

      await migrateFromSqlalchemyPickle({
        sourceDbUrl,
        destDbUrl: sqliteUrl(databasePath(directory, 'readonly-dest.db')),
      });

      const reopened = await SqliteFixture.open(sourcePath);
      const after = await reopened.columnsOf('events');
      const tables = await reopened.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table'",
      );
      await reopened.close();

      expect(after).toEqual(before);
      expect(after).not.toContain('event_data');
      expect(tables.map((row) => row['name'])).not.toContain(
        'adk_internal_metadata',
      );
    });

    it('counts an unconvertible event row as skipped and keeps going', async () => {
      const source = await SqliteFixture.open(
        databasePath(directory, 'skipped-source.db'),
      );
      await source.createV0Tables();
      await source.insert('sessions', {
        app_name: 'app1',
        user_id: 'user1',
        id: 'session1',
        state: '{}',
        create_time: NOW,
        update_time: NOW,
      });
      for (const [id, timestamp] of [
        ['event-good', NOW],
        ['event-bad', 'not-a-timestamp'],
      ]) {
        await source.insert('events', {
          id,
          app_name: 'app1',
          user_id: 'user1',
          session_id: 'session1',
          invocation_id: 'invoke1',
          author: 'user',
          actions: fixtureBytes(SIMPLE_STATE_DELTA),
          timestamp,
        });
      }
      const sourceDbUrl = source.url;
      await source.close();
      const destPath = databasePath(directory, 'skipped-dest.db');

      const summary = await migrateFromSqlalchemyPickle({
        sourceDbUrl,
        destDbUrl: sqliteUrl(destPath),
      });

      expect(summary).toMatchObject({events: 1, skippedEvents: 1});
      expect(logs.text()).toContain(
        'Failed to migrate event row event-bad: Event event-bad must have a timestamp.',
      );

      const destination = await SqliteFixture.open(destPath);
      const rows = await destination.execute('SELECT id FROM events');
      await destination.close();
      expect(rows.map((row) => row['id'])).toEqual(['event-good']);
    });

    it('names an event row with no id column in the skip warning', async () => {
      const source = await SqliteFixture.open(
        databasePath(directory, 'no-id-source.db'),
      );
      // A legacy table that lost its id column: every row is unconvertible, and
      // the warning has no id to name.
      await source.execute(`CREATE TABLE events (
      app_name VARCHAR(128) NOT NULL,
      user_id VARCHAR(128) NOT NULL,
      session_id VARCHAR(128) NOT NULL,
      timestamp TIMESTAMP NOT NULL
    )`);
      await source.insert('events', {
        app_name: 'app1',
        user_id: 'user1',
        session_id: 'session1',
        timestamp: NOW,
      });
      const sourceDbUrl = source.url;
      await source.close();

      const summary = await migrateFromSqlalchemyPickle({
        sourceDbUrl,
        destDbUrl: sqliteUrl(databasePath(directory, 'no-id-dest.db')),
      });

      expect(summary).toMatchObject({events: 0, skippedEvents: 1});
      expect(logs.text()).toContain(
        'Failed to migrate event row N/A: Event must have an id.',
      );
    });

    it('rolls the destination back when a row cannot be written', async () => {
      const source = await SqliteFixture.open(
        databasePath(directory, 'rollback-source.db'),
      );
      await source.createV0Tables(['app_states', 'sessions']);
      await source.insert('app_states', {
        app_name: 'app1',
        state: '{"akey": 1}',
        update_time: NOW,
      });
      // A create_time far outside the range a Date can represent, so the
      // session write fails after the app state was staged in the same
      // transaction.
      await source.insert('sessions', {
        app_name: 'app1',
        user_id: 'user1',
        id: 'session1',
        state: '{}',
        create_time: 1e300,
        update_time: NOW,
      });
      const sourceDbUrl = source.url;
      await source.close();
      const destPath = databasePath(directory, 'rollback-dest.db');

      await expect(
        migrateFromSqlalchemyPickle({
          sourceDbUrl,
          destDbUrl: sqliteUrl(destPath),
        }),
      ).rejects.toThrow(/^An error occurred during migration: /);

      const destination = await SqliteFixture.open(destPath);
      const appStates = await destination.execute('SELECT * FROM app_states');
      const sessions = await destination.execute('SELECT * FROM sessions');
      await destination.close();
      expect(appStates).toEqual([]);
      expect(sessions).toEqual([]);
    });

    it('refuses a destination stamped with an incompatible schema version', async () => {
      const source = await SqliteFixture.open(
        databasePath(directory, 'version-source.db'),
      );
      await source.createV0Tables(['sessions']);
      const sourceDbUrl = source.url;
      await source.close();

      const destPath = databasePath(directory, 'version-dest.db');
      const destination = await SqliteFixture.open(destPath);
      await destination.execute(
        'CREATE TABLE adk_internal_metadata (key TEXT NOT NULL PRIMARY KEY, value TEXT NOT NULL)',
      );
      await destination.insert('adk_internal_metadata', {
        key: 'schema_version',
        value: '99',
      });
      await destination.close();

      await expect(
        migrateFromSqlalchemyPickle({
          sourceDbUrl,
          destDbUrl: sqliteUrl(destPath),
        }),
      ).rejects.toThrow(
        'An error occurred during migration: ADK Database schema version 99 is not compatible.',
      );
    });

    it('warns before reading a source with unsafe unpickling enabled', async () => {
      const source = await SqliteFixture.open(
        databasePath(directory, 'unsafe-warning-source.db'),
      );
      await source.createV0Tables(['sessions']);
      const sourceDbUrl = source.url;
      await source.close();

      await migrateFromSqlalchemyPickle({
        sourceDbUrl,
        destDbUrl: sqliteUrl(databasePath(directory, 'unsafe-warning-dest.db')),
        allowUnsafeUnpickling: true,
      });

      expect(logs.text()).toContain('Unsafe pickle migration mode is enabled.');
    });

    it('defaults a state column the source left unusable to an empty object', async () => {
      const source = await SqliteFixture.open(
        databasePath(directory, 'state-source.db'),
      );
      await source.createV0Tables(['app_states', 'user_states']);
      await source.insert('app_states', {
        app_name: 'broken-json',
        state: '{not json',
        update_time: NOW,
      });
      await source.insert('app_states', {
        app_name: 'not-an-object',
        state: '[1, 2]',
        update_time: NOW,
      });
      // A state column of another type, and an update_time no driver would
      // return as a timestamp: both fall back rather than failing the run.
      await source.insert('user_states', {
        app_name: 'app1',
        user_id: 'user1',
        state: 7,
        update_time: 'not-a-time',
      });
      const sourceDbUrl = source.url;
      await source.close();
      const destPath = databasePath(directory, 'state-dest.db');

      await migrateFromSqlalchemyPickle({
        sourceDbUrl,
        destDbUrl: sqliteUrl(destPath),
      });

      const destination = await SqliteFixture.open(destPath);
      const appStates = await destination.execute(
        'SELECT app_name, state FROM app_states ORDER BY app_name',
      );
      const userStates = await destination.execute(
        'SELECT update_time FROM user_states',
      );
      await destination.close();

      expect(appStates.map((row) => row['state'])).toEqual(['{}', '{}']);
      expect(userStates[0]['update_time']).toBeTruthy();
      expect(logs.text()).toContain(
        'Failed to parse state JSON string, defaulting to empty dict.',
      );
      expect(logs.text()).toContain(
        'State JSON was not an object, defaulting to empty dict.',
      );
    });
  },
);

describe('main', {timeout: DATABASE_TEST_TIMEOUT_MS}, () => {
  let directory: string;
  let logs: CapturedLogs;

  beforeAll(() => {
    directory = makeTempDir();
  });

  afterAll(() => {
    rmSync(directory, {recursive: true, force: true});
  });

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  it('runs the migration and exits zero', async () => {
    const source = await SqliteFixture.open(
      databasePath(directory, 'cli-source.db'),
    );
    await source.createV0Tables(['sessions']);
    await source.insert('sessions', {
      app_name: 'app1',
      user_id: 'user1',
      id: 'session1',
      state: '{}',
      create_time: NOW,
      update_time: NOW,
    });
    const sourceDbUrl = source.url;
    await source.close();

    const exitCode = await main([
      `--source_db_url=${sourceDbUrl}`,
      `--dest_db_url=${sqliteUrl(databasePath(directory, 'cli-dest.db'))}`,
    ]);

    expect(exitCode).toBe(0);
    expect(logs.text()).toContain(
      'Migrated 1 sessions and 0 events, skipping 0.',
    );
  });

  it('reports a bad invocation and exits one', async () => {
    expect(await main(['--source_db_url=only-one'])).toBe(1);
    expect(logs.text()).toContain(
      'Migration failed: Both --source_db_url and --dest_db_url are required.',
    );
  });
});

describe('the migrated database', {timeout: DATABASE_TEST_TIMEOUT_MS}, () => {
  let directory: string;
  let logs: CapturedLogs;

  beforeAll(() => {
    directory = makeTempDir();
  });

  afterAll(() => {
    rmSync(directory, {recursive: true, force: true});
  });

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => {
    logs.restore();
  });

  /** A v0 source holding one session and one event. */
  async function makeSource(name: string): Promise<string> {
    const source = await SqliteFixture.open(
      databasePath(directory, `${name}.db`),
    );
    await source.createV0Tables();
    await source.insert('sessions', {
      app_name: 'app1',
      user_id: 'user1',
      id: 'session1',
      state: '{"skey": 3}',
      create_time: NOW,
      update_time: NOW,
    });
    await source.insert('events', {
      id: 'event1',
      app_name: 'app1',
      user_id: 'user1',
      session_id: 'session1',
      invocation_id: 'invoke1',
      author: 'user',
      actions: fixtureBytes(SIMPLE_STATE_DELTA),
      timestamp: NOW,
    });
    const url = source.url;
    await source.close();
    return url;
  }

  it('opens in DatabaseSessionService, as the guide shows', async () => {
    const sourceDbUrl = await makeSource('service-source');
    const destPath = databasePath(directory, 'service-dest.db');
    await migrateFromSqlalchemyPickle({
      sourceDbUrl,
      destDbUrl: sqliteUrl(destPath),
    });

    const service = new DatabaseSessionService(sqliteUrl(destPath));
    await service.init();
    const session = await service.getSession({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'session1',
    });

    expect(session?.state).toEqual({skey: 3});
    expect(session?.events).toHaveLength(1);
    expect(session?.events[0].actions.stateDelta).toEqual({skey: 4});
  });

  it('can be produced again over the same destination', async () => {
    const sourceDbUrl = await makeSource('rerun-source');
    const destDbUrl = sqliteUrl(databasePath(directory, 'rerun-dest.db'));

    const first = await migrateFromSqlalchemyPickle({sourceDbUrl, destDbUrl});
    const second = await migrateFromSqlalchemyPickle({sourceDbUrl, destDbUrl});

    expect(second).toEqual(first);

    const destination = await SqliteFixture.open(
      databasePath(directory, 'rerun-dest.db'),
    );
    const sessions = await destination.execute('SELECT id FROM sessions');
    const events = await destination.execute('SELECT id FROM events');
    await destination.close();
    expect(sessions).toHaveLength(1);
    expect(events).toHaveLength(1);
  });
});

/** The built command-line entry point, as a user would invoke it. */
const CLI_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../..',
  'dist/esm/sessions/migration/cli.js',
);

describe(
  'the command-line entry point',
  {timeout: DATABASE_TEST_TIMEOUT_MS},
  () => {
    let directory: string;

    beforeAll(() => {
      directory = makeTempDir();
    });

    afterAll(() => {
      rmSync(directory, {recursive: true, force: true});
    });

    it('migrates a real database in its own process', async () => {
      const source = await SqliteFixture.open(
        databasePath(directory, 'e2e-source.db'),
      );
      await source.createV0Tables();
      await source.insert('sessions', {
        app_name: 'app1',
        user_id: 'user1',
        id: 'session1',
        state: '{"skey": 1}',
        create_time: NOW,
        update_time: NOW,
      });
      await source.insert('events', {
        id: 'event1',
        app_name: 'app1',
        user_id: 'user1',
        session_id: 'session1',
        invocation_id: 'invoke1',
        author: 'user',
        actions: fixtureBytes(SIMPLE_STATE_DELTA),
        timestamp: NOW,
      });
      const sourceDbUrl = source.url;
      await source.close();
      const destPath = databasePath(directory, 'e2e-dest.db');

      const run = spawnSync(
        process.execPath,
        [
          CLI_PATH,
          `--source_db_url=${sourceDbUrl}`,
          `--dest_db_url=${sqliteUrl(destPath)}`,
        ],
        {encoding: 'utf8'},
      );

      expect(run.status).toBe(0);

      const destination = await SqliteFixture.open(destPath);
      const sessions = await destination.execute('SELECT id FROM sessions');
      const events = await destination.execute('SELECT event_data FROM events');
      const metadata = await destination.execute(
        'SELECT value FROM adk_internal_metadata',
      );
      await destination.close();

      expect(sessions.map((row) => row['id'])).toEqual(['session1']);
      expect(String(events[0]['event_data'])).toContain('"skey":4');
      expect(metadata[0]['value']).toBe('1');
    });

    it('exits non-zero when the invocation is wrong', () => {
      const run = spawnSync(process.execPath, [CLI_PATH, '--nope'], {
        encoding: 'utf8',
      });

      expect(run.status).toBe(1);
    });
  },
);
