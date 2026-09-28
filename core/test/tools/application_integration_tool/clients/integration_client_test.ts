/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InputValidationError,
  IntegrationClient,
  IntegrationClientOptions,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const getAccessToken = vi.fn();
const getProjectId = vi.fn();
const quotaProjectId = vi.fn();
/** Counts credential resolutions. One `ApiTransport` resolves once. */
const authClientRequests = vi.fn();
const googleAuthOptions = vi.fn();
const jwtOptions = vi.fn();

vi.mock('google-auth-library', () => ({
  GoogleAuth: class {
    constructor(options: unknown) {
      googleAuthOptions(options);
    }
    getClient() {
      authClientRequests();
      return Promise.resolve({
        getAccessToken,
        quotaProjectId: quotaProjectId(),
      });
    }
    getProjectId() {
      return getProjectId();
    }
  },
  JWT: class {
    constructor(options: unknown) {
      jwtOptions(options);
    }
    getAccessToken() {
      return getAccessToken();
    }
  },
}));

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const GENERATE_SPEC_URL =
  'https://us-central1-integrations.googleapis.com/v1/projects/test-project/' +
  'locations/us-central1:generateOpenApiSpec';

const MTLS_GENERATE_SPEC_URL =
  'https://us-central1-integrations.mtls.googleapis.com/v1/projects/' +
  'test-project/locations/us-central1:generateOpenApiSpec';

/**
 * The smallest spec the client accepts. An OpenAPI document needs a version,
 * an info object and paths.
 */
const EMPTY_SPEC =
  '{"openapi":"3.0.1","info":{"title":"x","version":"1"},"paths":{}}';

const ENTITY_SCHEMA = {
  type: 'object',
  properties: {id: {type: 'string'}},
};

/** A complete service account key file, as the parser requires. */
const SERVICE_ACCOUNT_KEY = JSON.stringify({
  type: 'service_account',
  project_id: 'key-project',
  private_key_id: 'test-key-id',
  private_key: 'test-key',
  client_email: 'test@example.com',
  client_id: 'test-client-id',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/sa',
  universe_domain: 'googleapis.com',
});

function jsonResponse(body: unknown, init: {status?: number} = {}) {
  const status = init.status ?? 200;
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: async () => body,
  };
}

/** Answers a request by the first route whose fragment the URL contains. */
function routedFetch(routes: Array<[string, unknown]>) {
  return vi.fn().mockImplementation((url: string) => {
    for (const [fragment, body] of routes) {
      if (url.includes(fragment)) {
        return Promise.resolve(jsonResponse(body));
      }
    }
    return Promise.reject(new Error(`unexpected request: ${url}`));
  });
}

function connectorRoutes(
  options: {
    operations?: string[];
    actionResponse?: Record<string, unknown>;
  } = {},
): Array<[string, unknown]> {
  return [
    [':getEntityType', {name: 'operations/entity'}],
    [':getAction', {name: 'operations/action'}],
    [
      '/v1/operations/entity',
      {
        done: true,
        response: {
          jsonSchema: ENTITY_SCHEMA,
          operations: options.operations ?? ['LIST', 'GET'],
        },
      },
    ],
    [
      '/v1/operations/action',
      {
        done: true,
        response: options.actionResponse ?? {
          inputJsonSchema: {type: 'object'},
          outputJsonSchema: {type: 'string'},
          displayName: 'Custom Action',
        },
      },
    ],
  ];
}

function createClient(
  options: Partial<IntegrationClientOptions> = {},
): IntegrationClient {
  return new IntegrationClient({
    project: 'test-project',
    location: 'us-central1',
    ...options,
  });
}

/** Reads and decodes the JSON body a mocked fetch call carried. */
function requestBody(init: unknown): unknown {
  const body =
    typeof init === 'object' && init !== null
      ? (init as {body?: unknown}).body
      : undefined;
  if (typeof body !== 'string') {
    return expect.fail('the request carried no JSON body');
  }
  return JSON.parse(body);
}

/** Returns the path item at `path`, failing the test when it is absent. */
function pathItem(
  spec: OpenAPIV3.Document,
  path: string,
): OpenAPIV3.PathItemObject {
  const item = spec.paths[path];
  if (!item) {
    return expect.fail(`the spec declares no path ${path}`);
  }
  return item;
}

describe('IntegrationClient', () => {
  beforeEach(() => {
    getAccessToken.mockResolvedValue({token: 'test_token'});
    getProjectId.mockResolvedValue('adc-project');
    quotaProjectId.mockReturnValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  describe('configuration defaults', () => {
    it('treats an unconfigured client as having no operations and no actions', async () => {
      globalThis.fetch = vi.fn();

      await expect(
        createClient({
          connection: 'test-connection',
        }).getOpenApiSpecForConnection(),
      ).rejects.toThrow(
        new InputValidationError(
          'No entity operations or actions provided. Please provide at least' +
            ' one of them.',
        ),
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('reads no action schema when only entity operations are configured', async () => {
      const fetchMock = routedFetch(connectorRoutes());
      globalThis.fetch = fetchMock;

      await createClient({
        connection: 'test-connection',
        entityOperations: {Issues: ['LIST']},
      }).getOpenApiSpecForConnection();

      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes(':getAction'))).toBe(false);
    });

    it('reads no entity schema when only actions are configured', async () => {
      const fetchMock = routedFetch(connectorRoutes());
      globalThis.fetch = fetchMock;

      await createClient({
        connection: 'test-connection',
        actions: ['CustomAction'],
      }).getOpenApiSpecForConnection();

      const urls = fetchMock.mock.calls.map((call) => String(call[0]));
      expect(urls.some((url) => url.includes(':getEntityType'))).toBe(false);
    });
  });

  describe('getOpenApiSpecForIntegration', () => {
    it('posts the trigger resources and parses the returned spec', async () => {
      const spec = {
        openapi: '3.0.1',
        info: {title: 'x', version: '1'},
        paths: {'/x': {}},
      };
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: JSON.stringify(spec)}));
      globalThis.fetch = fetchMock;

      const result = await createClient({
        integration: 'test-integration',
        triggers: ['api_trigger/test'],
      }).getOpenApiSpecForIntegration();

      expect(result).toEqual(spec);
      expect(fetchMock.mock.calls[0][0]).toBe(GENERATE_SPEC_URL);
      expect(fetchMock.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test_token',
            'x-goog-user-project': 'adc-project',
          }),
        }),
      );
      expect(requestBody(fetchMock.mock.calls[0][1])).toEqual({
        apiTriggerResources: [
          {
            integrationResource: 'test-integration',
            triggerId: ['api_trigger/test'],
          },
        ],
        fileFormat: 'JSON',
      });
    });

    it('posts to the mTLS host when the environment asks for it', async () => {
      vi.stubEnv('GOOGLE_API_USE_MTLS_ENDPOINT', 'always');
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: EMPTY_SPEC}));
      globalThis.fetch = fetchMock;

      await createClient({
        integration: 'test-integration',
        triggers: ['api_trigger/test'],
      }).getOpenApiSpecForIntegration();

      expect(fetchMock.mock.calls[0][0]).toBe(MTLS_GENERATE_SPEC_URL);
      expect(requestBody(fetchMock.mock.calls[0][1])).toEqual({
        apiTriggerResources: [
          {
            integrationResource: 'test-integration',
            triggerId: ['api_trigger/test'],
          },
        ],
        fileFormat: 'JSON',
      });
    });

    it('rejects a client configured with no integration', async () => {
      globalThis.fetch = vi.fn();

      await expect(
        createClient({
          triggers: ['api_trigger/test'],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        new InputValidationError(
          'Integration name and triggers are required to generate an' +
            ' integration OpenAPI spec.',
        ),
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('rejects a client configured with no triggers', async () => {
      globalThis.fetch = vi.fn();

      await expect(
        createClient({
          integration: 'test-integration',
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        new InputValidationError(
          'Integration name and triggers are required to generate an' +
            ' integration OpenAPI spec.',
        ),
      );
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it('sends the quota project header when using default credentials', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: EMPTY_SPEC}));
      globalThis.fetch = fetchMock;
      quotaProjectId.mockReturnValue('quota-project');

      await createClient({
        integration: 'test-integration',
        triggers: [],
      }).getOpenApiSpecForIntegration();

      expect(fetchMock).toHaveBeenCalledWith(
        GENERATE_SPEC_URL,
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-goog-user-project': 'quota-project',
          }),
        }),
      );
    });

    it('falls back to the configured project for the quota header', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: EMPTY_SPEC}));
      globalThis.fetch = fetchMock;
      getProjectId.mockRejectedValue(new Error('no project'));

      await createClient({
        integration: 'test-integration',
        triggers: [],
      }).getOpenApiSpecForIntegration();

      expect(fetchMock).toHaveBeenCalledWith(
        GENERATE_SPEC_URL,
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-goog-user-project': 'test-project',
          }),
        }),
      );
    });

    it('omits the quota project header when a service account key is given', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: EMPTY_SPEC}));
      globalThis.fetch = fetchMock;

      await createClient({
        integration: 'test-integration',
        triggers: [],
        serviceAccountJson: SERVICE_ACCOUNT_KEY,
      }).getOpenApiSpecForIntegration();

      expect(fetchMock).toHaveBeenCalledWith(
        GENERATE_SPEC_URL,
        expect.objectContaining({
          headers: expect.not.objectContaining({
            'x-goog-user-project': expect.anything(),
          }),
        }),
      );
    });

    it('reports an invalid project, location or integration on 404', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, {status: 404}));

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        new InputValidationError(
          'Invalid request. Please check the provided values of' +
            ' project(test-project), location(us-central1),' +
            ' integration(test-integration).',
        ),
      );
    });

    it('reports an invalid project, location or integration on 400', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, {status: 400}));

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        new InputValidationError(
          'Invalid request. Please check the provided values of' +
            ' project(test-project), location(us-central1),' +
            ' integration(test-integration).',
        ),
      );
    });

    it('reports any other failing status as a request error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({}, {status: 500}));

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow('Request error: 500 Error');
    });

    it('reports a transport failure as a request error', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('socket hang up'));

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow('Request error: socket hang up');
    });

    it('bounds the request with a 30 second timeout', async () => {
      const timeout = vi.spyOn(AbortSignal, 'timeout');
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: EMPTY_SPEC}));

      await createClient({
        integration: 'test-integration',
        triggers: [],
      }).getOpenApiSpecForIntegration();

      expect(timeout).toHaveBeenCalledWith(30_000);
      const init = vi.mocked(globalThis.fetch).mock.calls[0][1];
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('reports a spec string that is not JSON as an unexpected error', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: '{not json'}));

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(/^An unexpected error occurred: /);
    });

    it('surfaces a credentials failure', async () => {
      globalThis.fetch = vi.fn();
      getAccessToken.mockRejectedValue(new Error('no ADC'));

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow('Credentials error: no ADC');
    });

    it('rejects a response body that is not a JSON object', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse('a string'));

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        'Expected a JSON object from https://us-central1-integrations',
      );
    });

    it('rejects a response without an OpenAPI spec', async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(jsonResponse({}));

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        'Integration API response did not include an OpenAPI spec.',
      );
    });

    it('rejects a spec that is not a JSON object', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: '[1, 2]'}));

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        'Generated OpenAPI spec must be a JSON object declaring an openapi' +
          ' version, an info object and a paths object.',
      );
    });

    it('rejects a spec that carries no paths object', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({openApiSpec: '{"openapi":"3.0.1","info":{}}'}),
        );

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        'Generated OpenAPI spec must be a JSON object declaring an openapi' +
          ' version, an info object and a paths object.',
      );
    });

    it('rejects a spec that declares no openapi version', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({openApiSpec: '{"info":{},"paths":{}}'}),
        );

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        'Generated OpenAPI spec must be a JSON object declaring an openapi' +
          ' version, an info object and a paths object.',
      );
    });

    it('rejects a spec that declares no info object', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          jsonResponse({openApiSpec: '{"openapi":"3.0.1","paths":{}}'}),
        );

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        'Generated OpenAPI spec must be a JSON object declaring an openapi' +
          ' version, an info object and a paths object.',
      );
    });
  });

  describe('credentials', () => {
    it('builds a JWT scoped to cloud-platform from a service account key', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: EMPTY_SPEC}));

      await createClient({
        integration: 'test-integration',
        triggers: [],
        serviceAccountJson: SERVICE_ACCOUNT_KEY,
      }).getOpenApiSpecForIntegration();

      expect(jwtOptions).toHaveBeenCalledWith({
        email: 'test@example.com',
        key: 'test-key',
        scopes: [CLOUD_PLATFORM_SCOPE],
      });
      expect(googleAuthOptions).not.toHaveBeenCalled();
    });

    it('scopes default credentials to cloud-platform', async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: EMPTY_SPEC}));

      await createClient({
        integration: 'test-integration',
        triggers: [],
      }).getOpenApiSpecForIntegration();

      expect(googleAuthOptions).toHaveBeenCalledWith({
        scopes: [CLOUD_PLATFORM_SCOPE],
      });
      expect(jwtOptions).not.toHaveBeenCalled();
    });

    it('reports credentials that yield no token', async () => {
      globalThis.fetch = vi.fn();
      getAccessToken.mockResolvedValue({token: null});

      await expect(
        createClient({
          integration: 'test-integration',
          triggers: [],
        }).getOpenApiSpecForIntegration(),
      ).rejects.toThrow(
        'Please provide a service account that has the required permissions' +
          ' to access the connection.',
      );
    });

    it('sends the token the credentials rotated to on a later call', async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValue(jsonResponse({openApiSpec: EMPTY_SPEC}));
      globalThis.fetch = fetchMock;
      getAccessToken
        .mockResolvedValueOnce({token: 'first_token'})
        .mockResolvedValueOnce({token: 'second_token'});
      const client = createClient({
        integration: 'test-integration',
        triggers: [],
        serviceAccountJson: SERVICE_ACCOUNT_KEY,
      });

      await client.getOpenApiSpecForIntegration();
      await client.getOpenApiSpecForIntegration();

      expect(fetchMock.mock.calls[0][1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer first_token',
          }),
        }),
      );
      expect(fetchMock.mock.calls[1][1]).toEqual(
        expect.objectContaining({
          headers: expect.objectContaining({
            'Authorization': 'Bearer second_token',
          }),
        }),
      );
      expect(jwtOptions).toHaveBeenCalledTimes(1);
    });
  });

  describe('getConnectionDetails', () => {
    it('rejects a connector call made without a connection name', async () => {
      await expect(
        createClient({integration: 'test-integration'}).getConnectionDetails(),
      ).rejects.toThrow(
        new InputValidationError(
          'Connection name is required to generate a connection OpenAPI spec.',
        ),
      );
    });

    it('returns the service details of the connection', async () => {
      globalThis.fetch = routedFetch([
        [
          'view=BASIC',
          {
            name: 'projects/test-project/locations/us-central1/connections/c',
            serviceDirectory: 'test-service',
            authOverrideEnabled: true,
          },
        ],
      ]);

      await expect(
        createClient({connection: 'c'}).getConnectionDetails(),
      ).resolves.toEqual({
        name: 'projects/test-project/locations/us-central1/connections/c',
        serviceName: 'test-service',
        host: '',
        authOverrideEnabled: true,
      });
    });

    it('resolves the credentials once for the details and the spec', async () => {
      globalThis.fetch = routedFetch([
        ['view=BASIC', {name: 'c', serviceDirectory: 'test-service'}],
        ...connectorRoutes(),
      ]);
      const client = createClient({
        connection: 'c',
        entityOperations: {Issues: ['LIST']},
      });

      await client.getConnectionDetails();
      await client.getOpenApiSpecForConnection();

      expect(authClientRequests).toHaveBeenCalledTimes(1);
    });
  });

  describe('getOpenApiSpecForConnection', () => {
    it('generates a path and a request schema for every entity operation', async () => {
      globalThis.fetch = routedFetch(connectorRoutes());

      const spec = await createClient({
        connection: 'test-connection',
        entityOperations: {
          Issues: ['LIST', 'GET', 'CREATE', 'UPDATE', 'DELETE'],
        },
      }).getOpenApiSpecForConnection('jira', 'be careful');

      const paths = Object.keys(spec.paths);
      expect(paths).toContain(
        '/v2/projects/test-project/locations/us-central1/integrations/' +
          'ExecuteConnection:execute?triggerId=api_trigger/ExecuteConnection' +
          '#list_Issues',
      );
      expect(paths).toHaveLength(5);
      const schemas = spec.components?.schemas ?? {};
      expect(Object.keys(schemas)).toEqual(
        expect.arrayContaining([
          'connectorInputPayload_Issues',
          'list_Issues_Request',
          'get_Issues_Request',
          'create_Issues_Request',
          'update_Issues_Request',
          'delete_Issues_Request',
        ]),
      );
      expect(schemas['connectorInputPayload_Issues']).toEqual({
        type: 'object',
        properties: {id: {type: 'string'}},
      });
    });

    it('forwards the tool name and instructions into the generated operation', async () => {
      globalThis.fetch = routedFetch(connectorRoutes({operations: ['LIST']}));

      const spec = await createClient({
        connection: 'test-connection',
        entityOperations: {Issues: ['LIST']},
      }).getOpenApiSpecForConnection('jira', 'be careful');

      const item = pathItem(spec, Object.keys(spec.paths)[0]);
      expect(item.post?.operationId).toBe('jira_list_Issues');
      expect(item.post?.description).toContain('be careful');
      expect(item.post?.responses['200']).toBeDefined();
    });

    it('defaults the tool name and the instructions to empty strings', async () => {
      globalThis.fetch = routedFetch(connectorRoutes({operations: ['LIST']}));

      const spec = await createClient({
        connection: 'test-connection',
        entityOperations: {Issues: ['LIST']},
      }).getOpenApiSpecForConnection();

      const item = pathItem(spec, Object.keys(spec.paths)[0]);
      expect(item.post?.operationId).toBe('_list_Issues');
    });

    it('falls back to the operations the connector supports', async () => {
      globalThis.fetch = routedFetch(
        connectorRoutes({operations: ['LIST', 'CREATE']}),
      );

      const spec = await createClient({
        connection: 'test-connection',
        entityOperations: {Issues: []},
      }).getOpenApiSpecForConnection();

      expect(Object.keys(spec.paths)).toEqual([
        expect.stringContaining('#list_Issues'),
        expect.stringContaining('#create_Issues'),
      ]);
    });

    it('rejects an operation the generator cannot express', async () => {
      globalThis.fetch = routedFetch(connectorRoutes());

      await expect(
        createClient({
          connection: 'test-connection',
          entityOperations: {Issues: ['ARCHIVE']},
        }).getOpenApiSpecForConnection(),
      ).rejects.toThrow(
        new InputValidationError(
          'Invalid operation: ARCHIVE for entity: Issues',
        ),
      );
    });

    it('rejects an operation named after an Object prototype member', async () => {
      globalThis.fetch = routedFetch(connectorRoutes());

      await expect(
        createClient({
          connection: 'test-connection',
          entityOperations: {Issues: ['toString']},
        }).getOpenApiSpecForConnection(),
      ).rejects.toThrow(
        new InputValidationError(
          'Invalid operation: toString for entity: Issues',
        ),
      );
    });

    it('generates an input payload for a generic action', async () => {
      globalThis.fetch = routedFetch(connectorRoutes());

      const spec = await createClient({
        connection: 'test-connection',
        actions: ['CustomAction'],
      }).getOpenApiSpecForConnection('jira', '');

      const schemas = spec.components?.schemas ?? {};
      expect(Object.keys(schemas)).toEqual(
        expect.arrayContaining([
          'CustomAction_Request',
          'connectorInputPayload_CustomAction',
          'connectorOutputPayload_CustomAction',
          'CustomAction_Response',
        ]),
      );
      const item = pathItem(
        spec,
        '/v2/projects/test-project/locations/us-central1/integrations/' +
          'ExecuteConnection:execute?triggerId=api_trigger/ExecuteConnection' +
          '#CustomAction',
      );
      expect(item.post?.operationId).toBe('jira_CustomAction');
    });

    it('strips the spaces out of an action display name', async () => {
      globalThis.fetch = routedFetch(
        connectorRoutes({
          actionResponse: {
            inputJsonSchema: {type: 'object'},
            outputJsonSchema: {type: 'string'},
            displayName: 'Run Custom Report',
          },
        }),
      );

      const spec = await createClient({
        connection: 'test-connection',
        actions: ['CustomAction'],
      }).getOpenApiSpecForConnection('jira', '');

      const schemas = spec.components?.schemas ?? {};
      expect(schemas['RunCustomReport_Request']).toBeDefined();
      expect(Object.keys(schemas).every((key) => !key.includes(' '))).toBe(
        true,
      );
    });

    it('names an action the connector gives no display name for', async () => {
      globalThis.fetch = routedFetch(
        connectorRoutes({
          actionResponse: {
            inputJsonSchema: {type: 'object'},
            outputJsonSchema: {type: 'string'},
            displayName: '',
          },
        }),
      );

      const spec = await createClient({
        connection: 'test-connection',
        actions: ['CustomAction'],
      }).getOpenApiSpecForConnection('jira', '');

      const schemas = spec.components?.schemas ?? {};
      expect(Object.keys(schemas)).toEqual(
        expect.arrayContaining([
          'CustomAction_Request',
          'connectorInputPayload_CustomAction',
          'connectorOutputPayload_CustomAction',
          'CustomAction_Response',
        ]),
      );
      const item = pathItem(
        spec,
        '/v2/projects/test-project/locations/us-central1/integrations/' +
          'ExecuteConnection:execute?triggerId=api_trigger/ExecuteConnection' +
          '#CustomAction',
      );
      expect(item.post?.operationId).toBe('jira_CustomAction');
    });

    it('skips the input payload for ExecuteCustomQuery', async () => {
      globalThis.fetch = routedFetch(
        connectorRoutes({
          actionResponse: {
            inputJsonSchema: {type: 'object'},
            outputJsonSchema: {type: 'string'},
            displayName: 'ExecuteCustomQuery',
          },
        }),
      );

      const spec = await createClient({
        connection: 'test-connection',
        actions: ['ExecuteCustomQuery'],
      }).getOpenApiSpecForConnection();

      const schemas = spec.components?.schemas ?? {};
      expect(schemas['ExecuteCustomQuery_Request']).toBeDefined();
      expect(
        schemas['connectorInputPayload_ExecuteCustomQuery'],
      ).toBeUndefined();
      expect(
        schemas['connectorOutputPayload_ExecuteCustomQuery'],
      ).toBeDefined();
      const item = pathItem(
        spec,
        '/v2/projects/test-project/locations/us-central1/integrations/' +
          'ExecuteConnection:execute?triggerId=api_trigger/ExecuteConnection' +
          '#ExecuteCustomQuery',
      );
      expect(item.post?.description).toContain('convert it to SQL query');
    });

    it('replaces the default integration name with the override', async () => {
      globalThis.fetch = routedFetch(connectorRoutes({operations: ['LIST']}));

      const spec = await createClient({
        connection: 'test-connection',
        connectionTemplateOverride: 'MyConnectionRunner',
        entityOperations: {Issues: []},
      }).getOpenApiSpecForConnection();

      expect(Object.keys(spec.paths)[0]).toBe(
        '/v2/projects/test-project/locations/us-central1/integrations/' +
          'MyConnectionRunner:execute?triggerId=api_trigger/MyConnectionRunner' +
          '#list_Issues',
      );
    });

    it('rejects a connector spec built without a connection name', async () => {
      globalThis.fetch = vi.fn();

      await expect(
        createClient({
          entityOperations: {Issues: ['LIST']},
        }).getOpenApiSpecForConnection(),
      ).rejects.toThrow(
        new InputValidationError(
          'Connection name is required to generate a connection OpenAPI spec.',
        ),
      );
    });
  });
});
