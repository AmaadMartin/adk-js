/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  convertDiscoveryDocument,
  DiscoveryDocument,
  DiscoveryMethod,
  DiscoveryParameter,
  DiscoveryResource,
  DiscoverySchema,
  GoogleApiToOpenApiConverter,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, describe, expect, it, vi} from 'vitest';
// The granular `convert*` and `extract*` functions are implementation detail
// and are deliberately not part of `@google/adk`, so the test reaches them by
// relative path.
import {
  ConvertedSchema,
  convertExternalDocs,
  convertInfo,
  convertMethods,
  convertParameterSchema,
  convertResources,
  convertSchemaObject,
  convertSchemas,
  convertSecuritySchemes,
  convertServers,
  extractPathParameters,
} from '../../../src/tools/google_api_tool/googleapi_to_openapi_converter.js';

const DISCOVERY_URL =
  'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const CALENDAR_READONLY_SCOPE =
  'https://www.googleapis.com/auth/calendar.readonly';

/**
 * The `calendars` methods, kept separate so the `convertMethods` test can pass
 * them without narrowing them back out of the document.
 */
const CALENDARS_METHODS: Record<string, DiscoveryMethod> = {
  get: {
    id: 'calendar.calendars.get',
    flatPath: 'calendars/{calendarId}',
    httpMethod: 'GET',
    description: 'Returns metadata for a calendar.',
    parameters: {
      calendarId: {
        type: 'string',
        description: 'Calendar identifier',
        required: true,
        location: 'path',
      },
    },
    response: {$ref: 'Calendar'},
    scopes: [CALENDAR_SCOPE, CALENDAR_READONLY_SCOPE],
  },
  insert: {
    id: 'calendar.calendars.insert',
    path: 'calendars',
    httpMethod: 'POST',
    description: 'Creates a secondary calendar.',
    request: {$ref: 'Calendar'},
    response: {$ref: 'Calendar'},
    scopes: [CALENDAR_SCOPE],
  },
};

const CALENDAR_RESOURCES: Record<string, DiscoveryResource> = {
  calendars: {
    methods: CALENDARS_METHODS,
    resources: {
      events: {
        methods: {
          list: {
            id: 'calendar.events.list',
            flatPath: 'calendars/{calendarId}/events',
            httpMethod: 'GET',
            description: 'Returns events on the specified calendar.',
            parameters: {
              calendarId: {
                type: 'string',
                description: 'Calendar identifier',
                required: true,
                location: 'path',
              },
              // The reference fixture also carries `minimum: '1'` and
              // `maximum: '2500'`. Discovery does not model them and the
              // converter never reads them, so they are omitted here.
              maxResults: {
                type: 'integer',
                description: 'Maximum number of events returned',
                format: 'int32',
                default: '250',
                location: 'query',
              },
              orderBy: {
                type: 'string',
                description: 'Order of the events returned',
                enum: ['startTime', 'updated'],
                location: 'query',
              },
            },
            response: {$ref: 'Events'},
            scopes: [CALENDAR_SCOPE, CALENDAR_READONLY_SCOPE],
          },
        },
      },
    },
  },
};

const CALENDAR_DISCOVERY_DOCUMENT: DiscoveryDocument = {
  kind: 'discovery#restDescription',
  id: 'calendar:v3',
  name: 'calendar',
  version: 'v3',
  title: 'Google Calendar API',
  description: 'Accesses the Google Calendar API',
  documentationLink: 'https://developers.google.com/calendar/',
  protocol: 'rest',
  rootUrl: 'https://www.googleapis.com/',
  servicePath: 'calendar/v3/',
  auth: {
    oauth2: {
      scopes: {
        [CALENDAR_SCOPE]: {description: 'Full access to Google Calendar'},
        [CALENDAR_READONLY_SCOPE]: {
          description: 'Read-only access to Google Calendar',
        },
      },
    },
  },
  schemas: {
    Calendar: {
      type: 'object',
      description: 'A calendar resource',
      properties: {
        id: {type: 'string', description: 'Calendar identifier'},
        summary: {
          type: 'string',
          description: 'Calendar summary',
          required: true,
        },
        timeZone: {type: 'string', description: 'Calendar timezone'},
      },
    },
    Event: {
      type: 'object',
      description: 'An event resource',
      properties: {
        id: {type: 'string', description: 'Event identifier'},
        summary: {type: 'string', description: 'Event summary'},
        start: {$ref: 'EventDateTime'},
        end: {$ref: 'EventDateTime'},
        attendees: {
          type: 'array',
          description: 'Event attendees',
          items: {$ref: 'EventAttendee'},
        },
      },
    },
    EventDateTime: {
      type: 'object',
      description: 'Date/time for an event',
      properties: {
        dateTime: {
          type: 'string',
          format: 'date-time',
          description: 'Date/time in RFC3339 format',
        },
        timeZone: {
          type: 'string',
          description: 'Timezone for the date/time',
        },
      },
    },
    EventAttendee: {
      type: 'object',
      description: 'An attendee of an event',
      properties: {
        email: {type: 'string', description: 'Attendee email'},
        responseStatus: {
          type: 'string',
          description: 'Response status',
          enum: ['needsAction', 'declined', 'tentative', 'accepted'],
        },
      },
    },
  },
  resources: CALENDAR_RESOURCES,
};

const SCHEMA_OBJECT_CASES: ReadonlyArray<
  [string, DiscoverySchema, ConvertedSchema]
> = [
  [
    'an object, collecting the required property names',
    {
      type: 'object',
      description: 'Test object',
      properties: {
        id: {type: 'string', required: true},
        name: {type: 'string'},
      },
    },
    {
      type: 'object',
      description: 'Test object',
      properties: {id: {type: 'string'}, name: {type: 'string'}},
      required: ['id'],
    },
  ],
  [
    'an array, recursing into items',
    {type: 'array', description: 'Test array', items: {type: 'string'}},
    {type: 'array', description: 'Test array', items: {type: 'string'}},
  ],
  [
    'a bare reference',
    {$ref: 'Calendar'},
    {$ref: '#/components/schemas/Calendar'},
  ],
  [
    'a string with an enum',
    {type: 'string', enum: ['value1', 'value2']},
    {type: 'string', enum: ['value1', 'value2']},
  ],
];

/**
 * Shapes the ported v0.2.0 cases never reach. They live in their own table so
 * the table above stays a faithful transcription of the reference suite.
 */
const SCHEMA_OBJECT_EDGE_CASES: ReadonlyArray<
  [string, DiscoverySchema, ConvertedSchema]
> = [
  [
    'a reference that already starts with #',
    {$ref: '#Calendar'},
    {$ref: '#/components/schemas/Calendar'},
  ],
  [
    'an object with no properties, omitting required',
    {type: 'object'},
    {type: 'object'},
  ],
  ['an array with no items', {type: 'array'}, {type: 'array', items: {}}],
  [
    'the Discovery any type, as a oneOf',
    {type: 'any'},
    {
      oneOf: [
        {type: 'object'},
        {type: 'array', items: {}},
        {type: 'string'},
        {type: 'number'},
        {type: 'boolean'},
      ],
    },
  ],
  ['a boolean', {type: 'boolean'}, {type: 'boolean'}],
  ['a number', {type: 'number'}, {type: 'number'}],
  ['a type OpenAPI 3.0 does not have, by dropping it', {type: 'symbol'}, {}],
];

const PATH_PARAMETER_CASES: ReadonlyArray<[string, string[]]> = [
  ['/calendars/{calendarId}/events/{eventId}', ['calendarId', 'eventId']],
  ['/calendars/events', []],
  ['/users/{userId}/calendars/default', ['userId']],
];

const PARAMETER_SCHEMA_CASES: ReadonlyArray<
  [string, DiscoveryParameter, OpenAPIV3.SchemaObject]
> = [
  [
    'a string with a pattern, dropping the description',
    {type: 'string', description: 'String parameter', pattern: '^[a-z]+$'},
    {type: 'string', pattern: '^[a-z]+$'},
  ],
  [
    'an integer with a format and a default',
    {type: 'integer', format: 'int32', default: '10'},
    {type: 'integer', format: 'int32', default: '10'},
  ],
  [
    'a string with an enum',
    {type: 'string', enum: ['option1', 'option2']},
    {type: 'string', enum: ['option1', 'option2']},
  ],
];

const RESPONSE_CODES = ['200', '400', '401', '403', '404', '500'];

const CALENDAR_REF = {$ref: '#/components/schemas/Calendar'};

function discoveryResponse() {
  return new Response(JSON.stringify(CALENDAR_DISCOVERY_DOCUMENT), {
    status: 200,
    headers: {'content-type': 'application/json'},
  });
}

function stubDiscoveryFetch() {
  const fetchMock = vi.fn(async () => discoveryResponse());
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('GoogleApiToOpenApiConverter', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  describe('fetching', () => {
    it('does not fetch until convert is called', async () => {
      const fetchMock = stubDiscoveryFetch();
      const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');

      expect(fetchMock).not.toHaveBeenCalled();

      await converter.convert();

      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('fetches the discovery document from the discovery service', async () => {
      const fetchMock = stubDiscoveryFetch();

      await new GoogleApiToOpenApiConverter('calendar', 'v3').convert();

      expect(fetchMock).toHaveBeenCalledWith(DISCOVERY_URL);
    });

    it('rejects when the discovery service returns a non-OK status', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response('Not Found', {status: 404})),
      );

      await expect(
        new GoogleApiToOpenApiConverter('calendar', 'v3').convert(),
      ).rejects.toThrow(/404/);
    });
  });

  describe('convertInfo', () => {
    it('maps title, description, version and termsOfService', () => {
      expect(
        convertInfo(CALENDAR_DISCOVERY_DOCUMENT, 'calendar', 'v3'),
      ).toEqual({
        title: 'Google Calendar API',
        description: 'Accesses the Google Calendar API',
        version: 'v3',
        contact: {},
        termsOfService: 'https://developers.google.com/calendar/',
      });
    });

    it('falls back to the api name and version for an empty document', () => {
      expect(convertInfo({}, 'calendar', 'v3')).toEqual({
        title: 'calendar API',
        description: '',
        version: 'v3',
        contact: {},
        termsOfService: '',
      });
      expect(convertExternalDocs({})).toBeUndefined();
    });

    it('emits externalDocs from documentationLink', () => {
      expect(convertExternalDocs(CALENDAR_DISCOVERY_DOCUMENT)).toEqual({
        description: 'API Documentation',
        url: 'https://developers.google.com/calendar/',
      });
    });
  });

  describe('convertServers', () => {
    it('derives one server from rootUrl and servicePath', () => {
      expect(
        convertServers(CALENDAR_DISCOVERY_DOCUMENT, 'calendar', 'v3'),
      ).toEqual([
        {
          url: 'https://www.googleapis.com/calendar/v3',
          description: 'calendar v3 API',
        },
      ]);
    });

    it('keeps a servicePath that has no trailing slash', () => {
      expect(
        convertServers(
          {rootUrl: 'https://example.googleapis.com/', servicePath: 'v1'},
          'example',
          'v1',
        ),
      ).toEqual([
        {
          url: 'https://example.googleapis.com/v1',
          description: 'example v1 API',
        },
      ]);
    });

    it('yields an empty url when the document declares no host', () => {
      expect(convertServers({}, 'calendar', 'v3')).toEqual([
        {url: '', description: 'calendar v3 API'},
      ]);
    });
  });

  describe('convertSecuritySchemes', () => {
    it('emits the oauth2 authorizationCode flow and the apiKey scheme', () => {
      const {securitySchemes, security} = convertSecuritySchemes(
        CALENDAR_DISCOVERY_DOCUMENT,
      );

      expect(securitySchemes['oauth2']).toEqual({
        type: 'oauth2',
        description: 'OAuth 2.0 authentication',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: {
              [CALENDAR_SCOPE]: 'Full access to Google Calendar',
              [CALENDAR_READONLY_SCOPE]: 'Read-only access to Google Calendar',
            },
          },
        },
      });
      expect(securitySchemes['apiKey']).toEqual({
        type: 'apiKey',
        in: 'query',
        name: 'key',
        description: 'API key for accessing this API',
      });
      expect(security).toEqual([
        {oauth2: [CALENDAR_SCOPE, CALENDAR_READONLY_SCOPE]},
        {apiKey: []},
      ]);
    });

    it('emits only the apiKey scheme when the document declares no oauth2', () => {
      const {securitySchemes, security} = convertSecuritySchemes({});

      expect(Object.keys(securitySchemes)).toEqual(['apiKey']);
      expect(security).toEqual([{}, {apiKey: []}]);
    });

    it('defaults a scope with no description to an empty string', () => {
      const {securitySchemes} = convertSecuritySchemes({
        auth: {oauth2: {scopes: {[CALENDAR_SCOPE]: {}}}},
      });

      expect(securitySchemes['oauth2']).toEqual({
        type: 'oauth2',
        description: 'OAuth 2.0 authentication',
        flows: {
          authorizationCode: {
            authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
            tokenUrl: 'https://oauth2.googleapis.com/token',
            scopes: {[CALENDAR_SCOPE]: ''},
          },
        },
      });
    });
  });

  describe('convertSchemas', () => {
    it('maps schemas, refs, arrays, required and enums', () => {
      const schemas = convertSchemas(CALENDAR_DISCOVERY_DOCUMENT);

      const calendar = schemas['Calendar'];
      expect(calendar.type).toBe('object');
      expect(calendar.description).toBe('A calendar resource');
      expect(calendar.required).toEqual(['summary']);

      const event = schemas['Event'];
      expect(event.required).toBeUndefined();
      expect(event.properties?.['start']).toEqual({
        $ref: '#/components/schemas/EventDateTime',
      });

      const attendees = asSchema(event.properties?.['attendees']);
      if (attendees.type !== 'array') {
        expect.fail(
          `expected attendees to be an array schema, got ${String(attendees.type)}`,
        );
      }
      expect(attendees.items).toEqual({
        $ref: '#/components/schemas/EventAttendee',
      });

      const responseStatus = asSchema(
        schemas['EventAttendee'].properties?.['responseStatus'],
      );
      expect(responseStatus.enum).toEqual([
        'needsAction',
        'declined',
        'tentative',
        'accepted',
      ]);
    });
  });

  describe('convertSchemaObject', () => {
    it.each(SCHEMA_OBJECT_CASES)('converts %s', (_name, input, expected) => {
      expect(convertSchemaObject(input)).toEqual(expected);
    });

    it.each(SCHEMA_OBJECT_EDGE_CASES)(
      'converts %s',
      (_name, input, expected) => {
        expect(convertSchemaObject(input)).toEqual(expected);
      },
    );
  });

  describe('extractPathParameters', () => {
    it.each(PATH_PARAMETER_CASES)('extracts %s', (path, expected) => {
      expect(extractPathParameters(path)).toEqual(expected);
    });
  });

  describe('convertParameterSchema', () => {
    it.each(PARAMETER_SCHEMA_CASES)('converts %s', (_name, input, expected) => {
      expect(convertParameterSchema(input)).toEqual(expected);
    });
  });

  describe('convertMethods', () => {
    it("maps a resource's own methods to path operations", () => {
      const paths: OpenAPIV3.PathsObject = {};

      convertMethods(CALENDARS_METHODS, paths);

      const get = operationAt(
        paths,
        '/calendars/{calendarId}',
        OpenAPIV3.HttpMethods.GET,
      );
      expect(get.operationId).toBe('calendar.calendars.get');
      expect(Object.keys(get.responses)).toEqual(RESPONSE_CODES);
      expect(get.security).toEqual([
        {oauth2: [CALENDAR_SCOPE, CALENDAR_READONLY_SCOPE]},
      ]);
      expect(parametersByName(get)).toEqual({
        calendarId: {
          name: 'calendarId',
          in: 'path',
          required: true,
          schema: {type: 'string'},
        },
      });
      expect(responseAt(get, '200').content).toEqual({
        'application/json': {schema: CALENDAR_REF},
      });

      const post = operationAt(paths, '/calendars', OpenAPIV3.HttpMethods.POST);
      expect(post.operationId).toBe('calendar.calendars.insert');
      expect(requestBodyOf(post)).toEqual({
        description: 'Request body',
        required: true,
        content: {'application/json': {schema: CALENDAR_REF}},
      });
      expect(responseAt(post, '200').content).toEqual({
        'application/json': {schema: CALENDAR_REF},
      });
    });

    it('falls back to GET at / for a method that declares nothing', () => {
      const paths: OpenAPIV3.PathsObject = {};

      convertMethods({bare: {}}, paths);

      expect(operationAt(paths, '/', OpenAPIV3.HttpMethods.GET)).toEqual({
        operationId: '',
        summary: '',
        description: '',
        parameters: [],
        responses: {
          '200': {description: 'Successful operation'},
          '400': {description: 'Bad request'},
          '401': {description: 'Unauthorized'},
          '403': {description: 'Forbidden'},
          '404': {description: 'Not found'},
          '500': {description: 'Server error'},
        },
      });
    });

    it('skips a method whose httpMethod is not an OpenAPI verb', () => {
      const paths: OpenAPIV3.PathsObject = {};

      convertMethods({lock: {path: 'calendars', httpMethod: 'LOCK'}}, paths);

      expect(paths).toEqual({});
    });

    it('defaults an underspecified parameter to a required-false query string', () => {
      const paths: OpenAPIV3.PathsObject = {};

      convertMethods(
        {search: {path: 'items', parameters: {filter: {}}, scopes: []}},
        paths,
      );

      const operation = operationAt(paths, '/items', OpenAPIV3.HttpMethods.GET);
      expect(parametersByName(operation)['filter']).toEqual({
        name: 'filter',
        in: 'query',
        description: '',
        required: false,
        schema: {type: 'string'},
      });
      expect(operation.security).toBeUndefined();
    });
  });

  describe('convertResources', () => {
    it('maps nested resources to path operations', () => {
      const paths: OpenAPIV3.PathsObject = {};

      convertResources(CALENDAR_RESOURCES, paths);

      const list = operationAt(
        paths,
        '/calendars/{calendarId}/events',
        OpenAPIV3.HttpMethods.GET,
      );
      expect(list.operationId).toBe('calendar.events.list');
      expect(Object.keys(parametersByName(list))).toEqual([
        'calendarId',
        'maxResults',
        'orderBy',
      ]);
    });

    it('adds no path for a resource with no methods and no children', () => {
      const paths: OpenAPIV3.PathsObject = {};

      convertResources({empty: {}}, paths);

      expect(paths).toEqual({});
    });
  });

  describe('convertDiscoveryDocument', () => {
    it('builds a minimal document and omits externalDocs', () => {
      expect(convertDiscoveryDocument({}, 'calendar', 'v3')).toEqual({
        openapi: '3.0.0',
        info: {
          title: 'calendar API',
          description: '',
          version: 'v3',
          contact: {},
          termsOfService: '',
        },
        servers: [{url: '', description: 'calendar v3 API'}],
        paths: {},
        components: {
          schemas: {},
          securitySchemes: {
            apiKey: {
              type: 'apiKey',
              in: 'query',
              name: 'key',
              description: 'API key for accessing this API',
            },
          },
        },
        security: [{}, {apiKey: []}],
      });
    });

    it('converts methods declared at the top level of the document', () => {
      const spec = convertDiscoveryDocument(
        {methods: {ping: {id: 'example.ping', path: 'ping'}}},
        'example',
        'v1',
      );

      expect(
        operationAt(spec.paths, '/ping', OpenAPIV3.HttpMethods.GET).operationId,
      ).toBe('example.ping');
    });
  });

  describe('convert', () => {
    it('converts the whole document', async () => {
      stubDiscoveryFetch();

      const spec = await new GoogleApiToOpenApiConverter(
        'calendar',
        'v3',
      ).convert();

      expect(spec.openapi).toBe('3.0.0');
      expect(spec.info.title).toBe('Google Calendar API');
      expect(spec.servers).toHaveLength(1);
      expect(spec.components).toBeDefined();
      expect(Object.keys(spec.paths)).toHaveLength(3);

      const get = operationAt(
        spec.paths,
        '/calendars/{calendarId}',
        OpenAPIV3.HttpMethods.GET,
      );
      expect(get.operationId).toBe('calendar.calendars.get');
      expect(Object.keys(parametersByName(get))).toEqual(['calendarId']);
      expect(responseAt(get, '200').content).toEqual({
        'application/json': {schema: CALENDAR_REF},
      });

      const post = operationAt(
        spec.paths,
        '/calendars',
        OpenAPIV3.HttpMethods.POST,
      );
      expect(requestBodyOf(post)).toEqual({
        description: 'Request body',
        required: true,
        content: {'application/json': {schema: CALENDAR_REF}},
      });

      operationAt(
        spec.paths,
        '/calendars/{calendarId}/events',
        OpenAPIV3.HttpMethods.GET,
      );
    });

    it('converts the Calendar discovery document end to end', async () => {
      stubDiscoveryFetch();

      const spec = await new GoogleApiToOpenApiConverter(
        'calendar',
        'v3',
      ).convert();

      expect(spec.servers?.[0]?.url).toBe(
        'https://www.googleapis.com/calendar/v3',
      );
      expect(
        Object.keys(spec.components?.securitySchemes ?? {}).sort(),
      ).toEqual(['apiKey', 'oauth2']);
      expect(Object.keys(spec.components?.schemas ?? {}).sort()).toEqual([
        'Calendar',
        'Event',
        'EventAttendee',
        'EventDateTime',
      ]);

      const list = operationAt(
        spec.paths,
        '/calendars/{calendarId}/events',
        OpenAPIV3.HttpMethods.GET,
      );
      expect(list.operationId).toBe('calendar.events.list');

      const maxResults = parametersByName(list)['maxResults'];
      expect(maxResults.in).toBe('query');

      const schema = asSchema(maxResults.schema);
      expect(schema.type).toBe('integer');
      expect(schema.default).toBe('250');
    });
  });
});

/**
 * The converter emits `$ref` beside real keywords, so the presence of `$ref`
 * alone does not discriminate the two members of the union: only a lone `$ref`
 * is a reference.
 */
function isSchemaObject(
  value: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject,
): value is OpenAPIV3.SchemaObject {
  return !('$ref' in value) || Object.keys(value).length > 1;
}

function asSchema(
  value: OpenAPIV3.SchemaObject | OpenAPIV3.ReferenceObject | undefined,
): OpenAPIV3.SchemaObject {
  if (value === undefined || !isSchemaObject(value)) {
    expect.fail(`expected an inline schema, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** Reads one operation out of a paths object, failing the test when absent. */
function operationAt(
  paths: OpenAPIV3.PathsObject,
  path: string,
  method: OpenAPIV3.HttpMethods,
): OpenAPIV3.OperationObject {
  const operation = paths[path]?.[method];
  if (operation === undefined) {
    expect.fail(`expected a ${method} operation at ${path}`);
  }
  return operation;
}

/** `ReferenceObject` has no `name`, so `'name' in p` discriminates the union. */
function parametersByName(
  operation: OpenAPIV3.OperationObject,
): Record<string, OpenAPIV3.ParameterObject> {
  const byName: Record<string, OpenAPIV3.ParameterObject> = {};
  for (const parameter of operation.parameters ?? []) {
    if ('name' in parameter) {
      byName[parameter.name] = parameter;
    }
  }
  return byName;
}

/** `RequestBodyObject` declares no `$ref`, so `'$ref' in body` discriminates. */
function requestBodyOf(
  operation: OpenAPIV3.OperationObject,
): OpenAPIV3.RequestBodyObject {
  const body = operation.requestBody;
  if (body === undefined || '$ref' in body) {
    expect.fail('expected an inline requestBody');
  }
  return body;
}

/** `ResponseObject` declares no `$ref`, so `'$ref' in response` discriminates. */
function responseAt(
  operation: OpenAPIV3.OperationObject,
  code: string,
): OpenAPIV3.ResponseObject {
  const response = operation.responses[code];
  if (response === undefined || '$ref' in response) {
    expect.fail(`expected an inline ${code} response`);
  }
  return response;
}
