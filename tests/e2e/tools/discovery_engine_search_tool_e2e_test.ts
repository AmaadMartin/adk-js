/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DiscoveryEngineSearchTool} from '@google/adk';
import * as http from 'http';
import {afterAll, afterEach, beforeAll, describe, expect, it, vi} from 'vitest';

// The credential provider is the ONLY stubbed boundary: Application Default
// Credentials are unavailable in CI. Everything else in this suite is real -
// the tool builds a real request, sends it over a real TCP socket to a real
// HTTP server, and parses the real response, including the auto-detect
// fallback from CHUNKS to DOCUMENTS.
//
// To validate against a real Vertex AI Search data store instead, run with
// Application Default Credentials and a real resource id:
//   const tool = new DiscoveryEngineSearchTool({dataStoreId: '<resource id>'});
//   await tool.discoveryEngineSearch('<query>');
vi.mock('google-auth-library', () => ({
  GoogleAuth: vi.fn().mockImplementation(() => ({
    getClient: vi.fn().mockResolvedValue({
      getRequestHeaders: vi
        .fn()
        .mockResolvedValue(new Headers({Authorization: 'Bearer e2e-token'})),
      quotaProjectId: undefined,
    }),
  })),
}));

/**
 * A real HTTP server emulating the Discovery Engine `:search` REST contract for
 * a structured datastore (which rejects CHUNKS and requires DOCUMENTS).
 */
describe('DiscoveryEngineSearchTool E2E (real HTTP server)', () => {
  let server: http.Server;
  let port: number;
  const originalFetch = globalThis.fetch;
  const requestedModes: string[] = [];

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      if (!req.headers['authorization']) {
        res.writeHead(401);
        res.end('missing authorization');
        return;
      }
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        const body = JSON.parse(raw) as {
          contentSearchSpec?: {searchResultMode?: string};
        };
        const mode = body.contentSearchSpec?.searchResultMode ?? '';
        requestedModes.push(mode);

        if (mode === 'CHUNKS') {
          // Structured datastore: reject CHUNKS to trigger the DOCUMENTS retry.
          res.writeHead(400, {'Content-Type': 'application/json'});
          res.end(
            JSON.stringify({
              error: {
                message:
                  '`content_search_spec.search_result_mode` must be set to ' +
                  'DOCUMENTS when the engine contains a structured data store.',
              },
            }),
          );
          return;
        }

        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(
          JSON.stringify({
            results: [
              {
                document: {
                  structData: {
                    title: 'E2E Doc',
                    uri: 'https://e2e.example/doc',
                    summary: 'hello from e2e',
                  },
                },
              },
            ],
          }),
        );
      });
    });

    await new Promise<void>((resolve) => {
      server.listen(0, () => {
        const address = server.address();
        if (address && typeof address !== 'string') {
          port = address.port;
        }
        resolve();
      });
    });

    // Redirect only Discovery Engine hosts to the local server; the real fetch
    // performs the request over a real socket. Parameter types are inferred
    // from `typeof fetch` by the assignment.
    globalThis.fetch = (input, init) => {
      const url = new URL(input instanceof URL ? input.href : String(input));
      if (url.hostname.endsWith('discoveryengine.googleapis.com')) {
        return originalFetch(
          `http://localhost:${port}${url.pathname}${url.search}`,
          init,
        );
      }
      return originalFetch(input, init);
    };
  });

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  afterEach(() => {
    requestedModes.length = 0;
  });

  it('auto-detects DOCUMENTS mode and parses a structured result end to end', async () => {
    const tool = new DiscoveryEngineSearchTool({
      dataStoreId:
        'projects/p/locations/us/collections/default_collection/dataStores/ds',
    });

    const result = await tool.discoveryEngineSearch('hello');

    expect(result).toEqual({
      status: 'success',
      results: [
        {
          title: 'E2E Doc',
          url: 'https://e2e.example/doc',
          content: '{"summary":"hello from e2e"}',
        },
      ],
    });
    // One CHUNKS probe that failed, then the DOCUMENTS retry.
    expect(requestedModes).toEqual(['CHUNKS', 'DOCUMENTS']);
  });
});
