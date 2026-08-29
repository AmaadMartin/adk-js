/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {experimental} from '../../utils/experimental.js';
import {asJsonObject} from '../../utils/json_utils.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {ToolAuthHandler} from '../openapi_tool/openapi_spec_parser/tool_auth_handler.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';

/** Body field carrying the end-user credential to the connector. */
const DYNAMIC_AUTH_CONFIG_FIELD = 'dynamic_auth_config';

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
 * Argument names the connector defaults, so the model may omit them.
 * `executeCustomQueryRequest` is the only builder that marks one required.
 */
const OPTIONAL_FIELDS = ['page_size'];

/** Key the connector reads the end-user access token from. */
const DYNAMIC_AUTH_TOKEN_KEY = 'oauth2_auth_code_flow.access_token';

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
  /** Scheme of the end-user credential, when the connection allows one. */
  authScheme?: AuthScheme;
  /** End-user credential, when the connection allows one. */
  authCredential?: AuthCredential;
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

  @experimental
  override _getDeclaration(): FunctionDeclaration {
    const schema = this.options.restApiTool.getJsonSchema();
    const properties = asJsonObject(schema['properties']);
    if (properties) {
      for (const field of EXCLUDE_FIELDS) {
        delete properties[field];
      }
    }
    const required = schema['required'];
    if (Array.isArray(required)) {
      schema['required'] = required.filter(
        (field) =>
          !OPTIONAL_FIELDS.includes(field) && !EXCLUDE_FIELDS.includes(field),
      );
    }
    return {
      name: this.name,
      description: this.description,
      parameters: schema,
    };
  }

  @experimental
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const {args, toolContext} = request;
    const {options} = this;

    const authHandler = ToolAuthHandler.fromToolContext(
      toolContext,
      options.authScheme,
      options.authCredential,
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
}
