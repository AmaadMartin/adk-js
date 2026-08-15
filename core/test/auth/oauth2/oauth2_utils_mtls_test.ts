/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFile} from 'node:fs/promises';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {fetchOAuth2Tokens} from '../../../src/auth/oauth2/oauth2_utils.js';
import {logger} from '../../../src/utils/logger.js';

const {agentCtor} = vi.hoisted(() => ({agentCtor: vi.fn()}));

vi.mock('undici', () => ({Agent: agentCtor}));

vi.mock('node:fs/promises', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs/promises')>()),
  readFile: vi.fn(),
}));

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const MTLS_TOKEN_ENDPOINT = 'https://oauth2.mtls.googleapis.com/token';
const CONFIG_PATH = '/certs/certificate_config.json';
const CERT_PATH = '/certs/workload.pem';
const KEY_PATH = '/certs/workload.key';

const originalEnv = process.env;

/** Serves a workload certificate config and the PEM files it names. */
function mockCertificateFiles() {
  const config = JSON.stringify({
    cert_configs: {workload: {cert_path: CERT_PATH, key_path: KEY_PATH}},
  });
  vi.mocked(readFile).mockImplementation(async (file) => {
    switch (file) {
      case CERT_PATH:
        return Buffer.from('cert-material');
      case KEY_PATH:
        return Buffer.from('key-material');
      case CONFIG_PATH:
        return config;
      default:
        throw new Error(`ENOENT: no such file or directory, open '${file}'`);
    }
  });
}

/** Turns the client-certificate gate on, pointing it at a loadable config. */
function enableClientCertificate() {
  process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
  process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = CONFIG_PATH;
  mockCertificateFiles();
}

/** The init `fetch` was called with on its first call. */
function fetchInit(): Record<string, unknown> {
  const init = vi.mocked(fetch).mock.calls[0][1];
  if (!init) {
    expect.fail('fetch was called without an init argument');
  }
  return init as Record<string, unknown>;
}

describe('fetchOAuth2Tokens over mTLS', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    process.env = {...originalEnv};
    for (const name of [
      'GOOGLE_API_USE_CLIENT_CERTIFICATE',
      'GOOGLE_API_USE_MTLS_ENDPOINT',
      'GOOGLE_API_CERTIFICATE_CONFIG',
    ]) {
      delete process.env[name];
    }
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({access_token: 'acc-123', expires_in: 3600}),
      } as Response),
    );
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('posts to the mTLS endpoint with the certificate attached', async () => {
    enableClientCertificate();
    const body = new URLSearchParams({grant_type: 'refresh_token'});

    const token = await fetchOAuth2Tokens(TOKEN_ENDPOINT, body);

    expect(fetch).toHaveBeenCalledWith(MTLS_TOKEN_ENDPOINT, expect.anything());
    expect(fetchInit()['dispatcher']).toBe(agentCtor.mock.instances[0]);
    expect(agentCtor).toHaveBeenCalledWith({
      connect: {
        cert: Buffer.from('cert-material'),
        key: Buffer.from('key-material'),
      },
    });
    // The response handling is shared with the plain path.
    expect(token.accessToken).toBe('acc-123');
  });

  it('keeps the request byte-identical when the gate is off', async () => {
    await fetchOAuth2Tokens(TOKEN_ENDPOINT, new URLSearchParams());

    expect(fetch).toHaveBeenCalledWith(TOKEN_ENDPOINT, expect.anything());
    expect(fetchInit()).not.toHaveProperty('dispatcher');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('posts to the plain endpoint when no certificate can be loaded', async () => {
    process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
    process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = CONFIG_PATH;
    vi.mocked(readFile).mockRejectedValue(new Error('ENOENT'));

    await fetchOAuth2Tokens(TOKEN_ENDPOINT, new URLSearchParams());

    expect(fetch).toHaveBeenCalledWith(TOKEN_ENDPOINT, expect.anything());
    expect(fetchInit()).not.toHaveProperty('dispatcher');
  });

  it('leaves a non-Google token endpoint alone', async () => {
    enableClientCertificate();

    await fetchOAuth2Tokens('https://example.com/token', new URLSearchParams());

    expect(fetch).toHaveBeenCalledWith(
      'https://example.com/token',
      expect.anything(),
    );
    expect(fetchInit()).not.toHaveProperty('dispatcher');
  });

  it('leaves the endpoint alone when the setting is "never"', async () => {
    enableClientCertificate();
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'never';

    await fetchOAuth2Tokens(TOKEN_ENDPOINT, new URLSearchParams());

    expect(fetch).toHaveBeenCalledWith(TOKEN_ENDPOINT, expect.anything());
    expect(fetchInit()).not.toHaveProperty('dispatcher');
  });

  it('applies the SSRF guard to the rewritten endpoint', async () => {
    enableClientCertificate();

    await expect(
      fetchOAuth2Tokens(
        'http://oauth2.googleapis.com/token',
        new URLSearchParams(),
      ),
    ).rejects.toThrow(
      "SSRF protection: OAuth2 token endpoint 'http://oauth2.mtls.googleapis.com/token' is not allowed.",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it('surfaces a failed mTLS token request instead of retrying without it', async () => {
    enableClientCertificate();
    vi.mocked(fetch).mockResolvedValue({ok: false, status: 502} as Response);

    await expect(
      fetchOAuth2Tokens(TOKEN_ENDPOINT, new URLSearchParams()),
    ).rejects.toThrow('Token request failed with status 502');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
