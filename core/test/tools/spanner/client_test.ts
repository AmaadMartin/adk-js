/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createTokenAuthClient,
  withSnapshot,
  withSpannerDatabase,
} from '../../../src/tools/spanner/client.js';
import {logger} from '../../../src/utils/logger.js';
import {version} from '../../../src/version.js';
import {spannerFake, testAuthClient, valueRow} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner', async () => {
  const {fakeSpannerModule} = await import('./spanner_test_utils.js');
  return fakeSpannerModule;
});

function target() {
  return {
    projectId: 'p',
    instanceId: 'i',
    databaseId: 'd',
    authClient: testAuthClient(),
  };
}

describe('withSpannerDatabase', () => {
  beforeEach(() => {
    spannerFake.reset();
    vi.restoreAllMocks();
  });

  it('attributes the client to the ADK Spanner tools', async () => {
    await withSpannerDatabase(target(), async () => undefined);

    expect(spannerFake.clientOptions).toEqual([
      {
        projectId: 'p',
        authClient: expect.anything(),
        libName: 'adk-spanner-tool google-adk',
        libVersion: version,
      },
    ]);
  });

  it('opens the database the target names, under no role by default', async () => {
    await withSpannerDatabase(target(), async () => undefined);

    expect(spannerFake.databases).toEqual([
      {instanceId: 'i', databaseId: 'd', databaseRole: undefined},
    ]);
  });

  it('opens the database under the role the target names', async () => {
    await withSpannerDatabase(
      {...target(), databaseRole: 'reader'},
      async () => undefined,
    );

    expect(spannerFake.databases[0].databaseRole).toBe('reader');
  });

  it('closes the database and the client after a successful call', async () => {
    const result = await withSpannerDatabase(target(), async () => 'value');

    expect(result).toBe('value');
    expect(spannerFake.closedDatabases).toBe(1);
    expect(spannerFake.closedClients).toBe(1);
  });

  it('closes both when the call rejects', async () => {
    const failing = withSpannerDatabase(target(), async () => {
      throw new Error('read failed');
    });

    await expect(failing).rejects.toThrow('read failed');
    expect(spannerFake.closedDatabases).toBe(1);
    expect(spannerFake.closedClients).toBe(1);
  });

  it('closes the client when opening the database throws', async () => {
    spannerFake.failures.getDatabaseDialect = new Error('unreachable');

    const failing = withSpannerDatabase(target(), (database) =>
      database.getDatabaseDialect(),
    );

    await expect(failing).rejects.toThrow('unreachable');
    expect(spannerFake.closedClients).toBe(1);
  });

  it('logs a failure to close the database and keeps the result', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    spannerFake.failures.closeDatabase = new Error('database stuck');

    await expect(
      withSpannerDatabase(target(), async () => 'value'),
    ).resolves.toBe('value');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to close the Spanner database'),
    );
    expect(spannerFake.closedClients).toBe(1);
  });

  it('logs a failure to close the client and keeps the result', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    spannerFake.failures.closeClient = new Error('client stuck');

    await expect(
      withSpannerDatabase(target(), async () => 'value'),
    ).resolves.toBe('value');
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Failed to close the Spanner client'),
    );
  });
});

describe('withSnapshot', () => {
  beforeEach(() => {
    spannerFake.reset();
  });

  it('ends the snapshot after a successful read', async () => {
    spannerFake.responses = [{match: 'SELECT 1', rows: [valueRow(1)]}];

    const rows = await withSpannerDatabase(target(), (database) =>
      withSnapshot(database, async (snapshot) => {
        const [read] = await snapshot.run({sql: 'SELECT 1'});
        return read;
      }),
    );

    expect(rows).toHaveLength(1);
    expect(spannerFake.endedSnapshots).toBe(1);
  });

  it('ends the snapshot when the read rejects', async () => {
    spannerFake.failures.run = new Error('query failed');

    const failing = withSpannerDatabase(target(), (database) =>
      withSnapshot(database, (snapshot) => snapshot.run({sql: 'SELECT 1'})),
    );

    await expect(failing).rejects.toThrow('query failed');
    expect(spannerFake.endedSnapshots).toBe(1);
  });

  it('does not end a snapshot it never opened', async () => {
    spannerFake.failures.getSnapshot = new Error('no session');

    const failing = withSpannerDatabase(target(), (database) =>
      withSnapshot(database, async () => undefined),
    );

    await expect(failing).rejects.toThrow('no session');
    expect(spannerFake.endedSnapshots).toBe(0);
  });
});

describe('createTokenAuthClient', () => {
  it('presents the access token it was given', async () => {
    const client = await createTokenAuthClient({
      accessToken: 'token-1',
      refreshToken: 'refresh-1',
      expiresAt: 4_102_444_800_000,
    });

    expect(client.credentials).toMatchObject({
      access_token: 'token-1',
      refresh_token: 'refresh-1',
      expiry_date: 4_102_444_800_000,
    });
  });

  it('keeps the OAuth client the refresh token belongs to', async () => {
    const client = await createTokenAuthClient(
      {accessToken: 'token-1'},
      {clientId: 'oauth-id', clientSecret: 'secret'},
    );

    expect(client.generateAuthUrl({scope: 'openid'})).toContain(
      'client_id=oauth-id',
    );
  });
});
