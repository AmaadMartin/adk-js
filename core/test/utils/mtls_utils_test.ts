/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {existsSync, readFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  effectiveGoogleapisEndpoint,
  hasDefaultClientCertSource,
  isNonMtlsGoogleapisEndpoint,
  MtlsEndpoint,
  mtlsEndpointSetting,
  shouldUseMtlsEndpoint,
  useClientCertEffective,
} from '../../src/utils/mtls_utils.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
}));

const USE_CLIENT_CERT = 'GOOGLE_API_USE_CLIENT_CERTIFICATE';
const USE_MTLS_ENDPOINT = 'GOOGLE_API_USE_MTLS_ENDPOINT';
const CERTIFICATE_CONFIG = 'GOOGLE_API_CERTIFICATE_CONFIG';

const CONTEXT_AWARE_PATH = join(
  homedir(),
  '.secureConnect',
  'context_aware_metadata.json',
);
const GCLOUD_CERT_PATH = join(
  homedir(),
  '.config',
  'gcloud',
  'certificate_config.json',
);

/** Makes `existsSync` report only the given paths as present. */
function onlyTheseFilesExist(...present: string[]): void {
  vi.mocked(existsSync).mockImplementation((path) =>
    present.includes(String(path)),
  );
}

describe('mtls_utils', () => {
  const originalEnv = {...process.env};

  beforeEach(() => {
    vi.mocked(existsSync).mockReturnValue(false);
    vi.mocked(readFileSync).mockReturnValue('');
    delete process.env[USE_CLIENT_CERT];
    delete process.env[USE_MTLS_ENDPOINT];
    delete process.env[CERTIFICATE_CONFIG];
  });

  afterEach(() => {
    vi.mocked(existsSync).mockReset();
    vi.mocked(readFileSync).mockReset();
    process.env = {...originalEnv};
  });

  describe('mtlsEndpointSetting', () => {
    it('reads always and never', () => {
      process.env[USE_MTLS_ENDPOINT] = 'always';
      expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.ALWAYS);

      process.env[USE_MTLS_ENDPOINT] = 'never';
      expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.NEVER);
    });

    it('reads the variable case insensitively', () => {
      process.env[USE_MTLS_ENDPOINT] = 'ALWAYS';
      expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.ALWAYS);
    });

    it('falls back to auto for an unset variable', () => {
      expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.AUTO);
    });

    it('falls back to auto for an unrecognised variable', () => {
      process.env[USE_MTLS_ENDPOINT] = 'sometimes';
      expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.AUTO);
    });
  });

  describe('hasDefaultClientCertSource', () => {
    it('finds the context-aware metadata', () => {
      onlyTheseFilesExist(CONTEXT_AWARE_PATH);
      expect(hasDefaultClientCertSource()).toBe(true);
    });

    it('finds the gcloud certificate configuration', () => {
      onlyTheseFilesExist(GCLOUD_CERT_PATH);
      expect(hasDefaultClientCertSource()).toBe(true);
    });

    it('finds the configuration the environment names', () => {
      process.env[CERTIFICATE_CONFIG] = '/tmp/cert-config.json';
      onlyTheseFilesExist('/tmp/cert-config.json');
      expect(hasDefaultClientCertSource()).toBe(true);
    });

    it('reports false when no source is present', () => {
      onlyTheseFilesExist();
      expect(hasDefaultClientCertSource()).toBe(false);
    });

    it('reports false when the named configuration is absent', () => {
      process.env[CERTIFICATE_CONFIG] = '/tmp/missing.json';
      onlyTheseFilesExist();
      expect(hasDefaultClientCertSource()).toBe(false);
    });
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

    it('reports false for an unrecognised value', () => {
      process.env[USE_CLIENT_CERT] = 'yes';
      expect(useClientCertEffective()).toBe(false);
    });

    it('reports false when the variable is unset and no config is named', () => {
      expect(useClientCertEffective()).toBe(false);
    });

    it('reads a workload certificate config when the variable is unset', () => {
      process.env[CERTIFICATE_CONFIG] = '/tmp/cert-config.json';
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({cert_configs: {workload: {cert_path: '/tmp/c.pem'}}}),
      );
      expect(useClientCertEffective()).toBe(true);
    });

    it('treats an empty variable as unset', () => {
      process.env[USE_CLIENT_CERT] = '';
      process.env[CERTIFICATE_CONFIG] = '/tmp/cert-config.json';
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({cert_configs: {workload: {}}}),
      );
      expect(useClientCertEffective()).toBe(true);
    });

    it('reports false for a config that declares no workload', () => {
      process.env[CERTIFICATE_CONFIG] = '/tmp/cert-config.json';
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({cert_configs: {other: {}}}),
      );
      expect(useClientCertEffective()).toBe(false);
    });

    it('reports false for a config with no cert_configs key', () => {
      process.env[CERTIFICATE_CONFIG] = '/tmp/cert-config.json';
      vi.mocked(readFileSync).mockReturnValue(JSON.stringify({version: 1}));
      expect(useClientCertEffective()).toBe(false);
    });

    it('reports false for a config whose cert_configs is not an object', () => {
      process.env[CERTIFICATE_CONFIG] = '/tmp/cert-config.json';
      vi.mocked(readFileSync).mockReturnValue(
        JSON.stringify({cert_configs: 'workload'}),
      );
      expect(useClientCertEffective()).toBe(false);
    });

    it('reports false for a config that is not a JSON object', () => {
      process.env[CERTIFICATE_CONFIG] = '/tmp/cert-config.json';
      vi.mocked(readFileSync).mockReturnValue('null');
      expect(useClientCertEffective()).toBe(false);
    });

    it('reports false for a malformed config', () => {
      process.env[CERTIFICATE_CONFIG] = '/tmp/cert-config.json';
      vi.mocked(readFileSync).mockReturnValue('{not json');
      expect(useClientCertEffective()).toBe(false);
    });

    it('reports false when the config cannot be read', () => {
      process.env[CERTIFICATE_CONFIG] = '/tmp/missing.json';
      vi.mocked(readFileSync).mockImplementation(() => {
        throw new Error('ENOENT');
      });
      expect(useClientCertEffective()).toBe(false);
    });
  });

  describe('shouldUseMtlsEndpoint', () => {
    it('reports true for always, whatever the certificate situation', () => {
      process.env[USE_MTLS_ENDPOINT] = 'always';
      expect(shouldUseMtlsEndpoint(false)).toBe(true);
      expect(shouldUseMtlsEndpoint(true)).toBe(true);
    });

    it('reports false for never, whatever the certificate situation', () => {
      process.env[USE_MTLS_ENDPOINT] = 'never';
      expect(shouldUseMtlsEndpoint(true)).toBe(false);
      expect(shouldUseMtlsEndpoint(false)).toBe(false);
    });

    it('follows the certificate for auto', () => {
      process.env[USE_MTLS_ENDPOINT] = 'auto';
      expect(shouldUseMtlsEndpoint(true)).toBe(true);
      expect(shouldUseMtlsEndpoint(false)).toBe(false);
    });

    it('treats an unset variable as auto', () => {
      expect(shouldUseMtlsEndpoint(true)).toBe(true);
      expect(shouldUseMtlsEndpoint(false)).toBe(false);
    });
  });

  describe('isNonMtlsGoogleapisEndpoint', () => {
    it('matches a googleapis.com host', () => {
      expect(isNonMtlsGoogleapisEndpoint('https://x.googleapis.com/v1')).toBe(
        true,
      );
    });

    it('does not match a host that is already mTLS', () => {
      expect(
        isNonMtlsGoogleapisEndpoint('https://x.mtls.googleapis.com/v1'),
      ).toBe(false);
    });

    it('does not match a non-Google host', () => {
      expect(
        isNonMtlsGoogleapisEndpoint('https://example.com/googleapis/v1'),
      ).toBe(false);
    });

    it('does not match a string that is not a URL', () => {
      expect(isNonMtlsGoogleapisEndpoint('not-a-url')).toBe(false);
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

    it('adds no path to a bare host', () => {
      expect(effectiveGoogleapisEndpoint('https://x.googleapis.com')).toBe(
        'https://x.mtls.googleapis.com',
      );
    });

    it('keeps a root path the caller wrote', () => {
      expect(effectiveGoogleapisEndpoint('https://x.googleapis.com/')).toBe(
        'https://x.mtls.googleapis.com/',
      );
    });
  });
});
