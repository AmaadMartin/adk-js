/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFile} from 'node:fs/promises';
import {platform} from 'node:os';
import {join} from 'node:path';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  MockInstance,
  vi,
} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {
  createMtlsDispatcher,
  effectiveGoogleapisEndpoint,
  MtlsEndpointSetting,
} from '../../src/utils/mtls_utils.js';

const {agentCtor} = vi.hoisted(() => ({agentCtor: vi.fn()}));

vi.mock('undici', () => ({Agent: agentCtor}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
}));

vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  platform: vi.fn(),
}));

/** Environment variables this module reads, cleared before every test. */
const MTLS_ENV_VARS = [
  'GOOGLE_API_USE_CLIENT_CERTIFICATE',
  'GOOGLE_API_USE_MTLS_ENDPOINT',
  'GOOGLE_API_CERTIFICATE_CONFIG',
  'CLOUDSDK_CONFIG',
  'APPDATA',
  'HOME',
];

const CERT_BYTES = Buffer.from('-----BEGIN CERTIFICATE----- cert-material');
const KEY_BYTES = Buffer.from('-----BEGIN PRIVATE KEY----- key-material');
const CERT_PATH = '/certs/workload.pem';
const KEY_PATH = '/certs/workload.key';
const CONFIG_PATH = '/certs/certificate_config.json';

const originalEnv = process.env;
let warnSpy: MockInstance<(...args: unknown[]) => void>;

/**
 * Makes `readFile` serve a valid certificate config plus its PEM files, so
 * only the config path under test varies between cases.
 */
function mockCertificateFiles(configPath: string) {
  const config = JSON.stringify({
    version: 1,
    cert_configs: {workload: {cert_path: CERT_PATH, key_path: KEY_PATH}},
  });
  vi.mocked(readFile).mockImplementation(async (file) => {
    switch (file) {
      case CERT_PATH:
        return CERT_BYTES;
      case KEY_PATH:
        return KEY_BYTES;
      case configPath:
        return config;
      default:
        throw new Error(`ENOENT: no such file or directory, open '${file}'`);
    }
  });
}

/** Makes `readFile` return `config` for the configured config file only. */
function mockCertificateConfigContent(config: string) {
  vi.mocked(readFile).mockImplementation(async (file) => {
    if (file === CONFIG_PATH) {
      return config;
    }
    throw new Error(`ENOENT: no such file or directory, open '${file}'`);
  });
}

describe('mtls_utils', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(platform).mockReturnValue('linux');
    warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const env = {...originalEnv};
    for (const name of MTLS_ENV_VARS) {
      delete env[name];
    }
    process.env = env;
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('keeps the setting values adk-python writes on the wire', () => {
    expect(Object.values(MtlsEndpointSetting)).toEqual([
      'auto',
      'always',
      'never',
    ]);
  });

  describe('effectiveGoogleapisEndpoint', () => {
    it.each([
      [
        'https://oauth2.googleapis.com/token',
        'https://oauth2.mtls.googleapis.com/token',
      ],
      [
        'https://openidconnect.googleapis.com/v1/userinfo',
        'https://openidconnect.mtls.googleapis.com/v1/userinfo',
      ],
      [
        'https://iam.googleapis.com/v1/token?foo=bar',
        'https://iam.mtls.googleapis.com/v1/token?foo=bar',
      ],
      [
        'https://iam.googleapis.com:8443/v1/x#frag',
        'https://iam.mtls.googleapis.com:8443/v1/x#frag',
      ],
    ])('rewrites %s to %s', (url, expected) => {
      expect(effectiveGoogleapisEndpoint(url, true)).toBe(expected);
    });

    it.each([
      // Already-mTLS hosts are left alone.
      'https://oauth2.mtls.googleapis.com/token',
      // Non-Google providers are never rewritten.
      'https://example.com/token',
      'https://accounts.google.com/o/oauth2/v2/auth',
      // A lookalike host must not match on a substring.
      'https://evil-googleapis.com.attacker.test/x',
      // The bare apex is not a `*.googleapis.com` host.
      'https://googleapis.com/token',
      // Unparseable input is passed through untouched.
      '',
      'not a url',
    ])('leaves %s unchanged', (url) => {
      expect(effectiveGoogleapisEndpoint(url, true)).toBe(url);
    });

    it('rewrites for "always" even without a certificate', () => {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'always';
      expect(
        effectiveGoogleapisEndpoint(
          'https://oauth2.googleapis.com/token',
          false,
        ),
      ).toBe('https://oauth2.mtls.googleapis.com/token');
    });

    it('does not rewrite for "never" even with a certificate', () => {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'never';
      expect(
        effectiveGoogleapisEndpoint(
          'https://oauth2.googleapis.com/token',
          true,
        ),
      ).toBe('https://oauth2.googleapis.com/token');
    });

    it('does not rewrite for "auto" without a certificate', () => {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'auto';
      expect(
        effectiveGoogleapisEndpoint(
          'https://oauth2.googleapis.com/token',
          false,
        ),
      ).toBe('https://oauth2.googleapis.com/token');
    });

    it('treats an unrecognised setting as "auto"', () => {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'invalid';
      expect(
        effectiveGoogleapisEndpoint(
          'https://oauth2.googleapis.com/token',
          true,
        ),
      ).toBe('https://oauth2.mtls.googleapis.com/token');
      expect(
        effectiveGoogleapisEndpoint(
          'https://oauth2.googleapis.com/token',
          false,
        ),
      ).toBe('https://oauth2.googleapis.com/token');
    });

    it('matches the setting case-insensitively', () => {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'ALWAYS';
      expect(
        effectiveGoogleapisEndpoint(
          'https://oauth2.googleapis.com/token',
          false,
        ),
      ).toBe('https://oauth2.mtls.googleapis.com/token');
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'Never';
      expect(
        effectiveGoogleapisEndpoint(
          'https://oauth2.googleapis.com/token',
          true,
        ),
      ).toBe('https://oauth2.googleapis.com/token');
    });
  });

  describe('createMtlsDispatcher', () => {
    it.each(['true', '1', 'TRUE'])(
      'loads a certificate when GOOGLE_API_USE_CLIENT_CERTIFICATE is "%s"',
      async (value) => {
        process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = value;
        process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = CONFIG_PATH;
        mockCertificateFiles(CONFIG_PATH);

        await expect(createMtlsDispatcher()).resolves.toBeDefined();
      },
    );

    it.each(['false', '0', ''])(
      'returns undefined without touching the filesystem when GOOGLE_API_USE_CLIENT_CERTIFICATE is "%s"',
      async (value) => {
        process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = value;

        await expect(createMtlsDispatcher()).resolves.toBeUndefined();

        expect(readFile).not.toHaveBeenCalled();
        expect(warnSpy).not.toHaveBeenCalled();
      },
    );

    it('returns undefined without touching the filesystem when the variable is unset', async () => {
      await expect(createMtlsDispatcher()).resolves.toBeUndefined();

      expect(readFile).not.toHaveBeenCalled();
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('builds a dispatcher from the GOOGLE_API_CERTIFICATE_CONFIG path', async () => {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = CONFIG_PATH;
      mockCertificateFiles(CONFIG_PATH);

      const dispatcher = await createMtlsDispatcher();

      expect(readFile).toHaveBeenCalledWith(CONFIG_PATH, 'utf8');
      expect(agentCtor).toHaveBeenCalledWith({
        connect: {cert: CERT_BYTES, key: KEY_BYTES},
      });
      expect(dispatcher).toBe(agentCtor.mock.instances[0]);
      expect(warnSpy).not.toHaveBeenCalled();
    });

    it('derives the config path from CLOUDSDK_CONFIG', async () => {
      const expectedPath = join(
        '/opt/gcloud-config',
        'certificate_config.json',
      );
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      process.env['CLOUDSDK_CONFIG'] = '/opt/gcloud-config';
      mockCertificateFiles(expectedPath);

      await expect(createMtlsDispatcher()).resolves.toBeDefined();

      expect(readFile).toHaveBeenCalledWith(expectedPath, 'utf8');
    });

    it('falls back to the HOME gcloud directory on posix', async () => {
      const expectedPath = join(
        '/home/user',
        '.config',
        'gcloud',
        'certificate_config.json',
      );
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      process.env['HOME'] = '/home/user';
      mockCertificateFiles(expectedPath);

      await expect(createMtlsDispatcher()).resolves.toBeDefined();

      expect(readFile).toHaveBeenCalledWith(expectedPath, 'utf8');
    });

    it('treats an unset HOME as an empty prefix on posix', async () => {
      const expectedPath = join('.config', 'gcloud', 'certificate_config.json');
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      mockCertificateFiles(expectedPath);

      await expect(createMtlsDispatcher()).resolves.toBeDefined();

      expect(readFile).toHaveBeenCalledWith(expectedPath, 'utf8');
    });

    it('uses the APPDATA gcloud directory on windows', async () => {
      const expectedPath = join(
        'C:\\Users\\u\\AppData\\Roaming',
        'gcloud',
        'certificate_config.json',
      );
      vi.mocked(platform).mockReturnValue('win32');
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      process.env['APPDATA'] = 'C:\\Users\\u\\AppData\\Roaming';
      mockCertificateFiles(expectedPath);

      await expect(createMtlsDispatcher()).resolves.toBeDefined();

      expect(readFile).toHaveBeenCalledWith(expectedPath, 'utf8');
    });

    it('treats an unset APPDATA as an empty prefix on windows', async () => {
      const expectedPath = join('gcloud', 'certificate_config.json');
      vi.mocked(platform).mockReturnValue('win32');
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      mockCertificateFiles(expectedPath);

      await expect(createMtlsDispatcher()).resolves.toBeDefined();

      expect(readFile).toHaveBeenCalledWith(expectedPath, 'utf8');
    });

    it('warns and returns undefined when the config file is missing', async () => {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = CONFIG_PATH;
      vi.mocked(readFile).mockRejectedValue(
        new Error(`ENOENT: no such file or directory, open '${CONFIG_PATH}'`),
      );

      await expect(createMtlsDispatcher()).resolves.toBeUndefined();

      expect(agentCtor).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain(CONFIG_PATH);
    });

    it('warns and returns undefined when the config file is not valid JSON', async () => {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = CONFIG_PATH;
      mockCertificateConfigContent('{not json');

      await expect(createMtlsDispatcher()).resolves.toBeUndefined();

      expect(agentCtor).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['the workload entry is missing', '{"cert_configs": {}}'],
      [
        'cert_path is missing',
        JSON.stringify({
          cert_configs: {workload: {key_path: KEY_PATH}},
        }),
      ],
      [
        'key_path is missing',
        JSON.stringify({
          cert_configs: {workload: {cert_path: CERT_PATH}},
        }),
      ],
    ])('warns and returns undefined when %s', async (_name, config) => {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = CONFIG_PATH;
      mockCertificateConfigContent(config);

      await expect(createMtlsDispatcher()).resolves.toBeUndefined();

      expect(agentCtor).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('cert_configs.workload');
    });

    it('warns and returns undefined when a PEM file cannot be read', async () => {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = CONFIG_PATH;
      // Only the config file resolves; reading the PEM files rejects.
      mockCertificateConfigContent(
        JSON.stringify({
          cert_configs: {workload: {cert_path: CERT_PATH, key_path: KEY_PATH}},
        }),
      );

      await expect(createMtlsDispatcher()).resolves.toBeUndefined();

      expect(agentCtor).not.toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalledTimes(1);
    });

    it('warns and returns undefined when the failure is not an Error', async () => {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = CONFIG_PATH;
      vi.mocked(readFile).mockRejectedValue('disk offline');

      await expect(createMtlsDispatcher()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      expect(warnSpy.mock.calls[0][0]).toContain('disk offline');
    });

    it('never logs certificate or key material', async () => {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = CONFIG_PATH;
      mockCertificateFiles(CONFIG_PATH);
      agentCtor.mockImplementation(() => {
        throw new Error('dispatcher construction failed');
      });

      await expect(createMtlsDispatcher()).resolves.toBeUndefined();

      expect(warnSpy).toHaveBeenCalledTimes(1);
      const message = String(warnSpy.mock.calls[0][0]);
      expect(message).not.toContain('cert-material');
      expect(message).not.toContain('key-material');
      expect(message).toContain('dispatcher construction failed');
    });
  });
});
