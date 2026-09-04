/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it} from 'vitest';

import {getApiEndpoint} from '../../src/utils/mtls_utils.js';

const DEFAULT_TEMPLATE = '{location}-discoveryengine.googleapis.com';
const MTLS_TEMPLATE = '{location}-discoveryengine.mtls.googleapis.com';

/** Sets an environment variable, or removes it when the value is undefined. */
function setEnv(name: string, value?: string): void {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

describe('getApiEndpoint', () => {
  const original = {
    endpoint: process.env['GOOGLE_API_USE_MTLS_ENDPOINT'],
    certificate: process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'],
  };

  afterEach(() => {
    setEnv('GOOGLE_API_USE_MTLS_ENDPOINT', original.endpoint);
    setEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', original.certificate);
  });

  it('returns the default host when the environment asks for nothing', () => {
    setEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);
    setEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(getApiEndpoint('eu', DEFAULT_TEMPLATE, MTLS_TEMPLATE)).toBe(
      'eu-discoveryengine.googleapis.com',
    );
  });

  it('returns the mutual-TLS host when the setting is always', () => {
    setEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'ALWAYS');
    setEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');

    expect(getApiEndpoint('eu', DEFAULT_TEMPLATE, MTLS_TEMPLATE)).toBe(
      'eu-discoveryengine.mtls.googleapis.com',
    );
  });

  it('returns the default host when the setting is never', () => {
    setEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    setEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(getApiEndpoint('eu', DEFAULT_TEMPLATE, MTLS_TEMPLATE)).toBe(
      'eu-discoveryengine.googleapis.com',
    );
  });

  it('follows the client certificate variable under auto', () => {
    setEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    setEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'TRUE');

    expect(getApiEndpoint('us', DEFAULT_TEMPLATE, MTLS_TEMPLATE)).toBe(
      'us-discoveryengine.mtls.googleapis.com',
    );

    setEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');

    expect(getApiEndpoint('us', DEFAULT_TEMPLATE, MTLS_TEMPLATE)).toBe(
      'us-discoveryengine.googleapis.com',
    );
  });

  it('reads an unrecognised setting as auto', () => {
    setEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'sometimes');
    setEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');

    expect(getApiEndpoint('us', DEFAULT_TEMPLATE, MTLS_TEMPLATE)).toBe(
      'us-discoveryengine.mtls.googleapis.com',
    );
  });

  it('substitutes a location containing replacement patterns verbatim', () => {
    setEnv('GOOGLE_API_USE_MTLS_ENDPOINT', undefined);
    setEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', undefined);

    expect(getApiEndpoint("$&$`$'", DEFAULT_TEMPLATE, MTLS_TEMPLATE)).toBe(
      "$&$`$'-discoveryengine.googleapis.com",
    );
  });

  it('leaves a template with no placeholder unchanged', () => {
    setEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');

    expect(
      getApiEndpoint(
        'global',
        'discoveryengine.googleapis.com',
        'discoveryengine.mtls.googleapis.com',
      ),
    ).toBe('discoveryengine.mtls.googleapis.com');
  });
});
