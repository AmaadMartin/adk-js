/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The five tools against a real `@google-cloud/storage` client, with no mock
 * anywhere: the client makes real HTTP requests to a local server standing in
 * for the JSON API, and the test asserts on what it received.
 *
 * This is what proves the tools speak the API rather than a test double: the
 * request paths, the query the page size becomes, the patch body, and the
 * attribution header all come from the real client.
 *
 * `STORAGE_EMULATOR_HOST` is how the client is pointed at the local server. It
 * also marks the endpoint as custom, and the client sends no `Authorization`
 * header to a custom endpoint, so this test does not cover authentication.
 * `client_test.ts` covers the credentials the tools hand the client.
 */

import {GcsCapabilities, version} from '@google/adk';
import {createServer, IncomingMessage, Server, ServerResponse} from 'node:http';
import {AddressInfo} from 'node:net';
import {afterAll, beforeAll, beforeEach, describe, expect, it} from 'vitest';
import {
  ADC_CREDENTIALS,
  createConfirmedToolContext,
  createToolContext,
  createToolset,
  getTool,
} from './gcs_test_utils.js';

/** One request the local server answered. */
interface ReceivedRequest {
  method: string;
  url: string;
  userAgent: string | undefined;
  body: string;
}

const received: ReceivedRequest[] = [];

/** The bucket the local server answers with a 404, as the real API would. */
const MISSING_BUCKET = 'bucket-that-is-not-there';

/** Answers any bucket request with a plausible resource. */
function handle(req: IncomingMessage, res: ServerResponse): void {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    received.push({
      method: req.method ?? '',
      url: req.url ?? '',
      userAgent: req.headers['user-agent'],
      body: Buffer.concat(chunks).toString(),
    });
    if (req.method === 'DELETE') {
      res.writeHead(204).end();
      return;
    }
    const url = req.url ?? '';
    res.setHeader('content-type', 'application/json');
    if (url.startsWith(`/b/${MISSING_BUCKET}`)) {
      res.writeHead(404).end(
        JSON.stringify({
          error: {code: 404, message: `Not Found: ${MISSING_BUCKET}`},
        }),
      );
      return;
    }
    if (!url.startsWith('/b?')) {
      res.end(
        JSON.stringify({
          kind: 'storage#bucket',
          id: 'bucket-one',
          name: 'bucket-one',
          location: 'US',
        }),
      );
      return;
    }
    // A next page token is reported only for a bounded page. Reporting one for
    // an unbounded listing would make the client page for ever, because it
    // follows the token until a page reports none.
    res.end(
      JSON.stringify({
        items: [{id: 'bucket-one', name: 'bucket-one'}],
        ...(url.includes('maxResults=') ? {nextPageToken: 'page-2'} : {}),
      }),
    );
  });
}

let server: Server;
let previousEmulatorHost: string | undefined;

/** The toolset under test, exposing all five tools. */
function toolset() {
  return createToolset({
    credentialsConfig: ADC_CREDENTIALS,
    gcsToolSettings: {capabilities: [GcsCapabilities.READ_WRITE]},
  });
}

/** The single request whose path contains `fragment`. */
function requestMatching(fragment: string): ReceivedRequest {
  const matching = received.filter((each) => each.url.includes(fragment));
  expect(matching, `expected one request matching ${fragment}`).toHaveLength(1);
  return matching[0];
}

describe('the Cloud Storage tools over real HTTP', () => {
  beforeAll(async () => {
    server = createServer(handle);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const {port} = server.address() as AddressInfo;
    previousEmulatorHost = process.env['STORAGE_EMULATOR_HOST'];
    process.env['STORAGE_EMULATOR_HOST'] = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    if (previousEmulatorHost === undefined) {
      delete process.env['STORAGE_EMULATOR_HOST'];
    } else {
      process.env['STORAGE_EMULATOR_HOST'] = previousEmulatorHost;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
  });

  beforeEach(() => {
    received.length = 0;
  });

  it('lists the buckets of a project', async () => {
    const tool = await getTool(toolset(), 'gcs_list_buckets');

    const result = await tool.runAsync({
      args: {project_id: 'demo-project'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'SUCCESS', results: ['bucket-one']});
    const request = requestMatching('project=demo-project');
    expect(request.method).toBe('GET');
    // The attribution adk-python sends as its user agent reaches the wire.
    expect(request.userAgent).toContain(`adk-gcs-tool google-adk/${version}`);
  });

  it('asks for one page and reports the next page token', async () => {
    const tool = await getTool(toolset(), 'gcs_list_buckets');

    const result = await tool.runAsync({
      args: {project_id: 'demo-project', page_size: 1, page_token: 'page-1'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: ['bucket-one'],
      next_page_token: 'page-2',
    });
    const request = requestMatching('maxResults=1');
    expect(request.url).toContain('pageToken=page-1');
  });

  it('reads the metadata of one bucket', async () => {
    const tool = await getTool(toolset(), 'gcs_get_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'bucket-one'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: {
        kind: 'storage#bucket',
        id: 'bucket-one',
        name: 'bucket-one',
        location: 'US',
      },
    });
    expect(requestMatching('/b/bucket-one').method).toBe('GET');
  });

  it('creates a bucket in a location', async () => {
    const tool = await getTool(toolset(), 'gcs_create_bucket');

    const result = await tool.runAsync({
      args: {
        project_id: 'demo-project',
        bucket_name: 'bucket-one',
        location: 'europe-west1',
      },
      toolContext: createConfirmedToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket bucket-one created successfully.',
    });
    const request = requestMatching('project=demo-project');
    expect(request.method).toBe('POST');
    expect(JSON.parse(request.body)).toMatchObject({
      name: 'bucket-one',
      location: 'europe-west1',
    });
  });

  it('patches the settings of a bucket', async () => {
    const tool = await getTool(toolset(), 'gcs_update_bucket');

    const result = await tool.runAsync({
      args: {
        bucket_name: 'bucket-one',
        versioning_enabled: true,
        uniform_bucket_level_access_enabled: true,
      },
      toolContext: createConfirmedToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket bucket-one updated successfully.',
    });
    const request = requestMatching('/b/bucket-one');
    expect(request.method).toBe('PATCH');
    expect(JSON.parse(request.body)).toEqual({
      versioning: {enabled: true},
      iamConfiguration: {uniformBucketLevelAccess: {enabled: true}},
    });
  });

  it('deletes a bucket', async () => {
    const tool = await getTool(toolset(), 'gcs_delete_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: 'bucket-one'},
      toolContext: createConfirmedToolContext(),
    });

    expect(result).toEqual({
      status: 'SUCCESS',
      results: 'Bucket bucket-one deleted successfully.',
    });
    expect(requestMatching('/b/bucket-one').method).toBe('DELETE');
  });

  it('reports a 404 from the API as an ERROR result', async () => {
    const tool = await getTool(toolset(), 'gcs_get_bucket');

    const result = await tool.runAsync({
      args: {bucket_name: MISSING_BUCKET},
      toolContext: createToolContext(),
    });

    expect(result).toMatchObject({status: 'ERROR'});
    expect((result as {error_details: string}).error_details).toContain(
      MISSING_BUCKET,
    );
  });
});
