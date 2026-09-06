/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Fixtures shared by the two GCPSkillRegistry test files. */

import AdmZip from 'adm-zip';
import {AuthClient, OAuth2Client} from 'google-auth-library';
import * as fs from 'node:fs/promises';
import type {IncomingHttpHeaders} from 'node:http';
import {createServer} from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import {expect, vi} from 'vitest';

export const TEST_PROJECT = 'test-project';
export const TEST_LOCATION = 'us-central1';

/** The Agent Registry host the registry calls when nothing overrides it. */
export const DEFAULT_BASE_URL = 'https://agentregistry.googleapis.com/v1alpha';

/** The parent resource every skill of the test project lives under. */
export const RESOURCE_PARENT = `projects/${TEST_PROJECT}/locations/${TEST_LOCATION}`;

/** One canned response: its status, and the bytes it carries. */
export interface CannedResponse {
  status?: number;
  body: Buffer;
}

/** Answers a request for `url` with the bytes the test wants served. */
export type Responder = (url: string) => CannedResponse;

/**
 * Builds the zip archive of a skill whose `SKILL.md` holds `skillMd`.
 *
 * @param rawEntryName An extra member, written onto the entry after it is
 *     added because `adm-zip` normalizes a traversal name given to `addFile`.
 */
export function createSkillZip(
  skillMd = '---\nname: my-skill\ndescription: test\n---\n# My Skill\n',
  rawEntryName?: string,
): Buffer {
  const zip = new AdmZip();
  zip.addFile('SKILL.md', Buffer.from(skillMd, 'utf-8'));
  if (rawEntryName !== undefined) {
    zip.addFile('placeholder.txt', Buffer.from('x', 'utf-8'));
    const placeholder = zip
      .getEntries()
      .find((entry) => entry.entryName === 'placeholder.txt');
    if (!placeholder) {
      expect.fail('fixture setup failed: placeholder.txt was not added');
    }
    placeholder.entryName = rawEntryName;
  }
  return zip.toBuffer();
}

/** Serializes `body` as the JSON bytes of one response. */
export function jsonBody(body: unknown): Buffer {
  return Buffer.from(JSON.stringify(body), 'utf-8');
}

/**
 * Makes an empty home directory, so this machine has no SecureConnect
 * certificate to present.
 *
 * The endpoint choice reads `~/.secureConnect/context_aware_metadata.json`. A
 * test that read the real home directory would pass on a workstation that has
 * that file and fail on a runner that does not, so each test owns its own.
 */
export async function createTempHome(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'adk-registry-home-'));
}

/** Gives `homeDir` the SecureConnect metadata that names a certificate. */
export async function writeCertSource(homeDir: string): Promise<void> {
  const dir = path.join(homeDir, '.secureConnect');
  await fs.mkdir(dir, {recursive: true});
  await fs.writeFile(
    path.join(dir, 'context_aware_metadata.json'),
    JSON.stringify({cert_provider_command: ['/opt/cert_provider']}),
    'utf-8',
  );
}

/**
 * Builds real credentials that carry `token`.
 *
 * A real `OAuth2Client` stands in for the credentials so that the registry
 * sees the `AuthClient` contract it declares. The token is preset and
 * unexpired, so nothing is refreshed and no network call is made.
 */
export function credentialsFor(
  token: string,
  quotaProjectId?: string,
): AuthClient {
  const client: AuthClient = new OAuth2Client();
  client.quotaProjectId = quotaProjectId;
  client.credentials = {
    access_token: token,
    expiry_date: Date.now() + 3_600_000,
  };
  return client;
}

/**
 * The options of one request, read off `AuthClient` rather than imported from
 * `gaxios`: two copies of that package are installed, and only the one
 * `google-auth-library` itself uses will typecheck here.
 */
export type RequestOptions = Parameters<AuthClient['request']>[0];

/** Every request the registry made through its credentials, in order. */
export interface RecordedTransport {
  calls: RequestOptions[];
}

/**
 * Answers every request `credentials` make from `respond`, and records the
 * options they were called with.
 *
 * The registry hands each request to its credentials, which own the transport
 * and add the bearer token. That is the seam the adk-python suite mocks as
 * `httpx.AsyncClient.get`, so it is the one asserted here. The token itself is
 * proved on the wire by the tests that run against a real server.
 */
export function stubTransport(
  credentials: AuthClient,
  respond: Responder,
): RecordedTransport {
  const calls: RequestOptions[] = [];
  vi.spyOn(credentials, 'request').mockImplementation((options) => {
    calls.push(options);
    const url = String(options.url);
    const {status = 200, body} = respond(url);
    // A real `Response` is the base of gaxios' own response type, so the
    // stub carries every member the caller could read.
    const response = new Response(new Uint8Array(body), {status});
    return Promise.resolve(
      Object.assign(response, {
        config: {...options, url: new URL(url), headers: new Headers()},
        data: new Uint8Array(body).buffer,
      }),
    );
  });
  return {calls};
}

/** One request a {@link RegistryServer} served. */
export interface ServedRequest {
  url: string;
  headers: IncomingHttpHeaders;
}

/** A loopback stand-in for the Agent Registry API. */
export interface RegistryServer {
  /** The origin to point `AGENT_REGISTRY_ENDPOINT` at. */
  baseUrl: string;
  /** Every request the server received, in order. */
  requests: ServedRequest[];
  close(): Promise<void>;
}

/**
 * Starts a loopback HTTP server that answers from `respond`.
 *
 * This is what makes an assertion about the wire possible: the bearer token,
 * the tracking headers and the quota project are read off a request Node
 * actually received, rather than off a mock.
 */
export async function startRegistryServer(
  respond: Responder,
): Promise<RegistryServer> {
  const requests: ServedRequest[] = [];
  const server = createServer((request, response) => {
    const url = request.url ?? '';
    requests.push({url, headers: request.headers});
    const {status = 200, body} = respond(url);
    response.writeHead(status);
    response.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') {
    expect.fail('fixture setup failed: the server was given no TCP port');
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        // Keep-alive sockets outlive the response, and `close` waits for them.
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
