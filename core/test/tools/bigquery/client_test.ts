/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/bigquery/test_bigquery_client.py`
 * (branch `main`).
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {
  BigQueryClientCache,
  BQ_USER_AGENT,
  buildUserAgent,
  DP_USER_AGENT,
  getBigQueryClient,
  getDataplexCatalogClient,
  USER_AGENT_BASE,
} from '../../../src/tools/bigquery/client.js';
import {version} from '../../../src/version.js';
import {bigQueryState, resetBigQueryState} from './bigquery_fakes.js';

vi.mock('@google-cloud/bigquery', async () => {
  const {FakeBigQuery} = await import('./bigquery_fakes.js');
  return {BigQuery: FakeBigQuery};
});

vi.mock('@google-cloud/dataplex', async () => {
  const {FakeCatalogServiceClient} = await import('./bigquery_fakes.js');
  return {CatalogServiceClient: FakeCatalogServiceClient};
});

beforeEach(() => {
  resetBigQueryState();
});

describe('buildUserAgent', () => {
  it('test_bigquery_client_user_agent_default', () => {
    expect(buildUserAgent(BQ_USER_AGENT, [])).toBe(
      `adk-bigquery-tool google-adk/${version}`,
    );
    expect(USER_AGENT_BASE).toBe(`google-adk/${version}`);
  });

  it('test_bigquery_client_user_agent_custom', () => {
    expect(buildUserAgent(BQ_USER_AGENT, ['my-agent'])).toBe(
      `${BQ_USER_AGENT} my-agent`,
    );
  });

  it('test_bigquery_client_user_agent_custom_list', () => {
    expect(buildUserAgent(BQ_USER_AGENT, ['my-agent', 'execute_sql'])).toBe(
      `${BQ_USER_AGENT} my-agent execute_sql`,
    );
  });

  it('test_dataplex_client_custom_user_agent_list_with_none', () => {
    expect(buildUserAgent(DP_USER_AGENT, [undefined, 'search_catalog'])).toBe(
      `${DP_USER_AGENT} search_catalog`,
    );
  });
});

describe('getBigQueryClient', () => {
  it('test_bigquery_client_default', async () => {
    await getBigQueryClient({projectId: 'test-gcp-project'});

    expect(bigQueryState.clientOptions).toEqual([
      {
        projectId: 'test-gcp-project',
        location: undefined,
        userAgent: BQ_USER_AGENT,
        credentials: undefined,
        keyFilename: undefined,
        scopes: [
          'https://www.googleapis.com/auth/bigquery',
          'https://www.googleapis.com/auth/dataplex.read-write',
        ],
      },
    ]);
  });

  it('test_bigquery_client_location_custom', async () => {
    await getBigQueryClient({projectId: 'p', location: 'europe-west1'});

    expect(bigQueryState.clientOptions[0].location).toBe('europe-west1');
  });

  it('passes the caller credentials through to the client', async () => {
    const credentials = {client_email: 'a@b.example', private_key: 'key'};

    await getBigQueryClient(
      {projectId: 'p'},
      {credentials, keyFilename: '/tmp/key.json', scopes: ['scope-a']},
    );

    expect(bigQueryState.clientOptions[0]).toMatchObject({
      credentials,
      keyFilename: '/tmp/key.json',
      scopes: ['scope-a'],
    });
  });
});

describe('getDataplexCatalogClient', () => {
  it('test_dataplex_client_default', async () => {
    await getDataplexCatalogClient([]);

    expect(bigQueryState.dataplexOptions).toEqual([
      {
        credentials: undefined,
        keyFilename: undefined,
        scopes: [
          'https://www.googleapis.com/auth/bigquery',
          'https://www.googleapis.com/auth/dataplex.read-write',
        ],
        'grpc.primary_user_agent': DP_USER_AGENT,
      },
    ]);
  });

  it('passes the caller credentials through to the client', async () => {
    const credentials = {client_email: 'a@b.example', private_key: 'key'};

    await getDataplexCatalogClient([], {
      credentials,
      keyFilename: '/tmp/key.json',
      scopes: ['scope-a'],
    });

    expect(bigQueryState.dataplexOptions[0]).toMatchObject({
      credentials,
      keyFilename: '/tmp/key.json',
      scopes: ['scope-a'],
    });
  });

  it('test_dataplex_client_custom_user_agent_str', async () => {
    await getDataplexCatalogClient(['my-agent']);

    expect(bigQueryState.dataplexOptions[0]['grpc.primary_user_agent']).toBe(
      `${DP_USER_AGENT} my-agent`,
    );
  });

  it('test_dataplex_client_custom_user_agent_list', async () => {
    await getDataplexCatalogClient(['my-agent', 'search_catalog']);

    expect(bigQueryState.dataplexOptions[0]['grpc.primary_user_agent']).toBe(
      `${DP_USER_AGENT} my-agent search_catalog`,
    );
  });
});

describe('BigQueryClientCache', () => {
  it('builds one client per distinct set of options', async () => {
    const cache = new BigQueryClientCache();

    const first = await cache.get({projectId: 'p'});
    const again = await cache.get({projectId: 'p'});
    const other = await cache.get({projectId: 'q'});

    expect(first).toBe(again);
    expect(other).not.toBe(first);
    expect(bigQueryState.clientOptions).toHaveLength(2);
  });

  it('keys the cache on the location and the user agent too', async () => {
    const cache = new BigQueryClientCache();

    await cache.get({projectId: 'p'});
    await cache.get({projectId: 'p', location: 'EU'});
    await cache.get({projectId: 'p', userAgentExtras: ['execute_sql']});

    expect(bigQueryState.clientOptions).toHaveLength(3);
  });

  it('keys a client built without a project or a location', async () => {
    const cache = new BigQueryClientCache();

    const first = await cache.get({});
    const again = await cache.get({});

    expect(first).toBe(again);
    expect(bigQueryState.clientOptions).toHaveLength(1);
  });

  it('rebuilds a client after a failed build', async () => {
    const cache = new BigQueryClientCache();
    const failure = Object.assign(new Error('boom'), {
      code: 'ERR_MODULE_NOT_FOUND',
    });
    const bigquery = await import('@google-cloud/bigquery');
    const constructor = vi
      .spyOn(bigquery, 'BigQuery')
      .mockImplementationOnce(() => {
        throw failure;
      });

    await expect(cache.get({projectId: 'p'})).rejects.toThrow('boom');
    constructor.mockRestore();

    await expect(cache.get({projectId: 'p'})).resolves.toBeDefined();
  });

  it('releases every client it opened', async () => {
    const cache = new BigQueryClientCache();
    await cache.get({projectId: 'p'});

    cache.close();
    await cache.get({projectId: 'p'});

    expect(bigQueryState.clientOptions).toHaveLength(2);
  });
});
