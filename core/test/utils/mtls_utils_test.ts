/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {getApiEndpoint} from '../../src/utils/mtls_utils.js';

const DEFAULT_TEMPLATE = '{location}-integrations.googleapis.com';
const MTLS_TEMPLATE = '{location}-integrations.mtls.googleapis.com';

function endpoint(): string {
  return getApiEndpoint('us-central1', DEFAULT_TEMPLATE, MTLS_TEMPLATE);
}

describe('getApiEndpoint', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns the default host when neither variable is set', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(endpoint()).toBe('us-central1-integrations.googleapis.com');
  });

  it('returns the mTLS host when the setting is always', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(endpoint()).toBe('us-central1-integrations.mtls.googleapis.com');
  });

  it('reads the setting case insensitively', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'ALWAYS');

    expect(endpoint()).toBe('us-central1-integrations.mtls.googleapis.com');
  });

  it('returns the default host when the setting is never', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(endpoint()).toBe('us-central1-integrations.googleapis.com');
  });

  it('returns the mTLS host for auto with a client certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'TRUE');

    expect(endpoint()).toBe('us-central1-integrations.mtls.googleapis.com');
  });

  it('returns the default host for auto without a client certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');

    expect(endpoint()).toBe('us-central1-integrations.googleapis.com');
  });

  it('treats an unrecognised setting as auto', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'sometimes');
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(endpoint()).toBe('us-central1-integrations.mtls.googleapis.com');
  });

  it('substitutes the location into the template it returns', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');

    expect(
      getApiEndpoint('europe-west1', DEFAULT_TEMPLATE, MTLS_TEMPLATE),
    ).toBe('europe-west1-integrations.googleapis.com');
  });
});
