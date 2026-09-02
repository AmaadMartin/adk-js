/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {isAuthConfig} from '../../src/auth/auth_tool.js';

describe('isAuthConfig', () => {
  it('accepts an object carrying both required properties', () => {
    expect(
      isAuthConfig({
        authScheme: {type: 'apiKey', name: 'X-API-Key', in: 'header'},
        credentialKey: 'key',
      }),
    ).toBe(true);
  });

  it('rejects an object missing authScheme', () => {
    expect(isAuthConfig({credentialKey: 'key'})).toBe(false);
  });

  it('rejects an object missing credentialKey', () => {
    expect(isAuthConfig({authScheme: {type: 'apiKey'}})).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(isAuthConfig('auth_config')).toBe(false);
    expect(isAuthConfig(7)).toBe(false);
    expect(isAuthConfig(undefined)).toBe(false);
  });

  it('rejects null', () => {
    expect(isAuthConfig(null)).toBe(false);
  });
});
