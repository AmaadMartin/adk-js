/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it} from 'vitest';
import {
  effectiveGoogleapisEndpoint,
  shouldUseMtlsEndpoint,
  useClientCertEffective,
} from '../../src/utils/mtls_utils.js';

const USE_CLIENT_CERT = 'GOOGLE_API_USE_CLIENT_CERTIFICATE';
const USE_MTLS_ENDPOINT = 'GOOGLE_API_USE_MTLS_ENDPOINT';

/** Sets an environment variable, or removes it when the value is undefined. */
function setEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

describe('mtls_utils', () => {
  const originalClientCert = process.env[USE_CLIENT_CERT];
  const originalMtlsEndpoint = process.env[USE_MTLS_ENDPOINT];

  afterEach(() => {
    setEnv(USE_CLIENT_CERT, originalClientCert);
    setEnv(USE_MTLS_ENDPOINT, originalMtlsEndpoint);
  });

  describe('useClientCertEffective', () => {
    it('reports true when the variable is true', () => {
      process.env[USE_CLIENT_CERT] = 'true';
      expect(useClientCertEffective()).toBe(true);
    });

    it('reads the variable case insensitively', () => {
      process.env[USE_CLIENT_CERT] = 'TRUE';
      expect(useClientCertEffective()).toBe(true);
    });

    it('reports false when the variable is false', () => {
      process.env[USE_CLIENT_CERT] = 'false';
      expect(useClientCertEffective()).toBe(false);
    });

    it('reports false when the variable is unset', () => {
      delete process.env[USE_CLIENT_CERT];
      expect(useClientCertEffective()).toBe(false);
    });
  });

  describe('shouldUseMtlsEndpoint', () => {
    it('reports true for always, whatever the certificate setting', () => {
      process.env[USE_MTLS_ENDPOINT] = 'always';
      process.env[USE_CLIENT_CERT] = 'false';
      expect(shouldUseMtlsEndpoint()).toBe(true);
    });

    it('reports false for never, whatever the certificate setting', () => {
      process.env[USE_MTLS_ENDPOINT] = 'never';
      process.env[USE_CLIENT_CERT] = 'true';
      expect(shouldUseMtlsEndpoint()).toBe(false);
    });

    it('defers to the certificate setting for auto', () => {
      process.env[USE_MTLS_ENDPOINT] = 'auto';
      process.env[USE_CLIENT_CERT] = 'true';
      expect(shouldUseMtlsEndpoint()).toBe(true);

      process.env[USE_CLIENT_CERT] = 'false';
      expect(shouldUseMtlsEndpoint()).toBe(false);
    });

    it('treats an unset variable as auto', () => {
      delete process.env[USE_MTLS_ENDPOINT];
      process.env[USE_CLIENT_CERT] = 'true';
      expect(shouldUseMtlsEndpoint()).toBe(true);
    });

    it('treats an unrecognised variable as auto', () => {
      process.env[USE_MTLS_ENDPOINT] = 'sometimes';
      process.env[USE_CLIENT_CERT] = 'true';
      expect(shouldUseMtlsEndpoint()).toBe(true);
    });

    it('reads the variable case insensitively', () => {
      process.env[USE_MTLS_ENDPOINT] = 'ALWAYS';
      process.env[USE_CLIENT_CERT] = 'false';
      expect(shouldUseMtlsEndpoint()).toBe(true);
    });
  });

  describe('effectiveGoogleapisEndpoint', () => {
    it('rewrites a googleapis.com host to its mTLS variant', () => {
      expect(effectiveGoogleapisEndpoint('https://x.googleapis.com/v1')).toBe(
        'https://x.mtls.googleapis.com/v1',
      );
    });

    it('leaves a host that is already mTLS alone', () => {
      const url = 'https://x.mtls.googleapis.com/v1';
      expect(effectiveGoogleapisEndpoint(url)).toBe(url);
    });

    it('leaves a non-Google host alone', () => {
      const url = 'https://example.com/googleapis/v1';
      expect(effectiveGoogleapisEndpoint(url)).toBe(url);
    });

    it('leaves a string that is not a URL alone', () => {
      expect(effectiveGoogleapisEndpoint('not-a-url')).toBe('not-a-url');
    });

    it('preserves the scheme, port, path, query and fragment', () => {
      expect(
        effectiveGoogleapisEndpoint(
          'http://x.googleapis.com:8443/v1/models?alt=json#frag',
        ),
      ).toBe('http://x.mtls.googleapis.com:8443/v1/models?alt=json#frag');
    });

    it('returns the URL unchanged when the endpoint setting is never', () => {
      process.env[USE_MTLS_ENDPOINT] = 'never';
      const url = 'https://x.googleapis.com/v1';
      expect(effectiveGoogleapisEndpoint(url)).toBe(url);
    });
  });
});
