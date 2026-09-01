/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OpenAPIV3} from 'openapi-types';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {parseServiceAccountJson} from '../../utils/service_account_utils.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {createBearerScheme} from '../openapi_tool/auth/auth_helpers.js';
import {OpenApiSpecParser} from '../openapi_tool/openapi_spec_parser/openapi_spec_parser.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {createRestApiTool} from '../openapi_tool/rest_api_tool.js';
import {
  ConnectionDetails,
  ConnectionsClient,
} from './clients/connections_client.js';
import {readConnectorExtension} from './clients/connector_spec_builders.js';
import {IntegrationClient} from './clients/integration_client.js';
import {IntegrationConnectorTool} from './integration_connector_tool.js';

const CLOUD_PLATFORM_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Which resource the toolset generates its tools from. */
type ToolsetMode =
  | {kind: 'integration'}
  | {kind: 'connection'; connection: string};

export interface ApplicationIntegrationToolsetOptions {
  project: string;
  location: string;
  /** Replaces the `ExecuteConnection` integration that runs connector calls. */
  connectionTemplateOverride?: string;
  /** Integration mode: the integration whose API triggers become tools. */
  integration?: string;
  triggers?: string[];
  /** Connection mode: the Integration Connectors connection to call. */
  connection?: string;
  /** Entity to operations. An empty list means every supported operation. */
  entityOperations?: Record<string, string[]>;
  actions?: string[];
  /** Prepended to every generated tool name. */
  toolNamePrefix?: string;
  /** Appended to every generated tool description. */
  toolInstructions?: string;
  /** A service account key file. Application Default Credentials if omitted. */
  serviceAccountJson?: string;
  /** The end user's scheme, used when the connection allows an auth override. */
  authScheme?: OpenAPIV3.SecuritySchemeObject;
  authCredential?: AuthCredential;
  toolFilter?: ToolPredicate | string[];
  credentialKey?: string;
}

/**
 * Turns a Google Cloud Application Integration resource into agent tools.
 *
 * Two modes, and exactly one applies. Give `integration` to expose every API
 * trigger of an integration. Give `connection` with `entityOperations` or
 * `actions` to expose operations on an Integration Connectors connection.
 *
 * @example
 * ```ts
 * const toolset = new ApplicationIntegrationToolset({
 *   project: 'my-project',
 *   location: 'us-central1',
 *   connection: 'my-jira-connection',
 *   entityOperations: {Issues: ['LIST', 'GET']},
 * });
 * const agent = new LlmAgent({
 *   name: 'jira_agent',
 *   model: 'gemini-2.5-flash',
 *   tools: [toolset],
 * });
 * ```
 */
@experimental
export class ApplicationIntegrationToolset extends BaseToolset {
  private readonly options: ApplicationIntegrationToolsetOptions;
  private readonly integrationClient: IntegrationClient;
  private readonly mode: ToolsetMode;

  /** Set on the first `getTools`, so concurrent calls fetch once. */
  private initialization?: Promise<void>;
  private openApiToolset?: OpenAPIToolset;
  private connectorTools: IntegrationConnectorTool[] = [];

  constructor(options: ApplicationIntegrationToolsetOptions) {
    super(options.toolFilter ?? []);

    const {integration, connection} = options;
    const hasConnectorWork = Boolean(
      Object.keys(options.entityOperations ?? {}).length ||
      options.actions?.length,
    );

    if (integration) {
      this.mode = {kind: 'integration'};
    } else if (connection && hasConnectorWork) {
      this.mode = {kind: 'connection', connection};
    } else {
      throw new Error(
        'Invalid request, Either integration or (connection and' +
          ' (entity_operations or actions)) should be provided.',
      );
    }

    this.options = options;
    this.integrationClient = new IntegrationClient({
      project: options.project,
      location: options.location,
      connectionTemplateOverride: options.connectionTemplateOverride,
      integration: options.integration,
      triggers: options.triggers,
      connection: options.connection,
      entityOperations: options.entityOperations,
      actions: options.actions,
      serviceAccountJson: options.serviceAccountJson,
    });
  }

  /**
   * Reads the resource on the first call and returns the tools it generated.
   *
   * @throws {ApplicationIntegrationError} If reading the resource fails.
   */
  @experimental
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    await this.initialize();

    if (this.openApiToolset) {
      return this.openApiToolset.getTools(context);
    }
    return this.connectorTools.filter(
      (tool) => !context || this.isToolSelected(tool, context),
    );
  }

  @experimental
  override async close(): Promise<void> {
    await this.openApiToolset?.close();
  }

  /**
   * Runs the network work once.
   *
   * A rejected attempt is not cached, so a later call retries rather than
   * replaying the failure.
   */
  private initialize(): Promise<void> {
    if (!this.initialization) {
      this.initialization = this.loadTools().catch((error: unknown) => {
        this.initialization = undefined;
        throw error;
      });
    }
    return this.initialization;
  }

  private async loadTools(): Promise<void> {
    const {authScheme, authCredential} = serviceAccountAuth(
      this.options.serviceAccountJson,
    );

    if (this.mode.kind === 'integration') {
      const spec = await this.integrationClient.getOpenApiSpecForIntegration();
      this.openApiToolset = new OpenAPIToolset({
        specDict: spec,
        authScheme,
        authCredential,
        credentialKey: this.options.credentialKey,
        toolFilter: this.toolFilter,
      });
      return;
    }

    const connectionsClient = new ConnectionsClient({
      project: this.options.project,
      location: this.options.location,
      connection: this.mode.connection,
      serviceAccountJson: this.options.serviceAccountJson,
    });
    const connectionDetails = await connectionsClient.getConnectionDetails();
    const spec = await this.integrationClient.getOpenApiSpecForConnection(
      this.options.toolNamePrefix,
      this.options.toolInstructions,
    );

    const connectorAuth = this.resolveConnectorAuth(connectionDetails);
    this.connectorTools = new OpenApiSpecParser().parse(spec).map((parsed) => {
      const restApiTool = createRestApiTool(parsed);
      restApiTool.configureAuthScheme(authScheme);
      restApiTool.configureAuthCredential(authCredential);

      return new IntegrationConnectorTool({
        name: restApiTool.name,
        description: restApiTool.description,
        connectionName: connectionDetails.name,
        connectionHost: connectionDetails.host,
        connectionServiceName: connectionDetails.serviceName,
        entity: readConnectorExtension(parsed.operation, 'x-entity'),
        action: readConnectorExtension(parsed.operation, 'x-action'),
        operation: readConnectorExtension(parsed.operation, 'x-operation')!,
        restApiTool,
        authScheme: connectorAuth.authScheme,
        authCredential: connectorAuth.authCredential,
        credentialKey: this.options.credentialKey,
      });
    });
  }

  /**
   * The end user's credential for the connector call, if the connection takes
   * one. A connection without an auth override runs as the service account,
   * so a supplied credential would silently not be used.
   */
  private resolveConnectorAuth(connectionDetails: ConnectionDetails): {
    authScheme?: OpenAPIV3.SecuritySchemeObject;
    authCredential?: AuthCredential;
  } {
    const {authScheme, authCredential} = this.options;
    if (
      authScheme &&
      authCredential &&
      !connectionDetails.authOverrideEnabled
    ) {
      logger.warn(
        'Authentication schema and credentials are not used because' +
          ' authOverrideEnabled is not enabled in the connection.',
      );
      return {};
    }
    return {authScheme, authCredential};
  }
}

/**
 * The scheme and credential the generated tools use to reach Application
 * Integration itself.
 *
 * Always a bearer scheme: `ToolAuthHandler` exchanges the service account for
 * a bearer token, whichever credential it started from.
 */
function serviceAccountAuth(serviceAccountJson?: string): {
  authScheme: OpenAPIV3.SecuritySchemeObject;
  authCredential: AuthCredential;
} {
  const serviceAccount = serviceAccountJson
    ? {
        serviceAccountCredential: parseServiceAccountJson(serviceAccountJson),
        scopes: [CLOUD_PLATFORM_SCOPE],
      }
    : {useDefaultCredential: true, scopes: [CLOUD_PLATFORM_SCOPE]};

  return {
    authScheme: createBearerScheme(),
    authCredential: {
      authType: AuthCredentialTypes.SERVICE_ACCOUNT,
      serviceAccount,
    },
  };
}
