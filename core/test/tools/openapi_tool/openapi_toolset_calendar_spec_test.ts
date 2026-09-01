/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  OpenApiSpecParser,
  OpenAPIToolset,
  ParsedOperation,
  RestApiTool,
} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {OpenAPIV3} from 'openapi-types';
import {describe, expect, it} from 'vitest';

const CALENDAR_BASE_URL = 'https://www.googleapis.com/calendar/v3';
const CALENDAR_ID_DESCRIPTION =
  'Calendar identifier. To retrieve calendar IDs call the calendarList.list' +
  ' method. If you want to access the primary calendar of the currently' +
  ' logged in user, use the "primary" keyword.';

const specPath = path.resolve(__dirname, 'fixtures/calendar.yaml');
const calendarSpec = yaml.load(
  fs.readFileSync(specPath, 'utf8'),
) as OpenAPIV3.Document;

function operationById(
  operations: ParsedOperation[],
  operationId: string,
): ParsedOperation {
  const found = operations.find((o) => o.operation.operationId === operationId);
  if (!found) {
    expect.fail(`no parsed operation with operationId '${operationId}'`);
  }
  return found;
}

function resolvedRequestBody(
  operation: OpenAPIV3.OperationObject,
): OpenAPIV3.RequestBodyObject {
  const requestBody = operation.requestBody;
  if (!requestBody || '$ref' in requestBody) {
    expect.fail('the parser left the request body unresolved');
  }
  return requestBody;
}

function resolvedResponse(
  operation: OpenAPIV3.OperationObject,
  status: string,
): OpenAPIV3.ResponseObject {
  const response = operation.responses[status];
  if (!response || '$ref' in response) {
    expect.fail(`the parser left response '${status}' unresolved`);
  }
  return response;
}

describe('OpenAPIToolset (Calendar v3 spec)', () => {
  it('builds a tool for every operation in a spec object', async () => {
    const toolset = new OpenAPIToolset({specDict: calendarSpec});

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      expect(tool).toBeInstanceOf(RestApiTool);
    }
  });

  it('builds the same tools from a YAML spec string', async () => {
    const toolset = new OpenAPIToolset({
      specStr: yaml.dump(calendarSpec),
      specType: 'yaml',
    });

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      expect(tool).toBeInstanceOf(RestApiTool);
    }
  });

  it('looks up each tool by its snake_cased operation id', () => {
    const toolset = new OpenAPIToolset({specDict: calendarSpec});

    const insert = toolset.getTool('calendar_calendars_insert');
    expect(insert).toBeInstanceOf(RestApiTool);
    expect(insert?.name).toBe('calendar_calendars_insert');
    expect(insert?.description).toBe('Creates a secondary calendar.');
    expect(insert?.isLongRunning).toBe(false);

    const get = toolset.getTool('calendar_calendars_get');
    expect(get).toBeInstanceOf(RestApiTool);
    expect(get?.name).toBe('calendar_calendars_get');
    expect(get?.description).toBe('Returns metadata for a calendar.');
    expect(get?.isLongRunning).toBe(false);

    for (const name of [
      'calendar_calendars_update',
      'calendar_calendars_delete',
      'calendar_calendars_patch',
    ]) {
      expect(toolset.getTool(name)).toBeInstanceOf(RestApiTool);
    }
  });

  it('returns undefined for a name not in the spec', () => {
    const toolset = new OpenAPIToolset({specDict: calendarSpec});

    expect(toolset.getTool('non_existent_tool')).toBeUndefined();
  });

  it('parses the endpoint, body, responses and OAuth2 scheme of an operation', () => {
    const operations = new OpenApiSpecParser().parse(calendarSpec);

    const insert = operationById(operations, 'calendar.calendars.insert');
    expect(insert.endpoint).toEqual({
      baseUrl: CALENDAR_BASE_URL,
      path: '/calendars',
      method: 'post',
    });
    expect(insert.description).toBe('Creates a secondary calendar.');
    expect(insert.operation.description).toBe('Creates a secondary calendar.');
    expect(
      resolvedRequestBody(insert.operation).content['application/json'].schema,
    ).toBeDefined();
    expect(Object.keys(insert.operation.responses)).toEqual(['200']);
    const ok = resolvedResponse(insert.operation, '200');
    expect(ok.description).toBe('Successful response');
    expect(ok.content?.['application/json'].schema).toBeDefined();
    expect(insert.authScheme?.type).toBe('oauth2');
  });

  it('merges the path-level parameters into an operation, keeping its own first', () => {
    const operations = new OpenApiSpecParser().parse(calendarSpec);

    const get = operationById(operations, 'calendar.calendars.get');
    expect(get.endpoint).toEqual({
      baseUrl: CALENDAR_BASE_URL,
      path: '/calendars/{calendarId}',
      method: 'get',
    });
    expect(get.operation.description).toBe('Returns metadata for a calendar.');
    // `calendarId` plus the seven shared query parameters the path declares.
    expect(get.parameters).toHaveLength(8);
    const calendarId = get.parameters[0];
    expect(calendarId.originalName).toBe('calendarId');
    expect(calendarId.paramLocation).toBe('path');
    expect(calendarId.required).toBe(true);
    expect(calendarId.paramSchema.type).toBe('string');
    expect(calendarId.description).toBe(CALENDAR_ID_DESCRIPTION);
    expect(get.authScheme?.type).toBe('oauth2');
  });

  it('applies the constructor auth scheme and credential to every tool', async () => {
    const authScheme: OpenAPIV3.ApiKeySecurityScheme = {
      type: 'apiKey',
      in: 'header',
      name: 'api_key',
    };
    const authCredential: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
    };
    const toolset = new OpenAPIToolset({
      specDict: calendarSpec,
      authScheme,
      authCredential,
    });

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(5);
    for (const tool of tools) {
      // `RestApiTool.authScheme` and `.authCredential` are private and have no
      // public reader, so the applied override is only observable through a
      // cast. This mirrors openapi_toolset_test.ts.
      const internals = tool as unknown as {
        authScheme?: OpenAPIV3.SecuritySchemeObject;
        authCredential?: AuthCredential;
      };
      expect(internals.authScheme).toEqual(authScheme);
      expect(internals.authCredential).toEqual(authCredential);
    }
  });
});
