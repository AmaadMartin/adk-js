/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  GCP_AUTH_PROVIDER_SCHEME_TYPE,
  GcpAuthProviderScheme,
  isGcpAuthProviderScheme,
} from '../../../src/integrations/agent_identity/gcp_auth_provider_scheme.js';

function scheme(name: string): GcpAuthProviderScheme {
  return {type: GCP_AUTH_PROVIDER_SCHEME_TYPE, name};
}

describe('isGcpAuthProviderScheme', () => {
  it('accepts a well-formed scheme', () => {
    expect(isGcpAuthProviderScheme(scheme('some-provider'))).toBe(true);
  });

  it.each([
    ['undefined', undefined],
    ['null', null],
    ['a string', 'gcpAuthProviderScheme'],
    ['another scheme type', {type: 'apiKey', name: 'testKey'}],
    ['a scheme with no name', {type: GCP_AUTH_PROVIDER_SCHEME_TYPE}],
    [
      'a scheme whose name is not a string',
      {type: GCP_AUTH_PROVIDER_SCHEME_TYPE, name: 42},
    ],
    ['an object with no type', {name: 'some-provider'}],
  ])('rejects %s', (_label, value) => {
    expect(isGcpAuthProviderScheme(value)).toBe(false);
  });
});
