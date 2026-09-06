/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk';
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  BIGTABLE_CLIENT_INFO,
  BIGTABLE_PEER,
  BigtableClientPool,
} from '../../../src/tools/bigtable/client.js';
import {GoogleTool, GoogleToolStatus} from '../../../src/tools/google_tool.js';
import {loadOptionalPeer} from '../../../src/utils/optional_peer.js';

import {fakeBigtableState, resetFakeBigtable} from './bigtable_fakes.js';

vi.mock('@google-cloud/bigtable', async () => ({
  Bigtable: (await import('./bigtable_fakes.js')).FakeBigtable,
}));

function credentialsWithToken(accessToken: string): OAuth2Client {
  const client = new OAuth2Client();
  client.setCredentials({access_token: accessToken});
  return client;
}

describe('BigtableClientPool', () => {
  beforeEach(() => {
    resetFakeBigtable();
  });

  it('opens no client until one is asked for', () => {
    const pool = new BigtableClientPool();

    expect(fakeBigtableState.calls.constructed).toEqual([]);
    expect(pool).toBeDefined();
  });

  it('identifies the toolset to the service on every generated client', async () => {
    const pool = new BigtableClientPool();

    await pool.get('test-project');

    expect(fakeBigtableState.calls.constructed[0]).toEqual({
      projectId: 'test-project',
      BigtableClient: BIGTABLE_CLIENT_INFO,
      BigtableInstanceAdminClient: BIGTABLE_CLIENT_INFO,
      BigtableTableAdminClient: BIGTABLE_CLIENT_INFO,
    });
    expect(BIGTABLE_CLIENT_INFO.libName).toBe('adk-bigtable-tool');
  });

  it('reuses one client per project', async () => {
    const pool = new BigtableClientPool();

    const first = await pool.get('test-project');
    const second = await pool.get('test-project');

    expect(second).toBe(first);
    expect(fakeBigtableState.calls.constructed).toHaveLength(1);
  });

  it('opens a separate client for each project', async () => {
    const pool = new BigtableClientPool();

    await pool.get('project-a');
    await pool.get('project-b');

    expect(
      fakeBigtableState.calls.constructed.map(
        (options) => options['projectId'],
      ),
    ).toEqual(['project-a', 'project-b']);
  });

  it('passes the resolved credentials to the client', async () => {
    const pool = new BigtableClientPool();

    await pool.get('test-project', credentialsWithToken('token-1'));

    expect(fakeBigtableState.calls.constructed[0]['authClient']).toBeDefined();
  });

  it('reuses the client while the access token is unchanged', async () => {
    const pool = new BigtableClientPool();
    const credentials = credentialsWithToken('token-1');

    await pool.get('test-project', credentials);
    await pool.get('test-project', credentialsWithToken('token-1'));

    expect(fakeBigtableState.calls.constructed).toHaveLength(1);
  });

  it('replaces the client when the access token changes', async () => {
    const pool = new BigtableClientPool();

    await pool.get('test-project', credentialsWithToken('token-1'));
    await pool.get('test-project', credentialsWithToken('token-2'));
    await vi.waitFor(() => expect(fakeBigtableState.calls.closed).toBe(1));

    expect(fakeBigtableState.calls.constructed).toHaveLength(2);
  });

  it('closes every client it opened', async () => {
    const pool = new BigtableClientPool();
    await pool.get('project-a');
    await pool.get('project-b');

    await pool.close();

    expect(fakeBigtableState.calls.closed).toBe(2);
  });

  it('closes nothing on a second close', async () => {
    const pool = new BigtableClientPool();
    await pool.get('project-a');

    await pool.close();
    await pool.close();

    expect(fakeBigtableState.calls.closed).toBe(1);
  });

  it('reports a failure to close at debug rather than throwing', async () => {
    const pool = new BigtableClientPool();
    const client = await pool.get('project-a');
    vi.spyOn(client, 'close').mockRejectedValue(new Error('channel gone'));

    await expect(pool.close()).resolves.toBeUndefined();
  });

  it('keeps the install command in the error a tool reports', async () => {
    const notInstalled: Error & {code?: string} = new Error(
      "Cannot find package '@google-cloud/bigtable'",
    );
    notInstalled.code = 'ERR_MODULE_NOT_FOUND';
    const tool = new GoogleTool({
      name: 'bigtable_list_instances',
      description: 'Lists Bigtable instances.',
      execute: () =>
        loadOptionalPeer(BIGTABLE_PEER, () => Promise.reject(notInstalled)),
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: new Context({
        invocationContext: new InvocationContext({
          invocationId: 'test-invocation',
          session: createSession({
            id: 'session-1',
            appName: 'test-app',
            userId: 'test-user',
          }),
          pluginManager: new PluginManager([]),
        }),
      }),
    });

    expect(result).toMatchObject({status: GoogleToolStatus.ERROR});
    expect((result as {errorDetails: string}).errorDetails).toContain(
      'npm install @google-cloud/bigtable',
    );
  });
});
