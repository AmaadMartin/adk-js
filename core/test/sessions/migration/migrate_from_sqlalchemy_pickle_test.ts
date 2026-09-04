/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `tests/unittests/sessions/migration/test_migration.py` in
 * `google/adk-python`, branch `main`. Each `it()` keeps the reference test's
 * name, so a reviewer can grep for the original. Tests that adk-js needs but
 * the reference does not have live in
 * `migrate_from_sqlalchemy_pickle_row_reading_test.ts`.
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

import {DatabaseSessionService} from '../../../src/sessions/database_session_service.js';
import {getConnectionOptionsFromUri} from '../../../src/sessions/db/operations.js';
import {
  SCHEMA_VERSION_1_JSON,
  SCHEMA_VERSION_KEY,
  StorageAppState,
  StorageEvent,
  StorageMetadata,
  StorageSession,
  StorageUserState,
} from '../../../src/sessions/db/schema.js';
import {
  migrate,
  rowToEvent,
  toSyncUrl,
} from '../../../src/sessions/migration/migrate_from_sqlalchemy_pickle.js';
import {loadEventActions} from '../../../src/sessions/restricted_pickle.js';
import {logger} from '../../../src/utils/logger.js';
import {redactUriPassword} from '../../../src/utils/redact_uri.js';
import {fromBase64} from '../../utils/pickle_payload_test_utils.js';
import {
  DATETIME_STATE_DELTA,
  ESCALATE,
  EVIL_EXEC,
  NESTED,
  SIMPLE_STATE_DELTA,
  STATE_AND_ARTIFACT,
} from '../pickled_actions_fixtures.js';
import {createV0Database, V0_TIMESTAMP} from './v0_database.js';

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), 'adk-migration-'));
});

afterAll(async () => {
  await rm(workDir, {recursive: true, force: true});
});

beforeEach(() => {
  // The migration reports its progress at info; a test that asserts on those
  // lines spies again, which reuses this mock.
  vi.spyOn(logger, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A unique pair of database paths for one test. */
function databasePaths(name: string): {source: string; dest: string} {
  return {
    source: join(workDir, `${name}-source.db`),
    dest: join(workDir, `${name}-dest.db`),
  };
}

/** Opens the migrated database so a test can read what landed in it. */
async function openDestination(dbPath: string): Promise<MikroORM> {
  return MikroORM.init(await getConnectionOptionsFromUri(`sqlite://${dbPath}`));
}

/** A source holding one app state, user state, session and event. */
async function createFullSource(
  sourcePath: string,
  actions: Uint8Array,
): Promise<void> {
  await createV0Database(sourcePath, {
    appStates: [{appName: 'app1', state: JSON.stringify({akey: 1})}],
    userStates: [
      {appName: 'app1', userId: 'user1', state: JSON.stringify({ukey: 2})},
    ],
    sessions: [
      {
        appName: 'app1',
        userId: 'user1',
        id: 'session1',
        state: JSON.stringify({skey: 3}),
      },
    ],
    events: [{id: 'event1', actions}],
  });
}

describe('to_sync_url', () => {
  const CASES: ReadonlyArray<[string, string]> = [
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
    ['sqlite+aiosqlite:///:memory:', 'sqlite:///:memory:'],
    ['postgresql://localhost/mydb', 'postgresql://localhost/mydb'],
    ['mysql://localhost/mydb', 'mysql://localhost/mydb'],
    ['sqlite:///path/to/db.sqlite', 'sqlite:///path/to/db.sqlite'],
    ['sqlite:///:memory:', 'sqlite:///:memory:'],
    [
      'postgresql+asyncpg://user:pass@host/db?ssl=require',
      'postgresql://user:pass@host/db?ssl=require',
    ],
  ];

  it.each(CASES)('test_to_sync_url: %s', (input, expected) => {
    expect(toSyncUrl(input)).toBe(expected);
  });

  it('test_to_sync_url_no_scheme_separator', () => {
    expect(toSyncUrl('not-a-url')).toBe('not-a-url');
  });

  it('test_to_sync_url_empty_string', () => {
    expect(toSyncUrl('')).toBe('');
  });
});

describe('redact the database URL', () => {
  it('test_password_is_masked', () => {
    expect(
      redactUriPassword('postgresql+asyncpg://user:sup3r-s3cret@host:5432/db'),
    ).toBe('postgresql+asyncpg://user:***@host:5432/db');
  });

  it('test_unparseable_url_falls_back_to_placeholder', () => {
    // The reference falls back to `<unparseable database URL>`; adk-js reuses
    // its own `redactUriPassword`, whose placeholder is worded differently.
    expect(redactUriPassword('definitely not a url sup3r-s3cret')).toBe(
      '<unparseable URI, redacted>',
    );
  });

  it('test_query_parameter_values_are_masked', () => {
    // The reference masks every query value to `REDACTED`; adk-js masks a
    // named list of secret parameters to `***` and leaves the rest readable.
    expect(
      redactUriPassword(
        'postgresql://user@host:5432/db?password=sup3r-s3cret&sslmode=require',
      ),
    ).toBe('postgresql://user@host:5432/db?password=***&sslmode=require');
  });
});

describe('migration logs hide the password', () => {
  /** A scheme adk-js does not support, so the connection fails without I/O. */
  const SOURCE_URL = 'oracle+oracledb://user:sup3r-s3cret@host:1521/src';
  const DEST_URL = 'oracle+oracledb://user:0ther-s3cret@host:1521/dst';

  it('test_pickle_migration_connect_logs_are_redacted', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const {dest} = databasePaths('redacted-source');

    await expect(
      migrate({sourceDbUrl: SOURCE_URL, destDbUrl: `sqlite://${dest}`}),
    ).rejects.toThrow('Failed to connect to source database');

    const written = [...info.mock.calls, ...error.mock.calls].flat().join('\n');
    expect(written).not.toContain('sup3r-s3cret');
    expect(written).toContain('oracle+oracledb://user:***@host:1521/src');
  });

  it('keeps the destination password out of the logs', async () => {
    // The reference covers both URLs in one test by mocking the engine
    // factory. adk-js opens a real source instead, so the destination case
    // needs its own working source database.
    const info = vi.spyOn(logger, 'info').mockImplementation(() => {});
    const error = vi.spyOn(logger, 'error').mockImplementation(() => {});
    const {source} = databasePaths('redacted-dest');
    await createV0Database(source);

    await expect(
      migrate({sourceDbUrl: `sqlite://${source}`, destDbUrl: DEST_URL}),
    ).rejects.toThrow('Failed to connect to destination database');

    const written = [...info.mock.calls, ...error.mock.calls].flat().join('\n');
    expect(written).not.toContain('0ther-s3cret');
    expect(written).toContain('oracle+oracledb://user:***@host:1521/dst');
  });
});

describe('migrate', () => {
  it('test_migrate_from_sqlalchemy_pickle', async () => {
    const {source, dest} = databasePaths('full');
    await createFullSource(source, fromBase64(SIMPLE_STATE_DELTA));

    await migrate({
      sourceDbUrl: `sqlite://${source}`,
      destDbUrl: `sqlite://${dest}`,
    });

    const orm = await openDestination(dest);
    try {
      const em = orm.em.fork();
      const metadata = await em.findOne(StorageMetadata, {
        key: SCHEMA_VERSION_KEY,
      });
      expect(metadata?.value).toBe(SCHEMA_VERSION_1_JSON);

      const appState = await em.findOne(StorageAppState, {appName: 'app1'});
      expect(appState?.state).toEqual({akey: 1});

      const userState = await em.findOne(StorageUserState, {userId: 'user1'});
      expect(userState?.state).toEqual({ukey: 2});

      const session = await em.findOne(StorageSession, {id: 'session1'});
      expect(session?.state).toEqual({skey: 3});

      const event = await em.findOne(StorageEvent, {id: 'event1'});
      expect(event?.eventData.actions.stateDelta).toEqual({skey: 4});
      expect(event?.eventData.author).toBe('user');
      expect(event?.invocationId).toBe('invoke1');
    } finally {
      await orm.close(true);
    }
  });

  it('test_migrate_from_sqlalchemy_pickle_preserves_safe_actions_pickle', async () => {
    const {source, dest} = databasePaths('safe-actions');
    await createFullSource(source, fromBase64(STATE_AND_ARTIFACT));

    await migrate({
      sourceDbUrl: `sqlite://${source}`,
      destDbUrl: `sqlite://${dest}`,
    });

    const orm = await openDestination(dest);
    try {
      const event = await orm.em.fork().findOne(StorageEvent, {id: 'event1'});
      expect(event?.eventData.actions.stateDelta).toEqual({skey: 'updated'});
      expect(event?.eventData.actions.artifactDelta).toEqual({
        'artifact.txt': 2,
      });
    } finally {
      await orm.close(true);
    }
  });

  it('test_migrate_from_sqlalchemy_pickle_preserves_nested_safe_actions_pickle', async () => {
    const {source, dest} = databasePaths('nested-actions');
    await createFullSource(source, fromBase64(NESTED));

    await migrate({
      sourceDbUrl: `sqlite://${source}`,
      destDbUrl: `sqlite://${dest}`,
    });

    const orm = await openDestination(dest);
    try {
      const event = await orm.em.fork().findOne(StorageEvent, {id: 'event1'});
      const actions = event?.eventData.actions;
      expect(actions?.requestedToolConfirmations['fc-confirm'].hint).toBe(
        'Authorize execution?',
      );
      expect(actions).toMatchObject({
        compaction: {
          compactedContent: {parts: [{text: 'summary'}]},
        },
      });
    } finally {
      await orm.close(true);
    }
  });

  it('test_migrate_from_sqlalchemy_pickle_with_async_driver_urls', async () => {
    const {source, dest} = databasePaths('async-urls');
    await createV0Database(source, {
      appStates: [
        {appName: 'async_app', state: JSON.stringify({key: 'value'})},
      ],
      sessions: [
        {
          appName: 'async_app',
          userId: 'async_user',
          id: 'async_session',
          state: '{}',
        },
      ],
    });

    await migrate({
      sourceDbUrl: `sqlite+aiosqlite://${source}`,
      destDbUrl: `sqlite+aiosqlite://${dest}`,
    });

    const orm = await openDestination(dest);
    try {
      const em = orm.em.fork();
      const metadata = await em.findOne(StorageMetadata, {
        key: SCHEMA_VERSION_KEY,
      });
      expect(metadata?.value).toBe(SCHEMA_VERSION_1_JSON);
      const appState = await em.findOne(StorageAppState, {
        appName: 'async_app',
      });
      expect(appState?.state).toEqual({key: 'value'});
      const session = await em.findOne(StorageSession, {id: 'async_session'});
      expect(session).not.toBeNull();
    } finally {
      await orm.close(true);
    }
  });

  it('test_migrate_from_sqlalchemy_pickle_blocks_unsafe_actions_pickle', async () => {
    // The reference asserts that Python's `exec` did not run. Nothing is ever
    // executed here, so this asserts the recoverable outcome instead: the row
    // still migrates, with empty actions and a warning.
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const {source, dest} = databasePaths('blocked-actions');
    await createFullSource(source, fromBase64(EVIL_EXEC));

    await migrate({
      sourceDbUrl: `sqlite://${source}`,
      destDbUrl: `sqlite://${dest}`,
    });

    expect(process.env['ADK_MIGRATION_PICKLE_RCE']).toBeUndefined();
    expect(warn.mock.calls.flat().join('\n')).toContain(
      'Refusing to load builtins.exec',
    );

    const orm = await openDestination(dest);
    try {
      const event = await orm.em.fork().findOne(StorageEvent, {id: 'event1'});
      expect(event?.eventData.actions.stateDelta).toEqual({});
    } finally {
      await orm.close(true);
    }
  });

  it('test_migrate_from_sqlalchemy_pickle_allows_unsafe_actions_pickle_when_opted_in', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const {source, dest} = databasePaths('unsafe-opt-in');
    await createFullSource(source, fromBase64(EVIL_EXEC));

    await migrate({
      sourceDbUrl: `sqlite://${source}`,
      destDbUrl: `sqlite://${dest}`,
      allowUnsafeUnpickling: true,
    });

    // The opt-in only turns the allowlist off; nothing runs either way.
    expect(process.env['ADK_MIGRATION_PICKLE_RCE']).toBeUndefined();
    const warnings = warn.mock.calls.flat().join('\n');
    expect(warnings).toContain('Unsafe pickle migration mode is enabled');
    expect(warnings).not.toContain('Refusing to load');
  });

  it('leaves a migrated database readable by DatabaseSessionService', async () => {
    const {source, dest} = databasePaths('readable');
    await createFullSource(source, fromBase64(SIMPLE_STATE_DELTA));

    await migrate({
      sourceDbUrl: `sqlite://${source}`,
      destDbUrl: `sqlite://${dest}`,
    });

    const service = new DatabaseSessionService(`sqlite://${dest}`);
    const session = await service.getSession({
      appName: 'app1',
      userId: 'user1',
      sessionId: 'session1',
    });
    expect(session?.events[0].actions.stateDelta).toEqual({skey: 4});
    // DatabaseSessionService prefixes the app- and user-scoped keys.
    expect(session?.state).toMatchObject({
      'app:akey': 1,
      'user:ukey': 2,
      'skey': 3,
    });
  });
});

describe('restricted actions unpickler', () => {
  it('test_restricted_actions_unpickler_allows_datetime_state_delta', () => {
    const actions = loadEventActions(fromBase64(DATETIME_STATE_DELTA));
    expect(actions.stateDelta['last_seen']).toBe('2026-01-01T12:30:00Z');
  });

  it('test_restricted_actions_unpickler_allows_nested_adk_models', () => {
    // Replaces the reference's `..._allows_ui_widgets`: adk-js has no
    // `renderUiWidgets` field to assert on, so this pins allowlist coverage
    // of a nested ADK model instead.
    const actions = loadEventActions(fromBase64(NESTED));
    expect(actions.requestedToolConfirmations['fc-confirm']).toEqual({
      hint: 'Authorize execution?',
      confirmed: false,
    });
  });
});

describe('rowToEvent', () => {
  it('test_migrate_from_sqlalchemy_pickle_ignores_non_object_json_fields', () => {
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const event = rowToEvent({
      id: 'event-list-content',
      invocation_id: 'invoke1',
      author: 'user',
      timestamp: V0_TIMESTAMP,
      content: '[1, 2, 3]',
    });

    expect(event.content).toBeUndefined();
  });

  const BINARY_FORMS: ReadonlyArray<[string, (bytes: Uint8Array) => unknown]> =
    [
      ['Buffer', (bytes) => Buffer.from(bytes)],
      ['Uint8Array', (bytes) => bytes],
      [
        'DataView',
        (bytes) =>
          new DataView(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          ),
      ],
    ];

  it.each(BINARY_FORMS)(
    'test_migrate_from_sqlalchemy_pickle_reads_every_binary_column_type: %s',
    (_name, toBinary) => {
      const event = rowToEvent({
        id: 'event-binary-actions',
        invocation_id: 'invoke1',
        author: 'user',
        timestamp: V0_TIMESTAMP,
        actions: toBinary(fromBase64(ESCALATE)),
      });

      expect(event.actions.stateDelta).toEqual({skey: 4});
      expect(event.actions.escalate).toBe(true);
    },
  );

  describe('test_migrate_from_sqlalchemy_pickle_reads_naive_timestamp_as_local', () => {
    const originalTimeZone = process.env['TZ'];

    beforeAll(() => {
      process.env['TZ'] = 'Asia/Kolkata';
    });

    afterAll(() => {
      if (originalTimeZone === undefined) {
        delete process.env['TZ'];
      } else {
        process.env['TZ'] = originalTimeZone;
      }
    });

    it('reads the column in the host zone, not as UTC', () => {
      // 1970-01-12 19:16:40 in Asia/Kolkata is epoch second 1000000.
      const event = rowToEvent({
        id: 'event-naive-timestamp',
        invocation_id: 'invoke1',
        author: 'user',
        timestamp: '1970-01-12 19:16:40',
      });

      expect(event.timestamp).toBe(1000000 * 1000);
    });
  });
});
