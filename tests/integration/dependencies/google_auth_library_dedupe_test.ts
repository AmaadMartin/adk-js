/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import fs from 'node:fs';
import http from 'node:http';
import {createRequire} from 'node:module';
import os from 'node:os';
import path from 'node:path';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

/**
 * Guards the dependent-scoped npm override that moves `@google-cloud/vertexai`
 * onto `google-auth-library` 10.x.
 *
 * `@google-cloud/vertexai` declares `^9.1.0`, so without the override npm nests
 * a second major version and every process that imports the package root loads
 * both. The override is safe because the package calls exactly two runtime
 * symbols, the `GoogleAuth` constructor and `getAccessToken()`, and neither
 * changed in v10; the known v9 to v10 breaks (`getRequestHeaders()` returning
 * `Headers`, `authorizeRequest()` dropping `opts.uri`, the removed
 * `DefaultTransporter`) are never reached. Both packages already declare
 * Node >= 18, so the override cannot narrow the supported range.
 */
const REPO_ROOT = process.cwd();
const VERTEXAI_DIR = 'node_modules/@google-cloud/vertexai';
const NESTED_LOCK_PATH = `${VERTEXAI_DIR}/node_modules/google-auth-library`;
const SCOPES = ['https://www.googleapis.com/auth/cloud-platform'];

const LOOPBACK_TOKEN = 'loopback-access-token';
const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const AGENT_ENGINE_ID = '12345';
const SESSION_ID = 'session-1';

const require = createRequire(path.join(REPO_ROOT, 'package.json'));

interface RootManifest {
  overrides?: Record<string, Record<string, string>>;
}

interface Lockfile {
  packages: Record<string, unknown>;
}

function readJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as T;
}

/** Resolves `specifier` the way a package in `dependentDir` resolves it. */
function resolveFrom(dependentDir: string, specifier: string): string {
  return require.resolve(specifier, {
    paths: [path.join(REPO_ROOT, dependentDir)],
  });
}

/** Loads `google-auth-library` the way a package in `dependentDir` loads it. */
function loadAuthLibraryFrom(
  dependentDir: string,
): typeof import('google-auth-library') {
  return require(resolveFrom(dependentDir, 'google-auth-library'));
}

describe('google-auth-library deduplication under @google-cloud/vertexai', () => {
  it('pins the dependent-scoped override in the root manifest', () => {
    const manifest = readJson<RootManifest>(
      path.join(REPO_ROOT, 'package.json'),
    );

    expect(
      manifest.overrides?.['@google-cloud/vertexai']?.['google-auth-library'],
    ).toBe('^10.3.0');
  });

  it('locks no nested google-auth-library under @google-cloud/vertexai', () => {
    const lockfile = readJson<Lockfile>(
      path.join(REPO_ROOT, 'package-lock.json'),
    );

    expect(Object.keys(lockfile.packages)).not.toContain(NESTED_LOCK_PATH);
  });

  it('installs one google-auth-library 10.x for @google-cloud/vertexai and core', () => {
    const fromVertexai = resolveFrom(
      VERTEXAI_DIR,
      'google-auth-library/package.json',
    );
    const fromCore = resolveFrom('core', 'google-auth-library/package.json');

    expect(fromVertexai).toBe(fromCore);
    expect(readJson<{version: string}>(fromVertexai).version).toMatch(/^10\./);
  });
});

/**
 * Proves the override leaves authentication working, against a loopback server
 * that stands in for both the metadata server and the Agent Engine API.
 *
 * Application Default Credentials must be sealed off, or `GoogleAuth` mints a
 * real token from the developer's own gcloud credentials and the test passes
 * without the loopback server ever being reached. `google-auth-library` 10.x
 * ignores `CLOUDSDK_CONFIG` and reads the well-known credentials file under
 * `$HOME/.config` on Linux and macOS and under `%APPDATA%` on Windows, so both
 * variables have to move.
 */
describe('google-auth-library authentication with the override installed', () => {
  let server: http.Server;
  let host: string;
  let fakeHome: string;
  let metadataRequests: string[];
  let apiRequests: Array<{url: string; authorization?: string}>;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      const url = request.url ?? '';
      if (url.startsWith('/computeMetadata/')) {
        metadataRequests.push(url);
        response.writeHead(200, {
          'content-type': 'application/json',
          'metadata-flavor': 'Google',
        });
        response.end(
          JSON.stringify({
            access_token: LOOPBACK_TOKEN,
            expires_in: 3600,
            token_type: 'Bearer',
          }),
        );
        return;
      }
      apiRequests.push({url, authorization: request.headers.authorization});
      response.writeHead(200, {'content-type': 'application/json'});
      response.end(
        JSON.stringify({
          name: `reasoningEngines/${AGENT_ENGINE_ID}/sessions/${SESSION_ID}`,
          userId: 'user-1',
        }),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const address = server.address();
    if (address === null || typeof address === 'string') {
      expect.fail(`the loopback server bound ${address} instead of a TCP port`);
    }
    host = `127.0.0.1:${address.port}`;

    fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-dedupe-home-'));
    vi.stubEnv('HOME', fakeHome);
    vi.stubEnv('APPDATA', fakeHome);
    vi.stubEnv('GOOGLE_APPLICATION_CREDENTIALS', undefined);
    vi.stubEnv('GCE_METADATA_HOST', host);
    vi.stubEnv('METADATA_SERVER_DETECTION', 'assume-present');
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    fs.rmSync(fakeHome, {recursive: true, force: true});
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  beforeEach(() => {
    metadataRequests = [];
    apiRequests = [];
  });

  it('mints a token through the GoogleAuth that @google-cloud/vertexai loads', async () => {
    const {GoogleAuth} = loadAuthLibraryFrom(VERTEXAI_DIR);
    expect(GoogleAuth).toBe(loadAuthLibraryFrom('core').GoogleAuth);

    const token = await new GoogleAuth({scopes: SCOPES}).getAccessToken();

    expect(token).toBe(LOOPBACK_TOKEN);
    expect(metadataRequests).not.toHaveLength(0);
  });

  it('lets the workspace recognise a subclass built by @google-cloud/vertexai', async () => {
    const {GoogleAuth} = loadAuthLibraryFrom(VERTEXAI_DIR);
    class FakeGoogleAuth extends GoogleAuth {
      override async getAccessToken(): Promise<string> {
        return 'subclass-token';
      }
    }

    const auth = new FakeGoogleAuth({scopes: SCOPES});

    expect(auth).toBeInstanceOf(loadAuthLibraryFrom('core').GoogleAuth);
    expect(await auth.getAccessToken()).toBe('subclass-token');
  });

  it('signs an Agent Engine session request with the loopback token', async () => {
    const client = new Client({
      project: PROJECT,
      location: LOCATION,
      apiEndpoint: `http://${host}`,
    });

    const session = await client.agentEnginesInternal.sessions.get({
      name: `reasoningEngines/${AGENT_ENGINE_ID}/sessions/${SESSION_ID}`,
    });

    expect(session.name).toBe(
      `reasoningEngines/${AGENT_ENGINE_ID}/sessions/${SESSION_ID}`,
    );
    expect(apiRequests).toEqual([
      {
        url: `/v1beta1/projects/${PROJECT}/locations/${LOCATION}/reasoningEngines/${AGENT_ENGINE_ID}/sessions/${SESSION_ID}`,
        authorization: `Bearer ${LOOPBACK_TOKEN}`,
      },
    ]);
    expect(metadataRequests).not.toHaveLength(0);
  });
});
