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
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {InputValidationError} from '../../errors/input_validation_error.js';
import {experimental} from '../../utils/experimental.js';
import {asJsonObject} from '../../utils/json_utils.js';
import {logger} from '../../utils/logger.js';
import {parseServiceAccountCredential} from '../../utils/service_account_utils.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenApiSpecParser} from '../openapi_tool/openapi_spec_parser/openapi_spec_parser.js';
import {DEFAULT_CREDENTIAL_KEY} from '../openapi_tool/openapi_spec_parser/tool_auth_handler.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {createRestApiTool} from '../openapi_tool/rest_api_tool.js';
import {CLOUD_PLATFORM_SCOPE} from './clients/api_transport.js';
import {ConnectionDetails} from './clients/connections_client.js';
import {ConnectorOperationExtensions} from './clients/connector_spec_builders.js';
import {IntegrationClient} from './clients/integration_client.js';
import {IntegrationConnectorTool} from './integration_connector_tool.js';

/** Rejection when neither mode is configured. Mirrors adk-python's message. */
const MODE_ERROR_MESSAGE =
  'Invalid request, Either integration or (connection and (entityOperations' +
  ' or actions)) should be provided.';

/** Credential key the service identity falls back to. */
const DEFAULT_SERVICE_IDENTITY_KEY = 'application_integration';

/** Warning emitted when the connection refuses the caller's end-user auth. */
const AUTH_OVERRIDE_DISABLED_WARNING =
  'Authentication schema and credentials are not used because' +
  ' authOverrideEnabled is not enabled in the connection.';

/**
 * Names the slot that caches the service identity's exchanged token.
 *
 * In connection mode two identities call out in one session: the service
 * account reaches `ExecuteConnection`, and the end user reaches the connector
 * behind it. Both use a bearer scheme, so they need different credential keys
 * to get different slots. The caller's key stays with the end user, and the
 * service identity takes a derived one.
 */
function serviceIdentityCredentialKey(credentialKey?: string): string {
  return `${credentialKey ?? DEFAULT_SERVICE_IDENTITY_KEY}_service_identity`;
}

/** Options accepted by {@link ApplicationIntegrationToolset}. */
export interface ApplicationIntegrationToolsetOptions {
  /** Google Cloud project id. */
  project: string;
  /** Google Cloud location, for example `us-central1`. */
  location: string;
  /** Replaces the default `ExecuteConnection` integration name. */
  connectionTemplateOverride?: string;
  /** Integration name. Selects integration mode. */
  integration?: string;
  /** Trigger ids of the integration. */
  triggers?: string[];
  /** Connection name. Selects connection mode. */
  connection?: string;
  /**
   * Operations to expose per entity. An empty list for an entity means every
   * operation the connector supports on it.
   */
  entityOperations?: Record<string, string[]>;
  /** Connector actions to expose. */
  actions?: string[];
  /** Prefix of every generated tool name. */
  toolNamePrefix?: string;
  /** Appended to every generated tool description. */
  toolInstructions?: string;
  /**
   * Raw service account key file contents. Falls back to Application Default
   * Credentials when omitted.
   */
  serviceAccountJson?: string;
  /** End-user auth scheme, honoured only when the connection allows it. */
  authScheme?: AuthScheme;
  /** End-user credential, honoured only when the connection allows it. */
  authCredential?: AuthCredential;
  /** Restricts which generated tools are exposed. */
  toolFilter?: ToolPredicate | string[];
  /** Slot the prepared credential is cached under. */
  credentialKey?: string;
}

/**
 * Generates tools from a Google Cloud Application Integration or Integration
 * Connectors resource.
 *
 * In integration mode the toolset turns the API triggers of an integration
 * into REST tools. In connection mode it turns the entity operations and the
 * actions of a connection into {@link IntegrationConnectorTool}s. Connection
 * mode needs an `ExecuteConnection` integration, or the override named by
 * `connectionTemplateOverride`, in the connection's region.
 *
 * The first `getTools` call reads the resource metadata over the network, so
 * unlike adk-python the constructor only validates its arguments.
 *
 * @example
 * ```ts
 * const toolset = new ApplicationIntegrationToolset({
 *   project: 'my-project',
 *   location: 'us-central1',
 *   connection: 'my-jira-connection',
 *   entityOperations: {Issues: ['LIST', 'CREATE']},
 *   toolNamePrefix: 'jira',
 * });
 * ```
 */
@experimental
export class ApplicationIntegrationToolset extends BaseToolset {
  private readonly options: ApplicationIntegrationToolsetOptions;
  private readonly integrationClient: IntegrationClient;
  /** Scheme and credential every generated tool calls the API with. */
  private readonly serviceIdentity: {
    authScheme: OpenAPIV3.SecuritySchemeObject;
    authCredential: AuthCredential;
  };
  /**
   * End-user auth this toolset asks a host to prepare, present only when the
   * caller supplied an `authScheme`.
   */
  private readonly authConfig?: AuthConfig;
  private initialization?: Promise<void>;
  private openapiToolset?: OpenAPIToolset;
  private tools: IntegrationConnectorTool[] = [];

  /**
   * @throws {InputValidationError} If neither an integration nor a connection
   *     with entity operations or actions was given, or if the service account
   *     key is malformed.
   */
  constructor(options: ApplicationIntegrationToolsetOptions) {
    super(options.toolFilter ?? []);
    const hasConnectionWork =
      options.connection &&
      (Object.keys(options.entityOperations ?? {}).length > 0 ||
        (options.actions?.length ?? 0) > 0);
    if (!options.integration && !hasConnectionWork) {
      throw new InputValidationError(MODE_ERROR_MESSAGE);
    }
    // The key is parsed here rather than on the first call, so a malformed one
    // is reported while the agent is being assembled.
    const serviceAccountCredential = options.serviceAccountJson
      ? parseServiceAccountCredential(options.serviceAccountJson)
      : undefined;
    this.serviceIdentity = {
      authScheme: {type: 'http', scheme: 'bearer', bearerFormat: 'JWT'},
      authCredential: {
        authType: AuthCredentialTypes.SERVICE_ACCOUNT,
        serviceAccount: {
          ...(serviceAccountCredential
            ? {serviceAccountCredential}
            : {useDefaultCredential: true}),
          scopes: [CLOUD_PLATFORM_SCOPE],
        },
      },
    };
    this.authConfig = options.authScheme
      ? {
          authScheme: options.authScheme,
          rawAuthCredential: options.authCredential,
          credentialKey: options.credentialKey ?? DEFAULT_CREDENTIAL_KEY,
        }
      : undefined;
    this.options = options;
    this.integrationClient = new IntegrationClient(options);
  }

  /**
   * Returns the auth config built from the `authScheme`, `authCredential` and
   * `credentialKey` options, or `undefined` when no auth scheme was given.
   *
   * The object is the toolset's own, so a host can fill in
   * `exchangedAuthCredential` before it calls {@link getTools}.
   */
  @experimental
  getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }

  @experimental
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    await this.initializeOnce();

    if (this.openapiToolset) {
      return this.openapiToolset.getTools(context);
    }

    const selected = this.tools.filter((tool) =>
      this.isToolSelected(tool, context),
    );
    const exchanged = this.authConfig?.exchangedAuthCredential;
    if (!exchanged) {
      return selected;
    }
    return selected.map((tool) => tool.withAuthCredential(exchanged));
  }

  /**
   * Closes the toolset. An initialization already in flight is awaited first,
   * so the toolset it builds is closed too rather than outliving this call.
   */
  @experimental
  override async close(): Promise<void> {
    // A failed initialization has nothing to close, and its error belongs to
    // the getTools caller that started it.
    await this.initialization?.catch(() => {});
    this.initialization = undefined;
    const toolset = this.openapiToolset;
    this.openapiToolset = undefined;
    this.tools = [];
    await toolset?.close();
  }

  /**
   * Reads the resource metadata once, however many callers race on the first
   * `getTools`. A failed attempt is discarded rather than remembered, so one
   * transient network error does not leave the toolset empty for good.
   */
  private initializeOnce(): Promise<void> {
    this.initialization ??= this.initialize().catch((error: unknown) => {
      this.initialization = undefined;
      throw error;
    });
    return this.initialization;
  }

  private async initialize(): Promise<void> {
    if (this.options.integration) {
      const spec = await this.integrationClient.getOpenApiSpecForIntegration();
      this.openapiToolset = new OpenAPIToolset({
        specDict: spec,
        ...this.serviceIdentity,
        credentialKey: this.options.credentialKey,
        toolFilter: this.options.toolFilter,
      });
      return;
    }

    const connectionDetails =
      await this.integrationClient.getConnectionDetails();
    const spec = await this.integrationClient.getOpenApiSpecForConnection(
      this.options.toolNamePrefix ?? '',
      this.options.toolInstructions ?? '',
    );

    const endUserAuth = this.resolveEndUserAuth(connectionDetails);
    this.tools = new OpenApiSpecParser().parse(spec).map((parsed) => {
      const restApiTool = createRestApiTool(parsed, {
        credentialKey: serviceIdentityCredentialKey(this.options.credentialKey),
      });
      restApiTool.configureAuthScheme(this.serviceIdentity.authScheme);
      restApiTool.configureAuthCredential(this.serviceIdentity.authCredential);
      return new IntegrationConnectorTool({
        name: restApiTool.name,
        description: restApiTool.description,
        connectionName: connectionDetails.name,
        connectionHost: connectionDetails.host,
        connectionServiceName: connectionDetails.serviceName,
        entity: readOperationExtension(parsed.operation, 'x-entity'),
        action: readOperationExtension(parsed.operation, 'x-action'),
        operation:
          readOperationExtension(parsed.operation, 'x-operation') ?? '',
        restApiTool,
        authScheme: endUserAuth.authScheme,
        authCredential: endUserAuth.authCredential,
        credentialKey: this.options.credentialKey,
      });
    });
    logger.debug(
      `Built ${this.tools.length} connector tools for connection` +
        ` ${this.options.connection}.`,
    );
  }

  /**
   * Decides whether the caller's end-user credential may be used. A connection
   * that does not enable auth override ignores it, so passing it on would send
   * a credential the connector rejects.
   */
  private resolveEndUserAuth(connectionDetails: ConnectionDetails): {
    authScheme?: AuthScheme;
    authCredential?: AuthCredential;
  } {
    const {authScheme, authCredential} = this.options;
    if (
      authScheme &&
      authCredential &&
      !connectionDetails.authOverrideEnabled
    ) {
      logger.warn(AUTH_OVERRIDE_DISABLED_WARNING);
      return {};
    }
    return {authScheme, authCredential};
  }
}

/**
 * Reads an `x-` extension the connector spec put on an operation.
 * `OperationObject` declares no extension fields, so the read goes through one
 * record view instead of a cast at every call site.
 */
function readOperationExtension(
  operation: OpenAPIV3.OperationObject,
  key: keyof ConnectorOperationExtensions,
): string | undefined {
  const value = asJsonObject(operation)?.[key];
  return typeof value === 'string' ? value : undefined;
}
