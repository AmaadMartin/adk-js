/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python@main
 * `tests/unittests/integrations/bigquery/test_bigquery_client.py`. The ported
 * cases keep their Python names.
 *
 * Three project-resolution cases are not ported:
 * `test_bigquery_client_project_set_explicit`,
 * `test_bigquery_client_project_set_with_default_auth` and
 * `test_bigquery_client_project_set_with_env` patch `google.auth.default` and
 * assert it was or was not called. The Node client resolves its project
 * inside the SDK with no comparable seam, and `project` is required here, so
 * there is nothing left to assert. `test_dataplex_client_custom_user_agent_*`
 * are not ported either: google-gax carries `libName`/`libVersion` rather
 * than a free-form user agent, so a Dataplex call cannot take extra tokens.
 */

import {version} from '@google/adk';
import {
  BIGQUERY_USER_AGENT,
  DATAPLEX_LIB_NAME,
  USER_AGENT_BASE,
  composeUserAgent,
  getBigQueryClient,
  getDataplexCatalogClient,
} from '@google/adk/integrations/bigquery/client.js';
import {OAuth2Client} from 'google-auth-library';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  FakeBigQuery,
  FakeCatalogServiceClient,
  fakeState,
  resetFakes,
} from './bigquery_fakes.js';

vi.mock('@google-cloud/bigquery', async () => {
  const {FakeBigQuery: Fake} = await import('./bigquery_fakes.js');
  return {BigQuery: Fake};
});

vi.mock('@google-cloud/dataplex', async () => {
  const {FakeCatalogServiceClient: Fake} = await import('./bigquery_fakes.js');
  return {CatalogServiceClient: Fake};
});

/** The options the last BigQuery client was built with. */
function lastBigQueryOptions(): Record<string, unknown> {
  const {constructed} = fakeState.bigquery.calls;
  return constructed[constructed.length - 1];
}

/** The user-agent tokens the last BigQuery client reported. */
function lastUserAgentTokens(): Set<string> {
  return new Set(String(lastBigQueryOptions()['userAgent']).split(' '));
}

describe('getBigQueryClient', () => {
  beforeEach(() => {
    resetFakes();
  });

  it('test_bigquery_client_default', async () => {
    const client = await getBigQueryClient({
      project: 'test-gcp-project',
      credentials: new OAuth2Client(),
    });

    expect(client).toBeInstanceOf(FakeBigQuery);
    expect(lastBigQueryOptions()['projectId']).toBe('test-gcp-project');
    expect(lastBigQueryOptions()['location']).toBeUndefined();
  });

  it('test_bigquery_client_user_agent_default', async () => {
    await getBigQueryClient({
      project: 'test-gcp-project',
      credentials: new OAuth2Client(),
    });

    expect(lastUserAgentTokens()).toEqual(
      new Set(['adk-bigquery-tool', `google-adk/${version}`]),
    );
  });

  it('test_bigquery_client_user_agent_custom', async () => {
    await getBigQueryClient({
      project: 'test-gcp-project',
      credentials: new OAuth2Client(),
      userAgent: ['test-user-agent'],
    });

    expect(lastUserAgentTokens()).toContain('test-user-agent');
  });

  it('test_bigquery_client_user_agent_custom_list', async () => {
    await getBigQueryClient({
      project: 'test-gcp-project',
      credentials: new OAuth2Client(),
      userAgent: ['agent-one', 'agent-two'],
    });

    const tokens = lastUserAgentTokens();
    expect(tokens).toContain('agent-one');
    expect(tokens).toContain('agent-two');
  });

  it('test_bigquery_client_location_custom', async () => {
    await getBigQueryClient({
      project: 'test-gcp-project',
      credentials: new OAuth2Client(),
      location: 'europe-west1',
    });

    expect(lastBigQueryOptions()['location']).toBe('europe-west1');
  });

  it('passes the credential through to the SDK', async () => {
    const credentials = new OAuth2Client();
    await getBigQueryClient({project: 'p', credentials});

    expect(lastBigQueryOptions()['authClient']).toBe(credentials);
  });

  it('leaves the SDK to find application default credentials', async () => {
    await getBigQueryClient({project: 'p'});

    expect(lastBigQueryOptions()).not.toHaveProperty('authClient');
  });
});

describe('getDataplexCatalogClient', () => {
  beforeEach(() => {
    resetFakes();
  });

  it('test_dataplex_client_default', async () => {
    const client = await getDataplexCatalogClient({
      credentials: new OAuth2Client(),
    });

    expect(client).toBeInstanceOf(FakeCatalogServiceClient);
    const options = fakeState.dataplex.calls.constructed[0];
    expect(options['libName']).toBe(DATAPLEX_LIB_NAME);
    expect(options['libVersion']).toBe(version);
  });

  it('passes the credential through to the SDK', async () => {
    const credentials = new OAuth2Client();
    await getDataplexCatalogClient({credentials});

    expect(fakeState.dataplex.calls.constructed[0]['authClient']).toBe(
      credentials,
    );
  });

  it('leaves the SDK to find application default credentials', async () => {
    await getDataplexCatalogClient({});

    expect(fakeState.dataplex.calls.constructed[0]).not.toHaveProperty(
      'authClient',
    );
  });
});

describe('composeUserAgent', () => {
  it('reports the tool family and the ADK version', () => {
    expect(BIGQUERY_USER_AGENT).toBe(`adk-bigquery-tool ${USER_AGENT_BASE}`);
    expect(USER_AGENT_BASE).toBe(`google-adk/${version}`);
  });

  it('drops a token the caller did not set', () => {
    expect(composeUserAgent('base', [undefined, 'tool', ''])).toBe('base tool');
  });

  it('returns the base alone when there is nothing to add', () => {
    expect(composeUserAgent('base')).toBe('base');
  });
});
