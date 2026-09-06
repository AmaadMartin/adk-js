/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/sessions/migration/test_migration.py` at
 * `google/adk-python` `main`. Each `it(...)` keeps the Python test name so a
 * reviewer can grep for it; adaptations are noted where adk-js differs.
 */

import {rmSync} from 'node:fs';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {transformToSnakeCaseEvent} from '../../../src/events/event.js';
import {
  migrateFromSqlalchemyPickle,
  normalizeLegacyDatabaseUri,
  rowToEvent,
} from '../../../src/sessions/migration/index.js';
import {captureLogs, type CapturedLogs} from './testdata/capture_logs.js';
import {
  DATETIME_STATE_DELTA,
  fixtureBytes,
  NESTED_ACTIONS,
  REFUSED_CALLABLE,
  SAFE_ACTIONS,
  SIMPLE_STATE_DELTA,
  STATE_DELTA_AND_ESCALATE,
  UI_WIDGET_ACTIONS,
} from './testdata/pickled_actions.js';
import {
  databasePath,
  makeTempDir,
  SqliteFixture,
  sqliteUrl,
} from './testdata/v0_database.js';

const SOURCE_URL = 'postgresql+asyncpg://user:sup3r-s3cret@host:5432/src';
const DEST_URL = 'postgresql+asyncpg://user:0ther-s3cret@host:5432/dst';

/** Reads the destination through the same driver stack the service uses. */
async function readDestination(
  path: string,
): Promise<Record<string, Array<Record<string, unknown>>>> {
  const destination = await SqliteFixture.open(path);
  try {
    return {
      metadata: await destination.execute(
        'SELECT * FROM adk_internal_metadata',
      ),
      appStates: await destination.execute('SELECT * FROM app_states'),
      userStates: await destination.execute('SELECT * FROM user_states'),
      sessions: await destination.execute('SELECT * FROM sessions'),
      events: await destination.execute('SELECT * FROM events'),
    };
  } finally {
    await destination.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Narrows a decoded JSON value to an object, failing the test if it is not. */
function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (!isRecord(value)) {
    expect.fail(`Expected ${what} to be an object, got ${String(value)}`);
  }
  return value;
}

/** Parses the `event_data` column of the single migrated event row. */
function eventDataOf(
  rows: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const raw = rows[0]?.['event_data'];
  if (typeof raw !== 'string') {
    expect.fail(`Expected an event_data string, got ${String(raw)}`);
  }
  const parsed: unknown = JSON.parse(raw);
  return asRecord(parsed, 'event_data');
}

/** The `actions` record of the single migrated event row. */
function actionsOf(
  rows: Array<Record<string, unknown>>,
): Record<string, unknown> {
  return asRecord(eventDataOf(rows)['actions'], 'actions');
}

/**
 * Test budget (ms) for a case that opens a database.
 *
 * Each of these creates one or two MikroORM instances over a real sqlite file.
 * That runs well inside Vitest's 5s default on Linux, and past it on a loaded
 * Windows runner, where the same case took over five seconds in CI.
 */
const DATABASE_TEST_TIMEOUT_MS = 30_000;

describe('to_sync_url', () => {
  it.each([
    ['postgresql+asyncpg://localhost/mydb', 'postgresql://localhost/mydb'],
    [
      'postgresql+asyncpg://user:pass@localhost:5432/mydb',
      'postgresql://user:pass@localhost:5432/mydb',
    ],
    ['postgresql+psycopg2://localhost/mydb', 'postgresql://localhost/mydb'],
    ['mysql+aiomysql://localhost/mydb', 'mysql://localhost/mydb'],
    [
      'mysql+asyncmy://user:pass@localhost:3306/mydb',
      'mysql://user:pass@localhost:3306/mydb',
    ],
    ['sqlite+aiosqlite:///path/to/db.sqlite', 'sqlite:///path/to/db.sqlite'],
    // Adapted: adk-python leaves `sqlite:///:memory:` alone, but adk-js's
    // `getConnectionOptionsFromUri` recognises only `sqlite://:memory:`, so
    // the two in-memory rows normalise further here.
    ['sqlite+aiosqlite:///:memory:', 'sqlite://:memory:'],
    ['postgresql://localhost/mydb', 'postgresql://localhost/mydb'],
    ['mysql://localhost/mydb', 'mysql://localhost/mydb'],
    ['sqlite:///path/to/db.sqlite', 'sqlite:///path/to/db.sqlite'],
    ['sqlite:///:memory:', 'sqlite://:memory:'],
    [
      'postgresql+asyncpg://user:pass@host/db?ssl=require',
      'postgresql://user:pass@host/db?ssl=require',
    ],
  ])('test_to_sync_url: %s', (input, expected) => {
    expect(normalizeLegacyDatabaseUri(input)).toBe(expected);
  });

  it('test_to_sync_url_no_scheme_separator', () => {
    expect(normalizeLegacyDatabaseUri('not-a-url')).toBe('not-a-url');
  });

  it('test_to_sync_url_empty_string', () => {
    expect(normalizeLegacyDatabaseUri('')).toBe('');
  });
});

describe(
  'migrate_from_sqlalchemy_pickle',
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

    // The migration reports its progress on every run, so every test captures
    // the log rather than letting it reach the runner's output.
    beforeEach(() => {
      logs = captureLogs();
    });

    afterEach(() => {
      logs.restore();
    });

    /** Creates a v0 source holding one session, and returns both URLs. */
    async function makeSource(
      name: string,
      build: (source: SqliteFixture) => Promise<void>,
    ): Promise<{sourceDbUrl: string; destDbUrl: string; destPath: string}> {
      const source = await SqliteFixture.open(
        databasePath(directory, `${name}-source.db`),
      );
      await source.createV0Tables();
      await build(source);
      const sourceDbUrl = source.url;
      await source.close();
      const destPath = databasePath(directory, `${name}-dest.db`);
      return {sourceDbUrl, destDbUrl: sqliteUrl(destPath), destPath};
    }

    /** Inserts the session row an event's foreign key needs. */
    async function addSession(source: SqliteFixture, now: string) {
      await source.insert('sessions', {
        app_name: 'app1',
        user_id: 'user1',
        id: 'session1',
        state: '{}',
        create_time: now,
        update_time: now,
      });
    }

    const NOW = '2026-01-01 10:00:00.000000';

    it('test_pickle_migration_connect_logs_are_redacted', async () => {
      // Adapted: adk-python mocks `create_engine` so the source opens and the
      // destination fails. Here the only installed driver is sqlite, so the run
      // is split in two: the first fails on the source URL, the second opens a
      // real sqlite source and fails on the destination URL.
      const source = await SqliteFixture.open(
        databasePath(directory, 'redaction-source.db'),
      );
      await source.createV0Tables();
      const sqliteSourceUrl = source.url;
      await source.close();

      await expect(
        migrateFromSqlalchemyPickle({
          sourceDbUrl: SOURCE_URL,
          destDbUrl: DEST_URL,
        }),
      ).rejects.toThrow(/^Failed to connect to source database: /);
      await expect(
        migrateFromSqlalchemyPickle({
          sourceDbUrl: sqliteSourceUrl,
          destDbUrl: DEST_URL,
        }),
      ).rejects.toThrow(/^Failed to connect to destination database: /);

      expect(logs.text()).not.toContain('sup3r-s3cret');
      expect(logs.text()).not.toContain('0ther-s3cret');
      expect(logs.text()).toContain(
        'postgresql+asyncpg://user:***@host:5432/src',
      );
      expect(logs.text()).toContain(
        'postgresql+asyncpg://user:***@host:5432/dst',
      );
    });

    it('test_migrate_from_sqlalchemy_pickle', async () => {
      const {sourceDbUrl, destDbUrl, destPath} = await makeSource(
        'basic',
        async (source) => {
          await source.insert('app_states', {
            app_name: 'app1',
            state: '{"akey": 1}',
            update_time: NOW,
          });
          await source.insert('user_states', {
            app_name: 'app1',
            user_id: 'user1',
            state: '{"ukey": 2}',
            update_time: NOW,
          });
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
        },
      );

      const summary = await migrateFromSqlalchemyPickle({
        sourceDbUrl,
        destDbUrl,
      });

      expect(summary).toEqual({
        appStates: 1,
        userStates: 1,
        sessions: 1,
        events: 1,
        skippedEvents: 0,
      });

      const destination = await readDestination(destPath);
      expect(destination['metadata']).toEqual([
        {key: 'schema_version', value: '1'},
      ]);
      expect(destination['appStates'][0]['app_name']).toBe('app1');
      expect(JSON.parse(String(destination['appStates'][0]['state']))).toEqual({
        akey: 1,
      });
      expect(destination['userStates'][0]['user_id']).toBe('user1');
      expect(JSON.parse(String(destination['userStates'][0]['state']))).toEqual(
        {
          ukey: 2,
        },
      );
      expect(destination['sessions'][0]['id']).toBe('session1');
      expect(JSON.parse(String(destination['sessions'][0]['state']))).toEqual({
        skey: 3,
      });
      expect(destination['events'][0]['id']).toBe('event1');
      expect(actionsOf(destination['events'])['state_delta']).toEqual({
        skey: 4,
      });
    });

    it('test_migrate_from_sqlalchemy_pickle_preserves_safe_actions_pickle', async () => {
      const {sourceDbUrl, destDbUrl, destPath} = await makeSource(
        'safe-actions',
        async (source) => {
          await addSession(source, NOW);
          await source.insert('events', {
            id: 'event1',
            app_name: 'app1',
            user_id: 'user1',
            session_id: 'session1',
            invocation_id: 'invoke1',
            author: 'user',
            actions: fixtureBytes(SAFE_ACTIONS),
            timestamp: NOW,
          });
        },
      );

      await migrateFromSqlalchemyPickle({sourceDbUrl, destDbUrl});

      const actions = actionsOf((await readDestination(destPath))['events']);
      expect(actions['state_delta']).toEqual({skey: 'updated'});
      expect(actions['artifact_delta']).toEqual({'artifact.txt': 2});
    });

    it('test_migrate_from_sqlalchemy_pickle_preserves_nested_safe_actions_pickle', async () => {
      const {sourceDbUrl, destDbUrl, destPath} = await makeSource(
        'nested-actions',
        async (source) => {
          await addSession(source, NOW);
          await source.insert('events', {
            id: 'event1',
            app_name: 'app1',
            user_id: 'user1',
            session_id: 'session1',
            invocation_id: 'invoke1',
            author: 'user',
            actions: fixtureBytes(NESTED_ACTIONS),
            timestamp: NOW,
          });
        },
      );

      await migrateFromSqlalchemyPickle({sourceDbUrl, destDbUrl});

      const actions = actionsOf((await readDestination(destPath))['events']);
      expect(actions['requested_tool_confirmations']).toEqual({
        'fc-confirm': {hint: 'Authorize execution?', confirmed: false},
      });
      expect(actions['compaction']).toMatchObject({
        compacted_content: {parts: [{text: 'summary'}], role: 'model'},
      });
    });

    it('test_restricted_actions_unpickler_allows_datetime_state_delta', () => {
      const event = rowToEvent({
        id: 'event-datetime-actions',
        invocation_id: 'invoke1',
        author: 'user',
        timestamp: new Date(Date.UTC(2026, 0, 1)),
        actions: fixtureBytes(DATETIME_STATE_DELTA),
      });

      expect(event.actions.stateDelta['last_seen']).toBe(
        '2026-01-01T12:30:00.000Z',
      );
    });

    it('test_restricted_actions_unpickler_allows_ui_widgets', () => {
      // Adapted: adk-js `EventActions` has no `renderUiWidgets` field, so the
      // widget rides along in the event's JSON rather than in a typed field. The
      // assertion is that the payload reaches `event_data` intact.
      const event = rowToEvent({
        id: 'event-ui-widgets',
        invocation_id: 'invoke1',
        author: 'user',
        timestamp: new Date(Date.UTC(2026, 0, 1)),
        actions: fixtureBytes(UI_WIDGET_ACTIONS),
      });

      expect(transformToSnakeCaseEvent(event)['actions']).toMatchObject({
        render_ui_widgets: [
          {
            id: 'widget-1',
            provider: 'mcp',
            payload: {resource_uri: 'ui://widget'},
          },
        ],
      });
    });

    it('test_migrate_from_sqlalchemy_pickle_ignores_non_object_json_fields', () => {
      const event = rowToEvent({
        id: 'event-list-content',
        invocation_id: 'invoke1',
        author: 'user',
        timestamp: new Date(Date.UTC(2026, 0, 1)),
        content: '[1, 2, 3]',
      });

      expect(event.content).toBeUndefined();
    });

    it.each([
      ['Buffer', (bytes: Uint8Array) => Buffer.from(bytes)],
      ['Uint8Array', (bytes: Uint8Array) => bytes],
      [
        'ArrayBuffer',
        (bytes: Uint8Array) =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      ],
    ])(
      'test_migrate_from_sqlalchemy_pickle_reads_every_binary_column_type: %s',
      (_name, asBinary) => {
        const event = rowToEvent({
          id: 'event-binary-actions',
          invocation_id: 'invoke1',
          author: 'user',
          timestamp: new Date(Date.UTC(2026, 0, 1)),
          actions: asBinary(fixtureBytes(STATE_DELTA_AND_ESCALATE)),
        });

        expect(event.actions.stateDelta).toEqual({skey: 4});
        expect(event.actions.escalate).toBe(true);
      },
    );

    it('test_migrate_from_sqlalchemy_pickle_reads_naive_timestamp_as_local', () => {
      const previousTimezone = process.env['TZ'];
      process.env['TZ'] = 'Asia/Kolkata';
      try {
        // Exactly what v0 persisted: naive local time, with no zone marker.
        const event = rowToEvent({
          id: 'event-naive-timestamp',
          invocation_id: 'invoke1',
          author: 'user',
          timestamp: '1970-01-12 18:16:40.000000',
        });

        expect(event.timestamp).toBe(
          new Date(1970, 0, 12, 18, 16, 40, 0).getTime(),
        );
        // Reading the same string as UTC would land on this instant instead.
        expect(event.timestamp).not.toBe(Date.parse('1970-01-12T18:16:40Z'));
      } finally {
        process.env['TZ'] = previousTimezone;
      }
    });

    it('test_migrate_from_sqlalchemy_pickle_blocks_unsafe_actions_pickle', async () => {
      // Adapted: TypeScript cannot execute a pickled payload at all, so the
      // guarantee under test is that the refusal is reported and the row still
      // migrates with empty actions.
      const {sourceDbUrl, destDbUrl, destPath} = await makeSource(
        'blocked-actions',
        async (source) => {
          await addSession(source, NOW);
          await source.insert('events', {
            id: 'event1',
            app_name: 'app1',
            user_id: 'user1',
            session_id: 'session1',
            invocation_id: 'invoke1',
            author: 'user',
            actions: fixtureBytes(REFUSED_CALLABLE),
            timestamp: NOW,
          });
        },
      );

      await migrateFromSqlalchemyPickle({sourceDbUrl, destDbUrl});

      expect(process.env['ADK_MIGRATION_PICKLE_RCE']).toBeUndefined();
      expect(logs.text()).toContain(
        'Failed to unpickle actions for event event1',
      );
      expect(actionsOf((await readDestination(destPath))['events'])).toEqual({
        state_delta: {},
        artifact_delta: {},
        requested_auth_configs: {},
        requested_tool_confirmations: {},
      });
    });

    it('test_migrate_from_sqlalchemy_pickle_allows_unsafe_actions_pickle_when_opted_in', async () => {
      // Adapted: opting in only widens which class names resolve. The payload
      // decodes to an inert record and still runs nothing.
      const {sourceDbUrl, destDbUrl, destPath} = await makeSource(
        'unsafe-actions',
        async (source) => {
          await addSession(source, NOW);
          await source.insert('events', {
            id: 'event1',
            app_name: 'app1',
            user_id: 'user1',
            session_id: 'session1',
            invocation_id: 'invoke1',
            author: 'user',
            actions: fixtureBytes(REFUSED_CALLABLE),
            timestamp: NOW,
          });
        },
      );

      await migrateFromSqlalchemyPickle({
        sourceDbUrl,
        destDbUrl,
        allowUnsafeUnpickling: true,
      });

      expect(process.env['ADK_MIGRATION_PICKLE_RCE']).toBeUndefined();
      // `builtins.eval` is not an EventActions, so the row keeps empty actions.
      expect(actionsOf((await readDestination(destPath))['events'])).toEqual({
        state_delta: {},
        artifact_delta: {},
        requested_auth_configs: {},
        requested_tool_confirmations: {},
      });
    });

    it('test_migrate_from_sqlalchemy_pickle_with_async_driver_urls', async () => {
      const source = await SqliteFixture.open(
        databasePath(directory, 'async-source.db'),
      );
      await source.createV0Tables();
      await source.insert('app_states', {
        app_name: 'async_app',
        state: '{"key": "value"}',
        update_time: NOW,
      });
      await source.insert('sessions', {
        app_name: 'async_app',
        user_id: 'async_user',
        id: 'async_session',
        state: '{}',
        create_time: NOW,
        update_time: NOW,
      });
      const sourcePath = source.path;
      await source.close();
      const destPath = databasePath(directory, 'async-dest.db');

      await migrateFromSqlalchemyPickle({
        sourceDbUrl: sqliteUrl(sourcePath, 'sqlite+aiosqlite'),
        destDbUrl: sqliteUrl(destPath, 'sqlite+aiosqlite'),
      });

      const destination = await readDestination(destPath);
      expect(destination['metadata']).toEqual([
        {key: 'schema_version', value: '1'},
      ]);
      expect(destination['appStates'][0]['app_name']).toBe('async_app');
      expect(JSON.parse(String(destination['appStates'][0]['state']))).toEqual({
        key: 'value',
      });
      expect(destination['sessions'][0]['id']).toBe('async_session');
    });
  },
);
