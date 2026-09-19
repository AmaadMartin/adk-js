/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the mutual-TLS helpers. They have no counterpart in adk-python,
 * which delegates all of this to `google.auth.transport.mtls`.
 *
 * The certificate discovery tests run a real certificate provider subprocess
 * against a real metadata file, so they exercise the SecureConnect contract end
 * to end. Only `node:https` is mocked, because presenting a client certificate
 * to a real server would require a certificate authority in the repository.
 */

import {EventEmitter} from 'node:events';
import {mkdir, mkdtemp, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';

/** A stand-in for the `IncomingMessage` that `https.request` reports. */
interface FakeResponse extends EventEmitter {
  statusCode?: number;
  setEncoding(encoding: string): void;
}

/** A stand-in for the `ClientRequest` that `https.request` returns. */
interface FakeRequest extends EventEmitter {
  end(): void;
  destroy(error?: Error): void;
}

const httpsMock = vi.hoisted(() => ({
  request:
    vi.fn<
      (
        url: string,
        options: Record<string, unknown>,
        callback: (response: FakeResponse) => void,
      ) => FakeRequest
    >(),
  Agent: vi.fn<(options: Record<string, unknown>) => object>(),
}));

vi.mock('node:https', () => httpsMock);

const {
  chooseApiEndpoint,
  clientCertsToPresent,
  getWithClientCert,
  useClientCertEffective,
} = await import('../../src/utils/mtls_utils.js');

const DEFAULT_ENDPOINT = 'https://cloudapiregistry.googleapis.com';
const MTLS_ENDPOINT = 'https://cloudapiregistry.mtls.googleapis.com';

const CERT_PEM =
  '-----BEGIN CERTIFICATE-----\nFAKE-CERT-BODY\n-----END CERTIFICATE-----';
const KEY_PEM =
  '-----BEGIN PRIVATE KEY-----\nFAKE-KEY-BODY\n-----END PRIVATE KEY-----';
const RSA_KEY_PEM =
  '-----BEGIN RSA PRIVATE KEY-----\nFAKE-RSA-BODY\n-----END RSA PRIVATE KEY-----';
const PASSPHRASE_PEM =
  '-----BEGIN PASSPHRASE-----\nhunter2\n-----END PASSPHRASE-----';

describe('useClientCertEffective', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('is false when GOOGLE_API_USE_CLIENT_CERTIFICATE is unset', () => {
    expect(useClientCertEffective()).toBe(false);
  });

  it('is true for "true", whatever the case', () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'TrUe');
    expect(useClientCertEffective()).toBe(true);
  });

  it('is false for any other value', () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'yes');
    expect(useClientCertEffective()).toBe(false);
  });
});

describe('chooseApiEndpoint', () => {
  const certs = {cert: CERT_PEM, key: KEY_PEM};

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('selects the mTLS endpoint under always, with no certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'ALWAYS');
    expect(chooseApiEndpoint(undefined, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      MTLS_ENDPOINT,
    );
  });

  it('selects the default endpoint under never, even with a certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'never');
    expect(chooseApiEndpoint(certs, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      DEFAULT_ENDPOINT,
    );
  });

  it('selects the mTLS endpoint under auto when a certificate is available', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    expect(chooseApiEndpoint(certs, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      MTLS_ENDPOINT,
    );
  });

  it('selects the default endpoint under auto with no certificate', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'auto');
    expect(chooseApiEndpoint(undefined, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      DEFAULT_ENDPOINT,
    );
  });

  it('reads an unset setting as auto', () => {
    expect(chooseApiEndpoint(certs, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      MTLS_ENDPOINT,
    );
    expect(chooseApiEndpoint(undefined, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      DEFAULT_ENDPOINT,
    );
  });

  it('reads an unrecognised setting as auto', () => {
    vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'nonsense');
    expect(chooseApiEndpoint(certs, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      MTLS_ENDPOINT,
    );
    expect(chooseApiEndpoint(undefined, DEFAULT_ENDPOINT, MTLS_ENDPOINT)).toBe(
      DEFAULT_ENDPOINT,
    );
  });
});

describe('clientCertsToPresent', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), 'adk-mtls-'));
    vi.stubEnv('HOME', home);
    vi.stubEnv('USERPROFILE', home);
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'true');
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(home, {recursive: true, force: true});
  });

  /** Writes the SecureConnect metadata file that names the provider command. */
  async function writeMetadata(contents: string): Promise<void> {
    const dir = join(home, '.secureConnect');
    await mkdir(dir, {recursive: true});
    await writeFile(join(dir, 'context_aware_metadata.json'), contents);
  }

  /** A provider command that prints `output` and exits successfully. */
  function printingCommand(output: string): string[] {
    return [
      process.execPath,
      '-e',
      `process.stdout.write(${JSON.stringify(output)})`,
    ];
  }

  /** The single argument of every `logger.warn` call, concatenated. */
  function warnings(): string {
    return vi.mocked(logger.warn).mock.calls.flat().join('\n');
  }

  it('reads nothing when no client certificate was asked for', async () => {
    vi.stubEnv('GOOGLE_API_USE_CLIENT_CERTIFICATE', 'false');
    await writeMetadata(
      JSON.stringify({
        cert_provider_command: printingCommand(`${CERT_PEM}\n${KEY_PEM}\n`),
      }),
    );

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(warnings()).toBe('');
  });

  it('returns undefined when there is no metadata file', async () => {
    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(warnings()).toContain('No SecureConnect metadata');
  });

  it('returns undefined when the metadata file is not JSON', async () => {
    await writeMetadata('not json at all');

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(warnings()).toContain('is not valid JSON');
  });

  it('returns undefined when the metadata names no provider command', async () => {
    await writeMetadata(JSON.stringify({other_field: 1}));

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(warnings()).toContain('names no cert_provider_command');
  });

  it('returns undefined when the provider command is not a list of strings', async () => {
    await writeMetadata(JSON.stringify({cert_provider_command: ['a', 7]}));

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(warnings()).toContain('names no cert_provider_command');
  });

  it('returns undefined when the provider command is an empty list', async () => {
    await writeMetadata(JSON.stringify({cert_provider_command: []}));

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(warnings()).toContain('names no cert_provider_command');
  });

  it('returns undefined when the provider command fails', async () => {
    await writeMetadata(
      JSON.stringify({
        cert_provider_command: [process.execPath, '-e', 'process.exit(3)'],
      }),
    );

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(warnings()).toContain('certificate provider command failed');
  });

  it('returns undefined when the provider prints no private key', async () => {
    await writeMetadata(
      JSON.stringify({cert_provider_command: printingCommand(CERT_PEM)}),
    );

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(warnings()).toContain('no certificate and key pair');
  });

  it('returns the certificate and key the provider prints', async () => {
    await writeMetadata(
      JSON.stringify({
        cert_provider_command: printingCommand(`${CERT_PEM}\n${KEY_PEM}\n`),
      }),
    );

    await expect(clientCertsToPresent()).resolves.toEqual({
      cert: CERT_PEM,
      key: KEY_PEM,
    });
  });

  it('accepts an algorithm-qualified private key block', async () => {
    await writeMetadata(
      JSON.stringify({
        cert_provider_command: printingCommand(`${CERT_PEM}\n${RSA_KEY_PEM}\n`),
      }),
    );

    await expect(clientCertsToPresent()).resolves.toEqual({
      cert: CERT_PEM,
      key: RSA_KEY_PEM,
    });
  });

  it('returns the passphrase when the provider prints one', async () => {
    await writeMetadata(
      JSON.stringify({
        cert_provider_command: printingCommand(
          `${CERT_PEM}\n${KEY_PEM}\n${PASSPHRASE_PEM}\n`,
        ),
      }),
    );

    await expect(clientCertsToPresent()).resolves.toEqual({
      cert: CERT_PEM,
      key: KEY_PEM,
      passphrase: 'hunter2',
    });
  });

  it('keeps key material out of the warning when the provider fails', async () => {
    // The provider prints the key and then fails, which is how a partial write
    // reaches the failure path with secret material already on stdout.
    await writeMetadata(
      JSON.stringify({
        cert_provider_command: [
          process.execPath,
          '-e',
          `process.stdout.write(${JSON.stringify(KEY_PEM)}); process.exit(1)`,
        ],
      }),
    );

    await expect(clientCertsToPresent()).resolves.toBeUndefined();
    expect(warnings()).not.toContain('PRIVATE KEY');
    expect(warnings()).not.toContain('FAKE-KEY-BODY');
  });
});

describe('getWithClientCert', () => {
  const certs = {cert: CERT_PEM, key: KEY_PEM, passphrase: 'hunter2'};

  /** A request whose `destroy` reports the error, as `ClientRequest` does. */
  function newFakeRequest(): FakeRequest {
    const request: FakeRequest = Object.assign(new EventEmitter(), {
      end: () => {},
      destroy: (error?: Error) => {
        request.emit('error', error);
      },
    });
    return request;
  }

  beforeEach(() => {
    httpsMock.request.mockReset();
    httpsMock.Agent.mockReset();
  });

  it('resolves the status and the joined response body', async () => {
    httpsMock.request.mockImplementation((_url, _options, callback) => {
      const response: FakeResponse = Object.assign(new EventEmitter(), {
        statusCode: 200,
        setEncoding: () => {},
      });
      queueMicrotask(() => {
        callback(response);
        response.emit('data', '{"mcpSer');
        response.emit('data', 'vers":[]}');
        response.emit('end');
      });
      return newFakeRequest();
    });

    await expect(
      getWithClientCert('https://example.googleapis.com/x', {}, certs, 1000),
    ).resolves.toEqual({status: 200, body: '{"mcpServers":[]}'});
  });

  it('reports status 0 when the response carries no status code', async () => {
    httpsMock.request.mockImplementation((_url, _options, callback) => {
      const response: FakeResponse = Object.assign(new EventEmitter(), {
        setEncoding: () => {},
      });
      queueMicrotask(() => {
        callback(response);
        response.emit('end');
      });
      return newFakeRequest();
    });

    await expect(
      getWithClientCert('https://example.googleapis.com/x', {}, certs, 1000),
    ).resolves.toEqual({status: 0, body: ''});
  });

  it('presents the certificate, key and passphrase, and the caller headers', async () => {
    httpsMock.request.mockImplementation((_url, _options, callback) => {
      const response: FakeResponse = Object.assign(new EventEmitter(), {
        statusCode: 204,
        setEncoding: () => {},
      });
      queueMicrotask(() => {
        callback(response);
        response.emit('end');
      });
      return newFakeRequest();
    });

    await getWithClientCert(
      'https://example.googleapis.com/x',
      {'Authorization': 'Bearer t'},
      certs,
      1234,
    );

    expect(httpsMock.Agent).toHaveBeenCalledWith({
      cert: CERT_PEM,
      key: KEY_PEM,
      passphrase: 'hunter2',
    });
    expect(httpsMock.request).toHaveBeenCalledWith(
      'https://example.googleapis.com/x',
      expect.objectContaining({
        method: 'GET',
        headers: {'Authorization': 'Bearer t'},
        timeout: 1234,
      }),
      expect.any(Function),
    );
  });

  it('rejects when the socket errors', async () => {
    httpsMock.request.mockImplementation(() => {
      const request = newFakeRequest();
      queueMicrotask(() => {
        request.emit('error', new Error('ECONNREFUSED'));
      });
      return request;
    });

    await expect(
      getWithClientCert('https://example.googleapis.com/x', {}, certs, 1000),
    ).rejects.toThrow('ECONNREFUSED');
  });

  it('destroys the request and rejects when it times out', async () => {
    httpsMock.request.mockImplementation(() => {
      const request = newFakeRequest();
      // node:https only emits the event on timeout; it leaves the socket open.
      queueMicrotask(() => {
        request.emit('timeout');
      });
      return request;
    });

    await expect(
      getWithClientCert('https://example.googleapis.com/x', {}, certs, 250),
    ).rejects.toThrow(
      'Request to https://example.googleapis.com/x timed out after 250ms',
    );
  });
});
