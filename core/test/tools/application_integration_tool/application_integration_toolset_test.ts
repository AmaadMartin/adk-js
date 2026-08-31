/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  BaseTool,
  ServiceAccountCredential,
} from '@google/adk';
import {OpenAPIV3} from 'openapi-types';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {ApplicationIntegrationToolset} from '../../../src/tools/application_integration_tool/application_integration_toolset.js';
import {
  ConnectionDetails,
  ConnectionsClient,
} from '../../../src/tools/application_integration_tool/clients/connections_client.js';
import {IntegrationClient} from '../../../src/tools/application_integration_tool/clients/integration_client.js';
import {OpenAPIToolset} from '../../../src/tools/openapi_tool/openapi_toolset.js';

const {integrationClient, connectionsClient, openApiToolset} = vi.hoisted(
  () => ({
    integrationClient: {
      getOpenApiSpecForIntegration: vi.fn(),
      getOpenApiSpecForConnection: vi.fn(),
    },
    connectionsClient: {getConnectionDetails: vi.fn()},
    openApiToolset: {getTools: vi.fn()},
  }),
);

vi.mock(
  '../../../src/tools/application_integration_tool/clients/integration_client.js',
  () => ({IntegrationClient: vi.fn(() => integrationClient)}),
);

vi.mock(
  '../../../src/tools/application_integration_tool/clients/connections_client.js',
  () => ({ConnectionsClient: vi.fn(() => connectionsClient)}),
);

vi.mock('../../../src/tools/openapi_tool/openapi_toolset.js', () => ({
  OpenAPIToolset: vi.fn(() => openApiToolset),
}));

const PROJECT = 'test-project';
const LOCATION = 'us-central1';
const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

const INTEGRATION_SPEC: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {title: 'Integration API', version: '1.0.0'},
  paths: {},
};

const CONNECTION_SPEC: OpenAPIV3.Document = {
  openapi: '3.0.0',
  info: {title: 'Connection API', version: '1.0.0'},
  paths: {},
};

const CONNECTION = 'test-connection';

const CONNECTION_DETAILS: ConnectionDetails = {
  serviceName: 'test-service',
  host: 'test.host',
};

/** A fake key file. Every secret-shaped field is the literal `dummy`. */
const SERVICE_ACCOUNT_JSON = JSON.stringify({
  type: 'service_account',
  project_id: 'dummy',
  private_key_id: 'dummy',
  private_key: 'dummy',
  client_email: 'test@example.com',
  client_id: '131331543646416',
  auth_uri: 'https://accounts.google.com/o/oauth2/auth',
  token_uri: 'https://oauth2.googleapis.com/token',
  auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
  client_x509_cert_url:
    'http://www.googleapis.com/robot/v1/metadata/x509/dummy%40dummy.com',
  universe_domain: 'googleapis.com',
});

/** `SERVICE_ACCOUNT_JSON` after the snake_case keys become camelCase. */
const SERVICE_ACCOUNT_CREDENTIAL: ServiceAccountCredential = {
  type: 'service_account',
  projectId: 'dummy',
  privateKeyId: 'dummy',
  privateKey: 'dummy',
  clientEmail: 'test@example.com',
  clientId: '131331543646416',
  authUri: 'https://accounts.google.com/o/oauth2/auth',
  tokenUri: 'https://oauth2.googleapis.com/token',
  authProviderX509CertUrl: 'https://www.googleapis.com/oauth2/v1/certs',
  clientX509CertUrl:
    'http://www.googleapis.com/robot/v1/metadata/x509/dummy%40dummy.com',
  universeDomain: 'googleapis.com',
};

const MISSING_PARAMS_ERROR =
  'Either (integration and trigger) or (connection and (entityOperations or ' +
  'actions)) should be provided.';

/**
 * The connection hint adk-python appends to the tool instructions, with no
 * separator. The wording, including `DONOT`, reaches the model, so it is
 * byte-identical to adk-python v0.2.0.
 */
function connectionInstructions(instructions: string): string {
  const name = `projects/${PROJECT}/locations/${LOCATION}/connections/${CONNECTION}`;
  return `${instructions}ALWAYS use serviceName = ${CONNECTION_DETAILS.serviceName}, host = ${CONNECTION_DETAILS.host} and the connection name = ${name} when using this tool. DONOT ask the user for these values as you already have those.`;
}

/** A concrete tool, so the mocked `OpenAPIToolset` returns a real `BaseTool`. */
class TestTool extends BaseTool {
  constructor(name: string) {
    super({name, description: 'A tool built from the OpenAPI spec.'});
  }

  runAsync(): Promise<unknown> {
    return Promise.resolve({});
  }
}

describe('ApplicationIntegrationToolset', () => {
  let testTool: TestTool;

  beforeEach(() => {
    vi.clearAllMocks();
    testTool = new TestTool('Test Tool');
    integrationClient.getOpenApiSpecForIntegration.mockResolvedValue(
      INTEGRATION_SPEC,
    );
    integrationClient.getOpenApiSpecForConnection.mockResolvedValue(
      CONNECTION_SPEC,
    );
    connectionsClient.getConnectionDetails.mockResolvedValue(
      CONNECTION_DETAILS,
    );
    openApiToolset.getTools.mockResolvedValue([testTool]);
  });

  it('builds tools from an integration and a trigger', async () => {
    const toolset = new ApplicationIntegrationToolset({
      project: PROJECT,
      location: LOCATION,
      integration: 'test-integration',
      trigger: 'test-trigger',
    });

    const tools = await toolset.getTools();
    await toolset.getTools();

    expect(vi.mocked(IntegrationClient)).toHaveBeenCalledOnce();
    expect(vi.mocked(IntegrationClient)).toHaveBeenCalledWith({
      project: PROJECT,
      location: LOCATION,
      integration: 'test-integration',
      trigger: 'test-trigger',
    });
    expect(
      integrationClient.getOpenApiSpecForIntegration,
    ).toHaveBeenCalledOnce();
    expect(vi.mocked(ConnectionsClient)).not.toHaveBeenCalled();
    expect(vi.mocked(OpenAPIToolset)).toHaveBeenCalledOnce();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Test Tool');
  });

  it('builds tools from a connection and entity operations', async () => {
    const toolInstructions = 'Use this tool to manage entities.';

    const toolset = new ApplicationIntegrationToolset({
      project: PROJECT,
      location: LOCATION,
      connection: CONNECTION,
      entityOperations: ['list', 'get'],
      toolName: 'My Connection Tool',
      toolInstructions,
    });

    const tools = await toolset.getTools();
    await toolset.getTools();

    expect(vi.mocked(IntegrationClient)).toHaveBeenCalledOnce();
    expect(vi.mocked(IntegrationClient)).toHaveBeenCalledWith({
      project: PROJECT,
      location: LOCATION,
      connection: CONNECTION,
      entityOperations: ['list', 'get'],
    });
    expect(vi.mocked(ConnectionsClient)).toHaveBeenCalledOnce();
    expect(vi.mocked(ConnectionsClient)).toHaveBeenCalledWith({
      project: PROJECT,
      location: LOCATION,
      connection: CONNECTION,
    });
    expect(connectionsClient.getConnectionDetails).toHaveBeenCalledOnce();
    expect(
      integrationClient.getOpenApiSpecForConnection,
    ).toHaveBeenCalledOnce();
    expect(integrationClient.getOpenApiSpecForConnection).toHaveBeenCalledWith(
      'My Connection Tool',
      connectionInstructions(toolInstructions),
    );
    expect(vi.mocked(OpenAPIToolset)).toHaveBeenCalledOnce();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Test Tool');
  });

  it('builds tools from a connection and actions', async () => {
    const toolInstructions = 'Perform actions using this tool.';

    const toolset = new ApplicationIntegrationToolset({
      project: PROJECT,
      location: LOCATION,
      connection: CONNECTION,
      actions: ['create', 'delete'],
      toolName: 'My Actions Tool',
      toolInstructions,
    });

    const tools = await toolset.getTools();
    await toolset.getTools();

    expect(vi.mocked(IntegrationClient)).toHaveBeenCalledOnce();
    expect(vi.mocked(IntegrationClient)).toHaveBeenCalledWith({
      project: PROJECT,
      location: LOCATION,
      connection: CONNECTION,
      actions: ['create', 'delete'],
    });
    expect(vi.mocked(ConnectionsClient)).toHaveBeenCalledOnce();
    expect(vi.mocked(ConnectionsClient)).toHaveBeenCalledWith({
      project: PROJECT,
      location: LOCATION,
      connection: CONNECTION,
    });
    expect(connectionsClient.getConnectionDetails).toHaveBeenCalledOnce();
    expect(
      integrationClient.getOpenApiSpecForConnection,
    ).toHaveBeenCalledOnce();
    expect(integrationClient.getOpenApiSpecForConnection).toHaveBeenCalledWith(
      'My Actions Tool',
      connectionInstructions(toolInstructions),
    );
    expect(vi.mocked(OpenAPIToolset)).toHaveBeenCalledOnce();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe('Test Tool');
  });

  it('throws when neither an integration and trigger nor a connection and operations is given', () => {
    const base = {project: PROJECT, location: LOCATION};

    expect(() => new ApplicationIntegrationToolset(base)).toThrow(
      MISSING_PARAMS_ERROR,
    );
    expect(
      () => new ApplicationIntegrationToolset({...base, integration: 'test'}),
    ).toThrow(MISSING_PARAMS_ERROR);
    expect(
      () => new ApplicationIntegrationToolset({...base, trigger: 'test'}),
    ).toThrow(MISSING_PARAMS_ERROR);
    expect(
      () => new ApplicationIntegrationToolset({...base, connection: 'test'}),
    ).toThrow(MISSING_PARAMS_ERROR);
  });

  it('passes a service-account credential built from serviceAccountJson', async () => {
    const toolset = new ApplicationIntegrationToolset({
      project: PROJECT,
      location: LOCATION,
      integration: 'test-integration',
      trigger: 'test-trigger',
      serviceAccountJson: SERVICE_ACCOUNT_JSON,
    });

    await toolset.getTools();

    expect(vi.mocked(IntegrationClient)).toHaveBeenCalledWith({
      project: PROJECT,
      location: LOCATION,
      integration: 'test-integration',
      trigger: 'test-trigger',
      serviceAccountJson: SERVICE_ACCOUNT_JSON,
    });
    expect(vi.mocked(OpenAPIToolset)).toHaveBeenCalledOnce();
    expect(vi.mocked(OpenAPIToolset)).toHaveBeenCalledWith(
      expect.objectContaining({
        specDict: INTEGRATION_SPEC,
        authCredential: {
          authType: AuthCredentialTypes.SERVICE_ACCOUNT,
          serviceAccount: {
            serviceAccountCredential: SERVICE_ACCOUNT_CREDENTIAL,
            scopes: [CLOUD_PLATFORM_SCOPE],
          },
        },
      }),
    );
  });

  it('falls back to application default credentials', async () => {
    const toolset = new ApplicationIntegrationToolset({
      project: PROJECT,
      location: LOCATION,
      integration: 'test-integration',
      trigger: 'test-trigger',
    });

    await toolset.getTools();

    expect(vi.mocked(IntegrationClient)).toHaveBeenCalledWith({
      project: PROJECT,
      location: LOCATION,
      integration: 'test-integration',
      trigger: 'test-trigger',
    });
    expect(vi.mocked(OpenAPIToolset)).toHaveBeenCalledOnce();
    expect(vi.mocked(OpenAPIToolset)).toHaveBeenCalledWith(
      expect.objectContaining({
        specDict: INTEGRATION_SPEC,
        authCredential: {
          authType: AuthCredentialTypes.SERVICE_ACCOUNT,
          serviceAccount: {
            useDefaultCredential: true,
            scopes: [CLOUD_PLATFORM_SCOPE],
          },
        },
      }),
    );
  });

  it('returns the tools the OpenAPIToolset produced', async () => {
    const toolset = new ApplicationIntegrationToolset({
      project: PROJECT,
      location: LOCATION,
      integration: 'test-integration',
      trigger: 'test-trigger',
    });

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toBe(testTool);
    expect(tools[0].name).toBe('Test Tool');
  });

  it('appends the fetched connection details to the tool instructions', async () => {
    connectionsClient.getConnectionDetails.mockResolvedValue({
      serviceName: 'custom-service',
      host: 'custom.host',
    });

    const toolset = new ApplicationIntegrationToolset({
      project: PROJECT,
      location: LOCATION,
      connection: CONNECTION,
      entityOperations: ['list'],
      toolName: 'My Connection Tool',
      toolInstructions: 'Use this tool.',
    });

    await toolset.getTools();

    expect(
      integrationClient.getOpenApiSpecForConnection,
    ).toHaveBeenCalledOnce();
    expect(integrationClient.getOpenApiSpecForConnection).toHaveBeenCalledWith(
      'My Connection Tool',
      'Use this tool.ALWAYS use serviceName = custom-service, host = custom.host and the connection name = projects/test-project/locations/us-central1/connections/test-connection when using this tool. DONOT ask the user for these values as you already have those.',
    );
  });
});
