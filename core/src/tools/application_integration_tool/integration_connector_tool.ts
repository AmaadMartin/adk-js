/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';
import {experimental} from '../../utils/experimental.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {ToolAuthHandler} from '../openapi_tool/openapi_spec_parser/tool_auth_handler.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';

/** Body field carrying the end-user credential to the connector. */
const DYNAMIC_AUTH_CONFIG_FIELD = 'dynamic_auth_config';

/** Key the connector reads the end-user access token from. */
const DYNAMIC_AUTH_TOKEN_KEY = 'oauth2_auth_code_flow.access_token';

/**
 * Argument names this tool sets itself. They are hidden from the model so it
 * cannot redirect a call to another connection, and stripped from `required`
 * because the model is never asked for them.
 */
const EXCLUDE_FIELDS = [
  'connection_name',
  'service_name',
  'host',
  'entity',
  'operation',
  'action',
  DYNAMIC_AUTH_CONFIG_FIELD,
];

/**
 * Argument names the connector defaults, so the model may omit them. They stay
 * in the declared properties and lose only their `required` status.
 *
 * `sortByColumns` is camelCase in adk-python's list and in the generated
 * connector spec, so it is copied as it stands.
 *
 * `executeCustomQueryRequest` is the only builder here that marks one of these
 * required, so the other names free nothing today and are kept for parity.
 */
const OPTIONAL_FIELDS = ['page_size', 'page_token', 'filter', 'sortByColumns'];

/** Options accepted by {@link IntegrationConnectorTool}. */
export interface IntegrationConnectorToolOptions {
  /** Tool name, derived from the generated `operationId`. */
  name: string;
  /** Tool description, derived from the generated operation description. */
  description: string;
  /** Full resource name of the Integration Connectors connection. */
  connectionName: string;
  /** Host name of the connection, empty unless it uses a TLS directory. */
  connectionHost: string;
  /** Service directory of the connection. */
  connectionServiceName: string;
  /** Entity this tool acts on, for an entity operation. */
  entity?: string;
  /** Connector operation, for example `LIST_ENTITIES`. */
  operation: string;
  /** Action this tool executes, for an action operation. */
  action?: string;
  /** Tool performing the underlying `ExecuteConnection` call. */
  restApiTool: RestApiTool;
  /**
   * Scheme of the end-user credential, when the connection allows one. A
   * string is its serialized form, which a call rejects.
   */
  authScheme?: AuthScheme | string;
  /**
   * End-user credential, when the connection allows one. A string is its
   * serialized form, which a call rejects.
   */
  authCredential?: AuthCredential | string;
  /** Slot the prepared credential is cached under. */
  credentialKey?: string;
}

/**
 * Calls one operation of an Integration Connectors connection.
 *
 * The tool adds the connection identity and the end-user credential to the
 * arguments the model supplied, then delegates the HTTP call to a
 * {@link RestApiTool} built from the generated connector spec.
 */
@experimental
export class IntegrationConnectorTool extends BaseTool {
  private readonly options: IntegrationConnectorToolOptions;

  constructor(options: IntegrationConnectorToolOptions) {
    super({name: options.name, description: options.description});
    this.options = options;
  }

  /**
   * Returns a copy of this tool that calls with `authCredential` in place of
   * the credential it was built with, or this tool unchanged when it
   * authenticates no end user.
   *
   * The toolset calls this once a host has exchanged the end-user credential,
   * so that the stored tool keeps the raw one and a later exchange starts from
   * it rather than from a token that has since expired.
   */
  @experimental
  withAuthCredential(authCredential: AuthCredential): IntegrationConnectorTool {
    if (!this.options.authScheme) {
      return this;
    }
    return new IntegrationConnectorTool({...this.options, authCredential});
  }

  @experimental
  override _getDeclaration(): FunctionDeclaration {
    const raw = this.options.restApiTool.getJsonSchema();
    const schema = {
      ...raw,
      type: 'object' as const,
      properties: modelProperties(raw['properties']),
      required: modelRequired(raw['required']),
    };

    if (isFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL)) {
      return {
        name: this.name,
        description: this.description,
        parametersJsonSchema: schema,
      };
    }
    return {
      name: this.name,
      description: this.description,
      parameters: toGeminiSchema(schema),
    };
  }

  @experimental
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const {args, toolContext} = request;
    const {options} = this;

    const {authScheme, authCredential} = options;
    // Dropping a serialized option and calling the handler with `undefined`
    // would read as "this connection needs no credential", and the call would
    // reach the connector unauthenticated.
    if (typeof authScheme === 'string' || typeof authCredential === 'string') {
      throw new Error(
        `IntegrationConnectorTool '${this.name}' holds authScheme or ` +
          'authCredential in its serialized string form, which it cannot ' +
          'authenticate with.',
      );
    }

    const authHandler = ToolAuthHandler.fromToolContext(
      toolContext,
      authScheme,
      authCredential,
      {credentialKey: options.credentialKey},
    );
    const authResult = await authHandler.prepareAuthCredentials();
    if (authResult.state === 'pending') {
      return {
        pending: true,
        message: 'Needs your authorization to access your data.',
      };
    }

    // The caller owns `args`. It is the very object the session stores on the
    // function-call event and the telemetry exporter reads, so the end-user
    // token goes into a copy: it reaches the connector and nothing else.
    const callArgs: Record<string, unknown> = {...args};

    if (authResult.authCredential) {
      const token = authResult.authCredential.http?.credentials?.token;
      // The connector reads an empty object as "no end-user token supplied".
      callArgs[DYNAMIC_AUTH_CONFIG_FIELD] = {
        [DYNAMIC_AUTH_TOKEN_KEY]: token ?? {},
      };
    }

    callArgs['connection_name'] = options.connectionName;
    callArgs['service_name'] = options.connectionServiceName;
    callArgs['host'] = options.connectionHost;
    callArgs['entity'] = options.entity;
    callArgs['operation'] = options.operation;
    callArgs['action'] = options.action;

    // Only the argument names are logged: `dynamic_auth_config` now holds the
    // end user's access token.
    logger.debug(
      `Running tool: ${this.name} with args: ${Object.keys(callArgs).join(', ')}`,
    );
    return options.restApiTool.runAsync({args: callArgs, toolContext});
  }

  /** Renders the tool for string interpolation. Never renders a credential. */
  override toString(): string {
    const {connectionName, entity, operation, action} = this.options;
    return (
      `ApplicationIntegrationTool(name="${this.name}", ` +
      `description="${this.description}", ` +
      `connection_name="${connectionName}", entity="${entity}", ` +
      `operation="${operation}", action="${action}")`
    );
  }

  /**
   * Renders the tool for `util.inspect` and a debugger. Never renders a
   * credential.
   *
   * @returns The fields {@link toString} renders, plus the connection host,
   *   the service directory and the name of the wrapped tool.
   */
  [Symbol.for('nodejs.util.inspect.custom')](): string {
    const {
      connectionName,
      connectionHost,
      connectionServiceName,
      entity,
      operation,
      action,
      restApiTool,
    } = this.options;
    return (
      `ApplicationIntegrationTool(name="${this.name}", ` +
      `description="${this.description}", ` +
      `connection_name="${connectionName}", ` +
      `connection_host="${connectionHost}", ` +
      `connection_service_name="${connectionServiceName}", ` +
      `entity="${entity}", operation="${operation}", ` +
      `action="${action}", rest_api_tool="${restApiTool.name}")`
    );
  }
}

/**
 * Returns the schema properties the model may fill, given the `properties` a
 * generated connector spec declared.
 */
function modelProperties(rawProperties: unknown): Record<string, unknown> {
  if (typeof rawProperties !== 'object' || rawProperties === null) {
    return {};
  }
  const kept: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(rawProperties)) {
    if (!EXCLUDE_FIELDS.includes(name)) {
      kept[name] = value;
    }
  }
  return kept;
}

/**
 * Returns the argument names the model must supply, given the `required` list
 * a generated connector spec declared.
 *
 * `OperationParser` reports no list at all when the operation requires
 * nothing, which reads here as an empty list.
 */
function modelRequired(rawRequired: unknown): string[] {
  if (!Array.isArray(rawRequired)) {
    return [];
  }
  return rawRequired.filter(
    (field): field is string =>
      typeof field === 'string' &&
      !OPTIONAL_FIELDS.includes(field) &&
      !EXCLUDE_FIELDS.includes(field),
  );
}
