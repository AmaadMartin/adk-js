/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawnSync} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {createServer, Server} from 'node:https';
import type {Socket} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import type {TLSSocket} from 'node:tls';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  createMtlsDispatcher,
  FetchInitWithDispatcher,
} from '../../core/src/utils/mtls_utils.js';

const hasOpenssl = spawnSync('openssl', ['version']).status === 0;

const ENV_VARS = [
  'NODE_TLS_REJECT_UNAUTHORIZED',
  'GOOGLE_API_USE_CLIENT_CERTIFICATE',
  'GOOGLE_API_CERTIFICATE_CONFIG',
];
const originalEnv = new Map(
  ENV_VARS.map((name) => [name, process.env[name]] as const),
);

let certDir: string;
let configPath: string;
let server: Server;
let baseUrl: string;

/** Narrows a server socket to its TLS form. */
function isTlsSocket(socket: Socket | TLSSocket): socket is TLSSocket {
  return 'getPeerCertificate' in socket;
}

/**
 * Runs openssl with space-separated `args`, failing the test with its stderr
 * if the command does not succeed.
 */
function openssl(args: string) {
  const result = spawnSync('openssl', args.split(' '), {
    cwd: certDir,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    expect.fail(`openssl ${args} failed: ${result.stderr}`);
  }
}

/** Generates a throwaway CA plus a server and a client certificate. */
function generateCertificates() {
  writeFileSync(join(certDir, 'server.ext'), 'subjectAltName=DNS:localhost\n');
  openssl(
    'req -x509 -newkey rsa:2048 -nodes -keyout ca.key -out ca.pem -days 1' +
      ' -subj /CN=adk-test-ca',
  );
  openssl(
    'req -newkey rsa:2048 -nodes -keyout server.key -out server.csr' +
      ' -subj /CN=localhost',
  );
  openssl(
    'x509 -req -in server.csr -CA ca.pem -CAkey ca.key -CAcreateserial' +
      ' -out server.pem -days 1 -extfile server.ext',
  );
  openssl(
    'req -newkey rsa:2048 -nodes -keyout client.key -out client.csr' +
      ' -subj /CN=adk-test-client',
  );
  openssl(
    'x509 -req -in client.csr -CA ca.pem -CAkey ca.key -CAcreateserial' +
      ' -out client.pem -days 1',
  );
}

describe.skipIf(!hasOpenssl)('mTLS dispatcher', () => {
  beforeAll(async () => {
    certDir = mkdtempSync(join(tmpdir(), 'adk-mtls-'));
    generateCertificates();
    configPath = join(certDir, 'certificate_config.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        version: 1,
        cert_configs: {
          workload: {
            cert_path: join(certDir, 'client.pem'),
            key_path: join(certDir, 'client.key'),
          },
        },
      }),
    );

    // The server certificate is signed by a throwaway CA this process cannot
    // be told to trust (NODE_EXTRA_CA_CERTS is only read at startup), and
    // createMtlsDispatcher deliberately exposes no `ca` option. The assertions
    // below are about the *client* certificate, so server-certificate
    // verification is disabled for this file only.
    process.env['NODE_TLS_REJECT_UNAUTHORIZED'] = '0';

    server = createServer(
      {
        cert: readFileSync(join(certDir, 'server.pem')),
        key: readFileSync(join(certDir, 'server.key')),
        ca: readFileSync(join(certDir, 'ca.pem')),
        requestCert: true,
        rejectUnauthorized: false,
      },
      (req, res) => {
        const commonName = isTlsSocket(req.socket)
          ? (req.socket.getPeerCertificate().subject?.CN ?? null)
          : null;
        res.writeHead(200, {'content-type': 'application/json'});
        res.end(JSON.stringify({commonName}));
      },
    );
    await new Promise<void>((resolve) => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (typeof address === 'string' || address === null) {
      expect.fail('https server did not report a numeric port');
    }
    baseUrl = `https://localhost:${address.port}/`;
  });

  afterAll(async () => {
    for (const [name, value] of originalEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
    rmSync(certDir, {recursive: true, force: true});
  });

  it('presents the configured client certificate to the server', async () => {
    process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
    process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = configPath;

    const dispatcher = await createMtlsDispatcher();
    if (dispatcher === undefined) {
      expect.fail('createMtlsDispatcher returned no dispatcher');
    }
    const init: FetchInitWithDispatcher = {dispatcher};
    try {
      const res = await fetch(baseUrl, init);
      await expect(res.json()).resolves.toEqual({
        commonName: 'adk-test-client',
      });
    } finally {
      await dispatcher.close();
    }
  });

  it('sends no client certificate when the feature is disabled', async () => {
    delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
    process.env['GOOGLE_API_CERTIFICATE_CONFIG'] = configPath;

    await expect(createMtlsDispatcher()).resolves.toBeUndefined();

    const res = await fetch(baseUrl);
    await expect(res.json()).resolves.toEqual({commonName: null});
  });
});
