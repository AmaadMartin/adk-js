/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Drives the real `@google-cloud/storage` against a local HTTP server and
 * reads the headers it sent.
 *
 * Nothing here is mocked, deliberately. `@google-cloud/storage@7` pins
 * `google-auth-library@^9` and adk pins `^10`, so the credential crosses a
 * version boundary on its way to the wire. A fake `Storage` cannot show
 * whether it survives the crossing; only the real one can.
 */

import {Storage} from '@google-cloud/storage';
import {OAuth2Client} from 'google-auth-library';
import {IncomingHttpHeaders, Server, createServer} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
// Not part of the package barrel: it is a compatibility shim between two
// copies of google-auth-library, not something an application calls.
import {asStorageAuthClient} from '../../../src/integrations/gcs/client.js';

const TOKEN = 'test-access-token';
const HOUR_MS = 60 * 60 * 1000;

let server: Server;
let endpoint: string;
let received: IncomingHttpHeaders[];

/** An OAuth2 client holding a live token, as the credentials manager returns. */
function credentials(accessToken = TOKEN): OAuth2Client {
  const client = new OAuth2Client();
  client.setCredentials({
    access_token: accessToken,
    expiry_date: Date.now() + HOUR_MS,
  });
  return client;
}

/**
 * A Cloud Storage client pointed at the local server.
 *
 * `useAuthWithCustomEndpoint` keeps authentication on; without it the SDK
 * treats a custom endpoint as an unauthenticated emulator and the test would
 * pass whatever the credential did.
 */
function storageFor(client: OAuth2Client): Storage {
  return new Storage({
    authClient: asStorageAuthClient(client),
    projectId: 'test-project',
    apiEndpoint: endpoint,
    useAuthWithCustomEndpoint: true,
  });
}

beforeAll(async () => {
  server = createServer((req, res) => {
    received.push(req.headers);
    res.writeHead(200, {'content-type': 'application/json'});
    res.end(JSON.stringify({kind: 'storage#buckets', items: []}));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const {port} = server.address() as AddressInfo;
  endpoint = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    server.close((err) => (err ? reject(err) : resolve())),
  );
});

beforeEach(() => {
  received = [];
});

describe('the credential on the wire', () => {
  it('sends the access token as a bearer token', async () => {
    await storageFor(credentials()).getBuckets();

    expect(received).toHaveLength(1);
    expect(received[0].authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('sends the token a refresh replaced, not the one built with', async () => {
    const client = credentials('first-token');
    const storage = storageFor(client);
    await storage.getBuckets();

    client.setCredentials({
      access_token: 'refreshed-token',
      expiry_date: Date.now() + HOUR_MS,
    });
    await storage.getBuckets();

    expect(received.map((headers) => headers.authorization)).toEqual([
      'Bearer first-token',
      'Bearer refreshed-token',
    ]);
  });

  it('authenticates a request the admin tools actually make', async () => {
    // `getBuckets` above is the read path. This is the write path, which goes
    // out through a different method on the same client.
    await storageFor(credentials()).bucket('a-bucket').getMetadata();

    expect(received).toHaveLength(1);
    expect(received[0].authorization).toBe(`Bearer ${TOKEN}`);
  });

  it('gives two credentials two different bearer tokens', async () => {
    await storageFor(credentials('token-a')).getBuckets();
    await storageFor(credentials('token-b')).getBuckets();

    expect(received.map((headers) => headers.authorization)).toEqual([
      'Bearer token-a',
      'Bearer token-b',
    ]);
  });
});
