/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQueryOptions} from '@google-cloud/bigquery';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  USER_AGENT,
  getBigQueryClient,
} from '../../../src/tools/bigquery/client.js';
import type {OptionalPeer} from '../../../src/utils/optional_peer.js';

const {BigQueryMock, requestedPeer} = vi.hoisted(() => ({
  BigQueryMock: vi.fn(),
  requestedPeer: vi.fn(),
}));

vi.mock('@google-cloud/bigquery', () => ({BigQuery: BigQueryMock}));

// The real loader still runs; the spy only records what it was asked for.
vi.mock('../../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/utils/optional_peer.js')
    >();
  return {
    ...actual,
    loadOptionalPeer: <T>(peer: OptionalPeer, load: () => Promise<T>) => {
      requestedPeer(peer);
      return actual.loadOptionalPeer(peer, load);
    },
  };
});

/** The options the code under test passed to the BigQuery constructor. */
function constructorOptions(): BigQueryOptions {
  const call = BigQueryMock.mock.calls[0];
  if (!call) {
    return expect.fail('the BigQuery constructor was never called');
  }
  return call[0] as BigQueryOptions;
}

describe('getBigQueryClient', () => {
  beforeEach(() => {
    BigQueryMock.mockClear();
    requestedPeer.mockClear();
  });

  it('identifies ADK to BigQuery and scopes the client to the project', async () => {
    await getBigQueryClient({projectId: 'my-project'});

    expect(constructorOptions()).toMatchObject({
      projectId: 'my-project',
      userAgent: USER_AGENT,
    });
    expect(USER_AGENT).toBe('adk-bigquery-tool');
  });

  it('passes the credential as an authorized-user credentials object', async () => {
    await getBigQueryClient({
      projectId: 'my-project',
      credentials: {
        clientId: 'client-id',
        clientSecret: 'client-secret',
        refreshToken: 'refresh-token',
      },
    });

    expect(constructorOptions().credentials).toEqual({
      type: 'authorized_user',
      client_id: 'client-id',
      client_secret: 'client-secret',
      refresh_token: 'refresh-token',
    });
  });

  it('omits the credentials so the client falls back to default ones', async () => {
    await getBigQueryClient({projectId: 'my-project'});

    expect(constructorOptions().credentials).toBeUndefined();
  });

  it('loads BigQuery as an optional peer, so a missing one is actionable', async () => {
    // `loadOptionalPeer` turns a missing package into an error naming the
    // feature and the install command; these two strings are what it names.
    // The message itself is covered by core/test/utils/optional_peer_test.ts.
    await getBigQueryClient({projectId: 'my-project'});

    expect(requestedPeer).toHaveBeenCalledWith({
      packageName: '@google-cloud/bigquery',
      feature: 'BigQueryToolset',
    });
  });
});
