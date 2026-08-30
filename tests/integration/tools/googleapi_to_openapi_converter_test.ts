/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GoogleApiToOpenApiConverter, OpenAPIToolset} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import type {AddressInfo} from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

/**
 * A small Discovery document served over a real socket.
 *
 * It carries the shapes the converter has to get right end to end: a nested
 * resource, a path parameter, a query parameter and a request body reference.
 */
const DISCOVERY_DOCUMENT = {
  title: 'Fake Calendar API',
  description: 'A calendar for tests',
  version: 'v3',
  documentationLink: 'https://example.com/docs',
  rootUrl: 'https://calendar.example.com/',
  servicePath: 'calendar/v3/',
  auth: {
    oauth2: {
      scopes: {
        'https://example.com/auth/calendar': {description: 'Full access'},
      },
    },
  },
  schemas: {
    Calendar: {
      type: 'object',
      description: 'A calendar',
      properties: {
        id: {type: 'string', description: 'Identifier', required: true},
        summary: {type: 'string'},
      },
    },
    Event: {
      type: 'object',
      properties: {
        organizer: {$ref: 'Calendar', description: 'Who owns the event'},
      },
    },
  },
  resources: {
    calendars: {
      methods: {
        get: {
          id: 'calendar.calendars.get',
          description: 'Reads one calendar',
          httpMethod: 'GET',
          flatPath: 'calendars/{calendarId}',
          parameters: {
            calendarId: {type: 'string', location: 'path', required: true},
            maxResults: {type: 'integer', format: 'int32', default: '250'},
          },
          response: {$ref: 'Calendar'},
          scopes: ['https://example.com/auth/calendar'],
        },
        insert: {
          id: 'calendar.calendars.insert',
          httpMethod: 'POST',
          flatPath: 'calendars',
          request: {$ref: 'Calendar'},
        },
      },
    },
  },
};

describe('GoogleApiToOpenApiConverter against a real discovery server', () => {
  let server: http.Server;
  let discoveryUrl: string;
  let outputDir: string;

  beforeAll(async () => {
    server = http.createServer((request, response) => {
      if (request.url === '/discovery/calendar/v3') {
        response.writeHead(200, {'Content-Type': 'application/json'});
        response.end(JSON.stringify(DISCOVERY_DOCUMENT));
        return;
      }
      response.writeHead(404, {'Content-Type': 'application/json'});
      response.end('{}');
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );

    const {port} = server.address() as AddressInfo;
    discoveryUrl = `http://127.0.0.1:${port}/discovery/{api}/{apiVersion}`;
    outputDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-openapi-e2e-'));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fs.rm(outputDir, {recursive: true, force: true});
  });

  it('converts a served document and writes it to a file', async () => {
    const converter = new GoogleApiToOpenApiConverter('calendar', 'v3', {
      discoveryUrl,
    });

    const spec = await converter.convert();

    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info.title).toBe('Fake Calendar API');
    expect(spec.servers).toEqual([
      {
        url: 'https://calendar.example.com/calendar/v3',
        description: 'calendar v3 API',
      },
    ]);
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/calendars',
      '/calendars/{calendarId}',
    ]);

    const outputPath = path.join(outputDir, 'calendar_openapi.json');
    await converter.saveOpenApiSpec(outputPath);

    expect(JSON.parse(await fs.readFile(outputPath, 'utf-8'))).toEqual(spec);
  });

  it('keeps the description discovery states beside a reference', async () => {
    const spec = await new GoogleApiToOpenApiConverter('calendar', 'v3', {
      discoveryUrl,
    }).convert();

    expect(spec.components?.schemas?.['Event']).toEqual({
      type: 'object',
      properties: {
        organizer: {
          $ref: '#/components/schemas/Calendar',
          description: 'Who owns the event',
        },
      },
    });
  });

  it('produces a document the OpenAPI toolset can build tools from', async () => {
    const spec = await new GoogleApiToOpenApiConverter('calendar', 'v3', {
      discoveryUrl,
    }).convert();

    const tools = await new OpenAPIToolset({specDict: spec}).getTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      'calendar.calendars.get',
      'calendar.calendars.insert',
    ]);
  });

  it('rejects when the discovery service has no such API', async () => {
    await expect(
      new GoogleApiToOpenApiConverter('missing', 'v9', {
        discoveryUrl,
      }).convert(),
    ).rejects.toThrow('HTTP 404');
  });
});
