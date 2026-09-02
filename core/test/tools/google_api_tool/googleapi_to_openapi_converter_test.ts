/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DiscoveryDocument,
  DiscoveryParameter,
  DiscoverySchema,
  GoogleApiToOpenApiConverter,
  convertDiscoveryDocument,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  ConvertedSchema,
  convertExternalDocs,
  convertInfo,
  convertMethods,
  convertOperation,
  convertParameterSchema,
  convertResources,
  convertSchemaObject,
  convertSchemas,
  convertSecuritySchemes,
  convertServers,
  extractPathParameters,
} from '../../../src/tools/google_api_tool/googleapi_to_openapi_converter.js';
import {
  CALENDAR_DISCOVERY_DOCUMENT,
  DOCS_DISCOVERY_DOCUMENT,
} from './discovery_fixtures.js';
import {capturedRequest, respondWith} from './https_transport_fake.js';
import {
  asReference,
  asSchema,
  operationAt,
  parametersByName,
  requestBodyOf,
  responseAt,
} from './openapi_narrowing.js';

const {requestMock, agentMock, loadCertsMock} = vi.hoisted(() => ({
  requestMock: vi.fn(),
  agentMock: vi.fn(),
  loadCertsMock: vi.fn(),
}));

vi.mock('node:https', () => ({request: requestMock, Agent: agentMock}));

vi.mock('../../../src/utils/mtls_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../../src/utils/mtls_utils.js')>();
  return {...actual, loadDefaultClientCerts: loadCertsMock};
});

const CLIENT_CERTS = {
  cert: '-----BEGIN CERTIFICATE-----\nfake\n-----END CERTIFICATE-----',
  key: '-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----',
  passphrase: 'secret',
};

describe('convertInfo', () => {
  it('copies the discovery metadata', () => {
    const info = convertInfo(CALENDAR_DISCOVERY_DOCUMENT, 'calendar', 'v3');

    expect(info).toEqual({
      title: 'Google Calendar API',
      description: 'Accesses the Google Calendar API',
      version: 'v3',
      contact: {},
      termsOfService: 'https://developers.google.com/calendar/',
    });
  });

  it('falls back to the api name and requested version', () => {
    const info = convertInfo({}, 'calendar', 'v3');

    expect(info).toEqual({
      title: 'calendar API',
      description: '',
      version: 'v3',
      contact: {},
      termsOfService: '',
    });
  });
});

describe('convertExternalDocs', () => {
  it('points at the documentation link', () => {
    expect(convertExternalDocs(CALENDAR_DISCOVERY_DOCUMENT)).toEqual({
      description: 'API Documentation',
      url: 'https://developers.google.com/calendar/',
    });
  });

  it('returns undefined without a documentation link', () => {
    expect(convertExternalDocs({})).toBeUndefined();
  });
});

describe('convertServers', () => {
  it('joins the root URL and service path', () => {
    expect(
      convertServers(CALENDAR_DISCOVERY_DOCUMENT, 'calendar', 'v3'),
    ).toEqual([
      {
        url: 'https://www.googleapis.com/calendar/v3',
        description: 'calendar v3 API',
      },
    ]);
  });

  it('strips the trailing slash of an empty service path', () => {
    expect(convertServers(DOCS_DISCOVERY_DOCUMENT, 'docs', 'v1')).toEqual([
      {url: 'https://docs.googleapis.com', description: 'docs v1 API'},
    ]);
  });

  it('produces an empty URL for a document with no root URL', () => {
    expect(convertServers({}, 'calendar', 'v3')).toEqual([
      {url: '', description: 'calendar v3 API'},
    ]);
  });

  const MTLS_DOC = {
    rootUrl: 'https://www.googleapis.com/',
    mtlsRootUrl: 'https://www.mtls.googleapis.com/',
    servicePath: 'calendar/v3/',
  };

  it('uses the mTLS root URL when a client certificate is asked for', () => {
    expect(convertServers(MTLS_DOC, 'calendar', 'v3', true)).toEqual([
      {
        url: 'https://www.mtls.googleapis.com/calendar/v3',
        description: 'calendar v3 API',
      },
    ]);
  });

  it('keeps the plain root URL when no client certificate is asked for', () => {
    expect(convertServers(MTLS_DOC, 'calendar', 'v3', false)).toEqual([
      {
        url: 'https://www.googleapis.com/calendar/v3',
        description: 'calendar v3 API',
      },
    ]);
  });

  it('keeps the plain root URL when the document declares no mTLS host', () => {
    const {rootUrl, servicePath} = MTLS_DOC;

    expect(
      convertServers({rootUrl, servicePath}, 'calendar', 'v3', true),
    ).toEqual([
      {
        url: 'https://www.googleapis.com/calendar/v3',
        description: 'calendar v3 API',
      },
    ]);
  });
});

describe('convertSecuritySchemes', () => {
  it('converts the oauth2 scopes and always adds the api key scheme', () => {
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
            'https://www.googleapis.com/auth/calendar':
              'Full access to Google Calendar',
            'https://www.googleapis.com/auth/calendar.readonly':
              'Read-only access to Google Calendar',
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
      {
        oauth2: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
      },
      {apiKey: []},
    ]);
  });

  it('defaults a scope with no description to an empty string', () => {
    const {securitySchemes} = convertSecuritySchemes({
      auth: {oauth2: {scopes: {'https://example.com/auth/scope': {}}}},
    });
    const scheme = securitySchemes['oauth2'];
    if (scheme.type !== 'oauth2') {
      return expect.fail('expected an oauth2 scheme');
    }

    expect(scheme.flows.authorizationCode?.scopes).toEqual({
      'https://example.com/auth/scope': '',
    });
  });

  it('emits an empty scope map for an oauth2 block with no scopes', () => {
    const {securitySchemes, security} = convertSecuritySchemes({
      auth: {oauth2: {}},
    });
    const scheme = securitySchemes['oauth2'];
    if (scheme.type !== 'oauth2') {
      return expect.fail('expected an oauth2 scheme');
    }

    expect(scheme.flows.authorizationCode?.scopes).toEqual({});
    expect(security).toEqual([{oauth2: []}, {apiKey: []}]);
  });

  it('emits no oauth2 scheme when the document declares no auth', () => {
    const {securitySchemes, security} = convertSecuritySchemes({});

    expect(securitySchemes['oauth2']).toBeUndefined();
    expect(Object.keys(securitySchemes)).toEqual(['apiKey']);
    expect(security).toEqual([{}, {apiKey: []}]);
  });
});

describe('convertSchemas', () => {
  it('converts the calendar schemas', () => {
    const schemas = convertSchemas(CALENDAR_DISCOVERY_DOCUMENT);

    const calendar = asSchema(schemas['Calendar']);
    expect(calendar.type).toBe('object');
    expect(calendar.description).toBe('A calendar resource');
    expect(calendar.required).toEqual(['summary']);

    const event = asSchema(schemas['Event']);
    expect(asReference(event.properties?.['start']).$ref).toBe(
      '#/components/schemas/EventDateTime',
    );

    const attendees = asSchema(event.properties?.['attendees']);
    expect(attendees.type).toBe('array');
    if (attendees.type !== 'array') {
      return expect.fail('expected an array schema');
    }
    expect(asReference(attendees.items).$ref).toBe(
      '#/components/schemas/EventAttendee',
    );

    const attendee = asSchema(schemas['EventAttendee']);
    const responseStatus = asSchema(attendee.properties?.['responseStatus']);
    expect(responseStatus.enum).toContain('accepted');
  });

  it('returns an empty map for a document with no schemas', () => {
    expect(convertSchemas({})).toEqual({});
  });
});

describe('convertSchemaObject', () => {
  const cases: Array<{
    name: string;
    schemaDef: DiscoverySchema;
    expected: ConvertedSchema;
  }> = [
    {
      name: 'an object with a required property',
      schemaDef: {
        type: 'object',
        description: 'Test object',
        properties: {
          id: {type: 'string', required: true},
          name: {type: 'string'},
        },
      },
      expected: {
        type: 'object',
        properties: {id: {type: 'string'}, name: {type: 'string'}},
        required: ['id'],
        description: 'Test object',
      },
    },
    {
      name: 'an object with no required property',
      schemaDef: {type: 'object', properties: {name: {type: 'string'}}},
      expected: {type: 'object', properties: {name: {type: 'string'}}},
    },
    {
      name: 'an object with no properties',
      schemaDef: {type: 'object'},
      expected: {type: 'object'},
    },
    {
      name: 'an array of strings',
      schemaDef: {
        type: 'array',
        description: 'Test array',
        items: {type: 'string'},
      },
      expected: {
        type: 'array',
        items: {type: 'string'},
        description: 'Test array',
      },
    },
    {
      name: 'an array with no declared items',
      schemaDef: {type: 'array'},
      expected: {type: 'array', items: {}},
    },
    {
      name: 'a discovery reference',
      schemaDef: {$ref: 'Calendar'},
      expected: {$ref: '#/components/schemas/Calendar'},
    },
    {
      name: 'a reference already anchored at the document root',
      schemaDef: {$ref: '#Calendar'},
      expected: {$ref: '#/components/schemas/Calendar'},
    },
    {
      name: 'a reference alongside a description',
      schemaDef: {$ref: 'Calendar', description: 'The calendar'},
      expected: {
        $ref: '#/components/schemas/Calendar',
        description: 'The calendar',
      },
    },
    {
      name: 'a reference alongside every sibling key discovery states',
      schemaDef: {
        $ref: 'Calendar',
        type: 'string',
        format: 'date-time',
        description: 'The calendar',
        enum: ['a', 'b'],
        pattern: '^c',
        default: 'a',
      },
      expected: {
        $ref: '#/components/schemas/Calendar',
        type: 'string',
        format: 'date-time',
        description: 'The calendar',
        enum: ['a', 'b'],
        pattern: '^c',
        default: 'a',
      },
    },
    {
      name: 'an enum',
      schemaDef: {type: 'string', enum: ['value1', 'value2']},
      expected: {type: 'string', enum: ['value1', 'value2']},
    },
    {
      name: 'the any type',
      schemaDef: {type: 'any'},
      expected: {
        oneOf: [
          {type: 'object'},
          {type: 'array', items: {}},
          {type: 'string'},
          {type: 'number'},
          {type: 'boolean'},
          {enum: [null]},
        ],
      },
    },
    {
      name: 'a type outside the discovery vocabulary',
      schemaDef: {type: 'quaternion', description: 'unknown'},
      expected: {description: 'unknown'},
    },
    {
      name: 'a definition with no type at all',
      schemaDef: {description: 'untyped'},
      expected: {description: 'untyped'},
    },
    {
      name: 'the format, pattern and default keys',
      schemaDef: {
        type: 'integer',
        format: 'int32',
        pattern: '^[0-9]+$',
        default: '250',
      },
      expected: {
        type: 'integer',
        format: 'int32',
        pattern: '^[0-9]+$',
        default: '250',
      },
    },
  ];

  it.each(cases)('converts $name', ({schemaDef, expected}) => {
    expect(convertSchemaObject(schemaDef)).toEqual(expected);
  });

  it('constrains every alternative of the any type', () => {
    const oneOf = asSchema(convertSchemaObject({type: 'any'})).oneOf ?? [];

    expect(oneOf.length).toBeGreaterThan(0);
    for (const alternative of oneOf) {
      // `oneOf` matches exactly one alternative. An alternative that declares
      // neither `type` nor `enum` matches every value, so every other value
      // matches twice and the schema then rejects it.
      const schema = asSchema(alternative);
      expect(schema.type ?? schema.enum).toBeDefined();
    }
  });

  it('does not expand a dollar pattern in a reference name', () => {
    expect(convertSchemaObject({$ref: "$&Calendar$'"})).toEqual({
      $ref: "#/components/schemas/$&Calendar$'",
    });
  });

  it('converts nested properties recursively', () => {
    const converted = asSchema(
      convertSchemaObject({
        type: 'object',
        properties: {
          outer: {type: 'object', properties: {inner: {type: 'boolean'}}},
        },
      }),
    );

    const outer = asSchema(converted.properties?.['outer']);
    expect(asSchema(outer.properties?.['inner']).type).toBe('boolean');
  });
});

describe('extractPathParameters', () => {
  const cases: Array<{path: string; expected: string[]}> = [
    {
      path: '/calendars/{calendarId}/events/{eventId}',
      expected: ['calendarId', 'eventId'],
    },
    {path: '/calendars/events', expected: []},
    {path: '/users/{userId}/calendars/default', expected: ['userId']},
    {path: '/v1/documents/{documentId}:batchUpdate', expected: []},
  ];

  it.each(cases)('extracts $expected from $path', ({path, expected}) => {
    expect(extractPathParameters(path)).toEqual(expected);
  });
});

describe('convertParameterSchema', () => {
  const cases: Array<{
    name: string;
    param: DiscoveryParameter;
    expected: OpenAPIV3.SchemaObject;
  }> = [
    {
      name: 'a string with a pattern',
      param: {
        type: 'string',
        description: 'String parameter',
        pattern: '^[a-z]+$',
      },
      expected: {type: 'string', pattern: '^[a-z]+$'},
    },
    {
      name: 'an integer with a format and default',
      param: {type: 'integer', format: 'int32', default: '10'},
      expected: {type: 'integer', format: 'int32', default: '10'},
    },
    {
      name: 'an enum',
      param: {type: 'string', enum: ['option1', 'option2']},
      expected: {type: 'string', enum: ['option1', 'option2']},
    },
    {
      name: 'a parameter with no declared type',
      param: {description: 'untyped'},
      expected: {type: 'string'},
    },
    {
      name: 'a repeated parameter',
      param: {type: 'array'},
      expected: {type: 'array', items: {}},
    },
  ];

  it.each(cases)('converts $name', ({param, expected}) => {
    expect(convertParameterSchema(param)).toEqual(expected);
  });

  it('ignores properties declared on a parameter', () => {
    expect(
      convertParameterSchema({
        type: 'object',
        properties: {ignored: {type: 'string'}},
      }),
    ).toEqual({type: 'object'});
  });
});

describe('convertOperation', () => {
  it('declares the fixed response set', () => {
    const operation = convertOperation({id: 'a.b'}, []);

    expect(operation.responses).toEqual({
      '200': {description: 'Successful operation'},
      '400': {description: 'Bad request'},
      '401': {description: 'Unauthorized'},
      '403': {description: 'Forbidden'},
      '404': {description: 'Not found'},
      '500': {description: 'Server error'},
    });
    expect(operation.operationId).toBe('a.b');
    expect(operation.summary).toBe('');
    expect(operation.description).toBe('');
    expect(operation.parameters).toEqual([]);
    expect(operation.security).toBeUndefined();
    expect(operation.requestBody).toBeUndefined();
  });

  it('keeps the response content of one operation out of the next', () => {
    convertOperation({response: {$ref: 'Calendar'}}, []);
    const second = convertOperation({}, []);

    expect(responseAt(second, '200').content).toBeUndefined();
  });

  it('defaults an operation with no id to an empty operation id', () => {
    expect(convertOperation({}, []).operationId).toBe('');
  });

  it('declares a path parameter for every extracted placeholder', () => {
    const operation = convertOperation({}, ['calendarId', 'eventId']);

    expect(operation.parameters).toEqual([
      {
        name: 'calendarId',
        in: 'path',
        required: true,
        schema: {type: 'string'},
      },
      {name: 'eventId', in: 'path', required: true, schema: {type: 'string'}},
    ]);
  });

  it('does not declare a path parameter twice', () => {
    const operation = convertOperation(
      {parameters: {calendarId: {type: 'string', location: 'path'}}},
      ['calendarId'],
    );

    expect(operation.parameters).toHaveLength(1);
  });

  it('defaults a declared parameter to a non-required query parameter', () => {
    const operation = convertOperation({parameters: {q: {type: 'string'}}}, []);

    expect(operation.parameters).toEqual([
      {
        name: 'q',
        in: 'query',
        description: '',
        required: false,
        schema: {type: 'string'},
      },
    ]);
  });

  it('ignores an empty scope list', () => {
    expect(convertOperation({scopes: []}, []).security).toBeUndefined();
  });

  it('ignores a request or response without a reference', () => {
    const operation = convertOperation({request: {}, response: {}}, []);

    expect(operation.requestBody).toBeUndefined();
    expect(responseAt(operation, '200').content).toBeUndefined();
  });
});

describe('convertMethods', () => {
  it('converts the calendar resource methods', () => {
    const paths: OpenAPIV3.PathsObject = {};
    convertMethods(
      CALENDAR_DISCOVERY_DOCUMENT.resources?.['calendars']?.methods ?? {},
      paths,
    );

    const get = operationAt(paths, '/calendars/{calendarId}', 'get');
    expect(get.operationId).toBe('calendar.calendars.get');
    expect(Object.keys(parametersByName(get))).toEqual(['calendarId']);
    expect(get.security).toEqual([
      {
        oauth2: [
          'https://www.googleapis.com/auth/calendar',
          'https://www.googleapis.com/auth/calendar.readonly',
        ],
      },
    ]);

    const post = operationAt(paths, '/calendars', 'post');
    expect(post.operationId).toBe('calendar.calendars.insert');
    expect(
      asReference(requestBodyOf(post).content['application/json'].schema).$ref,
    ).toBe('#/components/schemas/Calendar');
    expect(
      asReference(responseAt(post, '200').content?.['application/json'].schema)
        .$ref,
    ).toBe('#/components/schemas/Calendar');
  });

  it('prefers flatPath over path', () => {
    const paths: OpenAPIV3.PathsObject = {};
    convertMethods(
      {
        list: {
          id: 'a.list',
          path: 'v1/{+parent}/items',
          flatPath: 'v1/projects/{projectId}/items',
          httpMethod: 'GET',
        },
      },
      paths,
    );

    expect(Object.keys(paths)).toEqual(['/v1/projects/{projectId}/items']);
  });

  it('falls back to path, then to the root path', () => {
    const paths: OpenAPIV3.PathsObject = {};
    convertMethods(
      {
        withPath: {id: 'a.withPath', path: 'items', httpMethod: 'GET'},
        withNeither: {id: 'a.withNeither', httpMethod: 'POST'},
      },
      paths,
    );

    expect(Object.keys(paths).sort()).toEqual(['/', '/items']);
    expect(operationAt(paths, '/', 'post').operationId).toBe('a.withNeither');
  });

  it('defaults a method with no http method to get', () => {
    const paths: OpenAPIV3.PathsObject = {};
    convertMethods({read: {id: 'a.read', flatPath: '/items'}}, paths);

    expect(operationAt(paths, '/items', 'get').operationId).toBe('a.read');
  });

  it('merges two methods that share a path', () => {
    const paths: OpenAPIV3.PathsObject = {};
    convertMethods(
      {
        get: {id: 'a.get', flatPath: '/items', httpMethod: 'GET'},
        create: {id: 'a.create', flatPath: '/items', httpMethod: 'POST'},
      },
      paths,
    );

    expect(Object.keys(paths)).toEqual(['/items']);
    expect(Object.keys(paths['/items'] ?? {}).sort()).toEqual(['get', 'post']);
  });

  it('skips a method whose verb no path item can describe', () => {
    const paths: OpenAPIV3.PathsObject = {};
    convertMethods(
      {
        frob: {id: 'a.frob', flatPath: '/items', httpMethod: 'FROB'},
        get: {id: 'a.get', flatPath: '/items', httpMethod: 'GET'},
      },
      paths,
    );

    expect(Object.keys(paths['/items'] ?? {})).toEqual(['get']);
  });
});

describe('convertResources', () => {
  it('walks nested resources', () => {
    const paths: OpenAPIV3.PathsObject = {};
    convertResources(CALENDAR_DISCOVERY_DOCUMENT.resources ?? {}, paths);

    expect(Object.keys(paths).sort()).toEqual([
      '/calendars',
      '/calendars/{calendarId}',
      '/calendars/{calendarId}/events',
    ]);

    const events = operationAt(paths, '/calendars/{calendarId}/events', 'get');
    expect(events.operationId).toBe('calendar.events.list');
    expect(Object.keys(parametersByName(events)).sort()).toEqual([
      'calendarId',
      'maxResults',
      'orderBy',
    ]);
  });

  it('tolerates a resource with neither methods nor sub-resources', () => {
    const paths: OpenAPIV3.PathsObject = {};
    convertResources({empty: {}}, paths);

    expect(paths).toEqual({});
  });
});

describe('convertDiscoveryDocument', () => {
  it('converts the calendar document end to end', () => {
    const spec = convertDiscoveryDocument(
      CALENDAR_DISCOVERY_DOCUMENT,
      'calendar',
      'v3',
    );

    expect(spec.openapi).toBe('3.0.0');
    expect(spec.info.title).toBe('Google Calendar API');
    expect(spec.servers?.[0].url).toBe(
      'https://www.googleapis.com/calendar/v3',
    );
    expect(spec.externalDocs).toEqual({
      description: 'API Documentation',
      url: 'https://developers.google.com/calendar/',
    });
    expect(Object.keys(spec.components?.securitySchemes ?? {}).sort()).toEqual([
      'apiKey',
      'oauth2',
    ]);
    expect(Object.keys(spec.components?.schemas ?? {}).sort()).toEqual([
      'Calendar',
      'Event',
      'EventAttendee',
      'EventDateTime',
    ]);
    expect(Object.keys(spec.paths).sort()).toEqual([
      '/calendars',
      '/calendars/{calendarId}',
      '/calendars/{calendarId}/events',
    ]);

    const events = operationAt(
      spec.paths,
      '/calendars/{calendarId}/events',
      'get',
    );
    const maxResults = parametersByName(events)['maxResults'];
    expect(maxResults.in).toBe('query');
    expect(asSchema(maxResults.schema)).toEqual({
      type: 'integer',
      format: 'int32',
      default: '250',
    });
  });

  it('converts top-level methods that belong to no resource', () => {
    const doc: DiscoveryDocument = {
      methods: {ping: {id: 'svc.ping', flatPath: 'ping', httpMethod: 'GET'}},
    };

    const spec = convertDiscoveryDocument(doc, 'svc', 'v1');

    expect(operationAt(spec.paths, '/ping', 'get').operationId).toBe(
      'svc.ping',
    );
  });

  it('omits externalDocs when the document has no documentation link', () => {
    const spec = convertDiscoveryDocument({}, 'svc', 'v1');

    expect('externalDocs' in spec).toBe(false);
    expect(spec.paths).toEqual({});
  });
});

describe('GoogleApiToOpenApiConverter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
    stubDiscoveryResponse(CALENDAR_DISCOVERY_DOCUMENT);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];
  });

  /** Makes the mocked transport answer with `document`. */
  function stubDiscoveryResponse(document: DiscoveryDocument): void {
    respondWith(requestMock, {
      statusCode: 200,
      body: JSON.stringify(document),
    });
  }

  it('fetches and converts the discovery document', async () => {
    const spec = await new GoogleApiToOpenApiConverter(
      'calendar',
      'v3',
    ).convert();

    expect(spec.info.title).toBe('Google Calendar API');
    expect(capturedRequest(requestMock).url).toBe(
      'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
    );
  });

  it('honours a custom discovery URL template', async () => {
    await new GoogleApiToOpenApiConverter('calendar', 'v3', {
      discoveryUrl: 'https://private.example.com/{api}/{apiVersion}',
    }).convert();

    expect(capturedRequest(requestMock).url).toBe(
      'https://private.example.com/calendar/v3',
    );
    expect(capturedRequest(requestMock).options.agent).toBeUndefined();
  });

  it('propagates a discovery fetch failure', async () => {
    respondWith(requestMock, {statusCode: 500, body: '{}'});

    await expect(
      new GoogleApiToOpenApiConverter('calendar', 'v3').convert(),
    ).rejects.toThrow('HTTP 500');
  });

  it('fetches the document only once across convert calls', async () => {
    const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');

    await converter.convert();
    await converter.convert();

    expect(requestMock).toHaveBeenCalledTimes(1);
  });

  it('leaves no document behind when the fetch fails', async () => {
    respondWith(requestMock, {statusCode: 500, body: '{}'});
    const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');

    await expect(converter.convert()).rejects.toThrow('HTTP 500');

    stubDiscoveryResponse(CALENDAR_DISCOVERY_DOCUMENT);
    expect((await converter.convert()).info.title).toBe('Google Calendar API');
  });

  describe('with a client certificate', () => {
    beforeEach(() => {
      process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'] = 'true';
      loadCertsMock.mockResolvedValue(CLIENT_CERTS);
    });

    it('fetches from the mTLS host and presents the certificate', async () => {
      await new GoogleApiToOpenApiConverter('calendar', 'v3').convert();

      expect(capturedRequest(requestMock).url).toBe(
        'https://www.mtls.googleapis.com/discovery/v1/apis/calendar/v3/rest',
      );
      expect(agentMock).toHaveBeenCalledWith({
        cert: CLIENT_CERTS.cert,
        key: CLIENT_CERTS.key,
        passphrase: CLIENT_CERTS.passphrase,
      });
    });

    it('succeeds when the certificate has no passphrase', async () => {
      const {cert, key} = CLIENT_CERTS;
      loadCertsMock.mockResolvedValue({cert, key});

      const spec = await new GoogleApiToOpenApiConverter(
        'calendar',
        'v3',
      ).convert();

      expect(spec.info.title).toBe('Google Calendar API');
      expect(agentMock).toHaveBeenCalledWith({
        cert,
        key,
        passphrase: undefined,
      });
    });

    it('serves the mTLS root URL from the converted document', async () => {
      stubDiscoveryResponse({
        rootUrl: 'https://www.googleapis.com/',
        mtlsRootUrl: 'https://www.mtls.googleapis.com/',
        servicePath: 'calendar/v3/',
      });

      const spec = await new GoogleApiToOpenApiConverter(
        'calendar',
        'v3',
      ).convert();

      expect(spec.servers).toEqual([
        {
          url: 'https://www.mtls.googleapis.com/calendar/v3',
          description: 'calendar v3 API',
        },
      ]);
    });

    it('falls back to the plain host when the machine has no certificate', async () => {
      loadCertsMock.mockResolvedValue(undefined);

      await new GoogleApiToOpenApiConverter('calendar', 'v3').convert();

      expect(capturedRequest(requestMock).url).toBe(
        'https://www.googleapis.com/discovery/v1/apis/calendar/v3/rest',
      );
      expect(agentMock).not.toHaveBeenCalled();
    });

    it('propagates a certificate loading failure', async () => {
      loadCertsMock.mockRejectedValue(new Error('cert provider exploded'));

      await expect(
        new GoogleApiToOpenApiConverter('calendar', 'v3').convert(),
      ).rejects.toThrow('cert provider exploded');
    });

    it('ignores a later change to the environment', async () => {
      const converter = new GoogleApiToOpenApiConverter('calendar', 'v3');
      delete process.env['GOOGLE_API_USE_CLIENT_CERTIFICATE'];

      await converter.convert();

      expect(loadCertsMock).toHaveBeenCalledTimes(1);
    });
  });
});
