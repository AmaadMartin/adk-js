/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {version} from '@google/adk';
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  SPANNER_PEER,
  withSpannerDatabase,
} from '../../../src/tools/spanner/client.js';
import {loadOptionalPeer} from '../../../src/utils/optional_peer.js';
import {resetSpannerFake, spannerFake} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner', async () => {
  const utils = await import('./spanner_test_utils.js');
  return utils.spannerModuleFake();
});

const TARGET = {
  projectId: 'my-project',
  instanceId: 'my-instance',
  databaseId: 'my-database',
};

describe('withSpannerDatabase', () => {
  beforeEach(() => {
    resetSpannerFake();
  });

  it('stamps the ADK user agent on the client', async () => {
    await withSpannerDatabase(TARGET, async () => 'done');

    expect(spannerFake.clients).toHaveLength(1);
    expect(spannerFake.clients[0]?.options).toMatchObject({
      projectId: 'my-project',
      libName: 'adk-spanner-tool google-adk',
      libVersion: version,
    });
  });

  it('passes the auth client and the database role through', async () => {
    const credentials = new OAuth2Client();
    await withSpannerDatabase(
      {...TARGET, credentials, databaseRole: 'reader'},
      async () => 'done',
    );

    expect(spannerFake.clients[0]?.options['authClient']).toBe(credentials);
    expect(spannerFake.databases[0]?.databaseId).toBe('my-database');
    expect(spannerFake.databases[0]?.databaseRole).toBe('reader');
  });

  it('returns what the caller produced', async () => {
    await expect(withSpannerDatabase(TARGET, async () => 42)).resolves.toBe(42);
  });

  it('closes the database and the client on the success path', async () => {
    await withSpannerDatabase(TARGET, async () => 'done');

    expect(spannerFake.databases[0]?.closeCount).toBe(1);
    expect(spannerFake.clients[0]?.closeCount).toBe(1);
  });

  it('closes the database and the client on the failure path', async () => {
    await expect(
      withSpannerDatabase(TARGET, async () => {
        throw new Error('query failed');
      }),
    ).rejects.toThrow('query failed');

    expect(spannerFake.databases[0]?.closeCount).toBe(1);
    expect(spannerFake.clients[0]?.closeCount).toBe(1);
  });

  it('still closes the client when the database will not close', async () => {
    spannerFake.failDatabaseClose = new Error('session pool is busy');

    await expect(withSpannerDatabase(TARGET, async () => 'done')).resolves.toBe(
      'done',
    );
    expect(spannerFake.clients[0]?.closeCount).toBe(1);
  });

  it('still returns the result when the client will not close', async () => {
    spannerFake.failClientClose = new Error('transport is already gone');

    await expect(withSpannerDatabase(TARGET, async () => 'done')).resolves.toBe(
      'done',
    );
  });
});

describe('the Spanner optional peer', () => {
  it('names the feature and the install command when it is missing', async () => {
    const missing = Object.assign(
      new Error("Cannot find package '@google-cloud/spanner' imported from x"),
      {code: 'ERR_MODULE_NOT_FOUND'},
    );

    const promise = loadOptionalPeer(SPANNER_PEER, () => {
      throw missing;
    });

    await expect(promise).rejects.toThrow(/SpannerToolset requires/);
    await expect(promise).rejects.toThrow(/npm install @google-cloud\/spanner/);
  });
});
