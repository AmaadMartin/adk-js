/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/bigquery/test_bigquery_credentials.py`
 * (branch `main`).
 */

import {
  BIGQUERY_DEFAULT_SCOPE,
  BIGQUERY_SCOPES,
  BIGQUERY_TOKEN_CACHE_KEY,
  resolveBigQueryScopes,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('BigQueryCredentialsConfig', () => {
  it('test_valid_client_id_secret_pair_default_scope', () => {
    expect(resolveBigQueryScopes({keyFilename: '/tmp/key.json'})).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
  });

  it('test_valid_client_id_secret_pair_w_scope', () => {
    const scopes = [
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/drive',
    ];

    expect(resolveBigQueryScopes({scopes})).toEqual(scopes);
  });

  it('test_valid_client_id_secret_pair_w_empty_scope', () => {
    expect(resolveBigQueryScopes({scopes: []})).toEqual(BIGQUERY_SCOPES);
  });

  it('falls back to the full scope set when no config is given', () => {
    expect(resolveBigQueryScopes()).toEqual(BIGQUERY_SCOPES);
  });

  it('publishes the scopes and the token cache key adk-python uses', () => {
    expect(BIGQUERY_SCOPES).toEqual([
      'https://www.googleapis.com/auth/bigquery',
      'https://www.googleapis.com/auth/dataplex.read-write',
    ]);
    expect(BIGQUERY_DEFAULT_SCOPE).toEqual([
      'https://www.googleapis.com/auth/bigquery',
    ]);
    expect(BIGQUERY_TOKEN_CACHE_KEY).toBe('bigquery_token_cache');
  });
});
