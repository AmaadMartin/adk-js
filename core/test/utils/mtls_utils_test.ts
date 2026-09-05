/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import * as http from 'node:http';
import * as net from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {logger} from '../../src/utils/logger.js';
import {
  collectResponseBody,
  getWithClientCert,
  HttpGetResult,
  loadDefaultClientCerts,
  MtlsEndpoint,
  mtlsEndpointSetting,
  useClientCertEffective,
} from '../../src/utils/mtls_utils.js';

const FAKE_CERT =
  '-----BEGIN CERTIFICATE-----\nZmFrZS1jZXJ0\n-----END CERTIFICATE-----';
const FAKE_KEY =
  '-----BEGIN RSA PRIVATE KEY-----\nZmFrZS1rZXk=\n-----END RSA PRIVATE KEY-----';
const FAKE_PASSPHRASE =
  '-----BEGIN PASSPHRASE-----\nhunter2\n-----END PASSPHRASE-----';

/** Home directory the SecureConnect metadata is read from during a test. */
let homeDir: string;
/** Both variables are set: os.homedir() reads USERPROFILE on Windows. */
const HOME_VARIABLES = ['HOME', 'USERPROFILE'];
let originalHome: Record<string, string | undefined>;

/** Writes `contents` as the SecureConnect metadata file under the fake home. */
function writeMetadata(contents: string): void {
  mkdirSync(join(homeDir, '.secureConnect'), {recursive: true});
  writeFileSync(
    join(homeDir, '.secureConnect', 'context_aware_metadata.json'),
    contents,
  );
}

/** Builds a provider command that prints `output` and exits with `code`. */
function providerPrinting(output: string, code = 0): string[] {
  return [
    process.execPath,
    '-e',
    `process.stdout.write(${JSON.stringify(output)}); process.exit(${code});`,
  ];
}

/** Every message passed to the logger during a test. */
function loggedText(
  warn: ReturnType<typeof vi.spyOn>,
  debug: ReturnType<typeof vi.spyOn>,
): string {
  return [...warn.mock.calls, ...debug.mock.calls].flat().join(' ');
}

describe('mtlsEndpointSetting', () => {
  const originalSetting = process.env['GOOGLE_API_USE_MTLS_ENDPOINT'];

  afterEach(() => {
    if (originalSetting === undefined) {
      delete process.env['GOOGLE_API_USE_MTLS_ENDPOINT'];
    } else {
      process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = originalSetting;
    }
  });

  it('reads always, never and auto', () => {
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'always';
    expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.ALWAYS);
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'never';
    expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.NEVER);
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'auto';
    expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.AUTO);
  });

  it('is case insensitive', () => {
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'ALWAYS';
    expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.ALWAYS);
  });

  it('falls back to auto when unset, empty or unrecognised', () => {
    delete process.env['GOOGLE_API_USE_MTLS_ENDPOINT'];
    expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.AUTO);
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = '';
    expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.AUTO);
    process.env['GOOGLE_API_USE_MTLS_ENDPOINT'] = 'banana';
    expect(mtlsEndpointSetting()).toBe(MtlsEndpoint.AUTO);
  });
});

/**
 * Ported from adk-python tests/unittests/utils/test_mtls_utils.py at
 * google/adk-python main.
 */
describe('useClientCertEffective', () => {
  const originalSetting = process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];

  afterEach(() => {
    if (originalSetting === undefined) {
      delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
    } else {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = originalSetting;
    }
  });

  it('test_use_client_cert_effective_fallback_true', () => {
    process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'TRUE';
    expect(useClientCertEffective()).toBe(true);
  });

  it('test_use_client_cert_effective_fallback_false', () => {
    process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'false';
    expect(useClientCertEffective()).toBe(false);
  });

  it('test_use_client_cert_effective_fallback_default_false', () => {
    delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
    expect(useClientCertEffective()).toBe(false);
  });
});

describe('loadDefaultClientCerts', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  let debug: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'adk-mtls-'));
    originalHome = {};
    for (const variable of HOME_VARIABLES) {
      originalHome[variable] = process.env[variable];
      process.env[variable] = homeDir;
    }
    warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const variable of HOME_VARIABLES) {
      const value = originalHome[variable];
      if (value === undefined) {
        delete process.env[variable];
      } else {
        process.env[variable] = value;
      }
    }
    rmSync(homeDir, {recursive: true, force: true});
    vi.restoreAllMocks();
  });

  it('resolves undefined when the metadata file is absent', async () => {
    await expect(loadDefaultClientCerts()).resolves.toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalled();
  });

  it('warns and resolves undefined when the metadata is not JSON', async () => {
    writeMetadata('not json at all');
    await expect(loadDefaultClientCerts()).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('Could not parse');
  });

  it('warns and resolves undefined without a cert provider command', async () => {
    writeMetadata(JSON.stringify({}));
    await expect(loadDefaultClientCerts()).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain('cert_provider_command');
  });

  it('warns and resolves undefined when the command is not a string list', async () => {
    writeMetadata(JSON.stringify({cert_provider_command: []}));
    await expect(loadDefaultClientCerts()).resolves.toBeUndefined();
    writeMetadata(JSON.stringify({cert_provider_command: [1, 2]}));
    await expect(loadDefaultClientCerts()).resolves.toBeUndefined();
    writeMetadata(JSON.stringify({cert_provider_command: 'a-string'}));
    await expect(loadDefaultClientCerts()).resolves.toBeUndefined();
  });

  it('returns the certificate and key the provider prints', async () => {
    writeMetadata(
      JSON.stringify({
        cert_provider_command: providerPrinting(`${FAKE_CERT}\n${FAKE_KEY}\n`),
      }),
    );
    await expect(loadDefaultClientCerts()).resolves.toEqual({
      cert: FAKE_CERT,
      key: FAKE_KEY,
    });
    expect(warn).not.toHaveBeenCalled();
  });

  it('returns the passphrase of an encrypted key', async () => {
    writeMetadata(
      JSON.stringify({
        cert_provider_command: providerPrinting(
          `${FAKE_CERT}\n${FAKE_KEY}\n${FAKE_PASSPHRASE}\n`,
        ),
      }),
    );
    await expect(loadDefaultClientCerts()).resolves.toEqual({
      cert: FAKE_CERT,
      key: FAKE_KEY,
      passphrase: 'hunter2',
    });
  });

  it('warns and resolves undefined when the provider prints no key', async () => {
    writeMetadata(
      JSON.stringify({cert_provider_command: providerPrinting(FAKE_CERT)}),
    );
    await expect(loadDefaultClientCerts()).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain(
      'no certificate and key pair',
    );
  });

  it('warns and resolves undefined when the provider command fails', async () => {
    writeMetadata(
      JSON.stringify({
        cert_provider_command: providerPrinting(
          `${FAKE_CERT}\n${FAKE_KEY}\n`,
          1,
        ),
      }),
    );
    await expect(loadDefaultClientCerts()).resolves.toBeUndefined();
    expect(warn.mock.calls.flat().join(' ')).toContain(
      'certificate provider command failed',
    );
  });

  it('never logs the private key the provider printed', async () => {
    writeMetadata(
      JSON.stringify({
        cert_provider_command: providerPrinting(
          `${FAKE_CERT}\n${FAKE_KEY}\n`,
          1,
        ),
      }),
    );
    await loadDefaultClientCerts();
    expect(loggedText(warn, debug)).not.toContain('ZmFrZS1rZXk=');
    expect(loggedText(warn, debug)).not.toContain('PRIVATE KEY');
  });

  it('keeps a whole certificate chain', async () => {
    const chain = `${FAKE_CERT}\n${FAKE_CERT}`;
    writeMetadata(
      JSON.stringify({
        cert_provider_command: providerPrinting(`${chain}\n${FAKE_KEY}\n`),
      }),
    );
    await expect(loadDefaultClientCerts()).resolves.toEqual({
      cert: chain,
      key: FAKE_KEY,
    });
  });
});

describe('collectResponseBody', () => {
  let server: http.Server;
  let baseUrl: string;
  let respond: (response: http.ServerResponse) => void;

  beforeEach(async () => {
    server = http.createServer((_request, response) => {
      respond(response);
    });
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      expect.fail('the test server did not report a port');
    }
    baseUrl = `http://127.0.0.1:${address.port}/`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => {
        resolve();
      });
    });
  });

  /** Issues a real GET and reads it back through collectResponseBody. */
  function get(): Promise<HttpGetResult> {
    return new Promise((resolve, reject) => {
      const request = http.request(baseUrl, {method: 'GET'}, (response) => {
        collectResponseBody(response).then(resolve, reject);
      });
      request.on('error', reject);
      request.end();
    });
  }

  it('reads the status and body of a successful response', async () => {
    respond = (response) => {
      response.writeHead(200, {'Content-Type': 'application/json'});
      response.end('{"mcpServers": []}');
    };
    await expect(get()).resolves.toEqual({
      ok: true,
      status: 200,
      body: '{"mcpServers": []}',
    });
  });

  it('reports a non-2xx status as not ok', async () => {
    respond = (response) => {
      response.writeHead(404);
      response.end('nope');
    };
    await expect(get()).resolves.toEqual({
      ok: false,
      status: 404,
      body: 'nope',
    });
  });
});

describe('getWithClientCert', () => {
  it('destroys the request when it times out', async () => {
    // A socket that accepts the connection and never completes the TLS
    // handshake: node:https emits `timeout` but leaves the socket open.
    const stalled = net.createServer(() => {});
    await new Promise<void>((resolve) => {
      stalled.listen(0, '127.0.0.1', resolve);
    });
    const address = stalled.address();
    if (typeof address === 'string' || address === null) {
      expect.fail('the stalled server did not report a port');
    }

    try {
      await expect(
        getWithClientCert(
          `https://127.0.0.1:${address.port}/`,
          {},
          // Empty material presents no certificate. The handshake never gets
          // far enough to use one, and OpenSSL rejects a placeholder PEM.
          {cert: '', key: ''},
          50,
        ),
      ).rejects.toThrow('Request timed out after 50ms');
    } finally {
      stalled.close();
    }
  });

  it('rejects when the connection fails', async () => {
    const closed = net.createServer();
    await new Promise<void>((resolve) => {
      closed.listen(0, '127.0.0.1', resolve);
    });
    const address = closed.address();
    if (typeof address === 'string' || address === null) {
      expect.fail('the closed server did not report a port');
    }
    const port = address.port;
    await new Promise<void>((resolve) => {
      closed.close(() => {
        resolve();
      });
    });

    await expect(
      getWithClientCert(
        `https://127.0.0.1:${port}/`,
        {},
        {cert: '', key: ''},
        1000,
      ),
    ).rejects.toThrow();
  });
});
