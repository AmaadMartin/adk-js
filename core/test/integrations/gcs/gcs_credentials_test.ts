/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/integrations/gcs/test_gcs_credentials.py`, read at `main`
 * commit `a119dd77`. Each test keeps its reference name.
 *
 * adk-python asserts on the pydantic model's fields. adk-js has no model: the
 * config is a plain interface the toolset validates, so each test asserts on
 * what the toolset accepts or rejects.
 */

import {GCS_DEFAULT_SCOPES} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  ADC_CREDENTIALS,
  createToolset,
  TEST_CREDENTIALS,
} from './gcs_test_utils.js';

describe('GcsCredentialsConfig', () => {
  it('test_gcs_credentials_config_client_id_secret', () => {
    expect(() =>
      createToolset({credentialsConfig: TEST_CREDENTIALS}),
    ).not.toThrow();
    expect(GCS_DEFAULT_SCOPES).toEqual([
      'https://www.googleapis.com/auth/devstorage.full_control',
    ]);
  });

  it('test_gcs_credentials_config_existing_creds', () => {
    // adk-python passes a credentials object. adk-js names Application
    // Default Credentials instead: `@google-cloud/storage` only accepts a
    // client built by the google-auth-library major it pins.
    expect(() =>
      createToolset({credentialsConfig: ADC_CREDENTIALS}),
    ).not.toThrow();
  });

  it('test_gcs_credentials_config_validation_errors', () => {
    expect(() => createToolset({credentialsConfig: {}})).toThrow(
      'Must provide either applicationDefaultCredentials, or a clientId and clientSecret pair.',
    );

    expect(() => createToolset({credentialsConfig: {clientId: 'abc'}})).toThrow(
      'Must provide either applicationDefaultCredentials, or a clientId and clientSecret pair.',
    );

    expect(() =>
      createToolset({
        credentialsConfig: {
          applicationDefaultCredentials: true,
          clientId: 'abc',
          clientSecret: 'def',
        },
      }),
    ).toThrow(
      'If applicationDefaultCredentials is set, clientId, clientSecret and scopes must not be provided.',
    );
  });
});
