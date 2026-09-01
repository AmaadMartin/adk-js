/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {OpenAPIV3} from 'openapi-types';
import {Context} from '../../agents/context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {ToolAuthHandler} from '../openapi_tool/openapi_spec_parser/tool_auth_handler.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';

/**
 * Arguments the toolset supplies, so the model must not be asked for them.
 */
const EXCLUDE_FIELDS = [
  'connection_name',
  'service_name',
  'host',
  'entity',
  'operation',
  'action',
  'dynamic_auth_config',
];

/** Arguments the connector spec marks required that the model may omit. */
const OPTIONAL_FIELDS = ['page_size', 'page_token', 'filter', 'sortByColumns'];

/** The key the connector reads a caller's OAuth token from. */
const DYNAMIC_AUTH_TOKEN_KEY = 'oauth2_auth_code_flow.access_token';

export interface IntegrationConnectorToolOptions {
  name: string;
  description: string;
  connectionName: string;
  connectionHost: string;
  connectionServiceName: string;
  /** Set for an entity operation. */
  entity?: string;
  /** Set for an action. */
  action?: string;
  operation: string;
  restApiTool: RestApiTool;
  authScheme?: OpenAPIV3.SecuritySchemeObject;
  authCredential?: AuthCredential;
  credentialKey?: string;
}

/**
 * Calls one Integration Connectors operation through a `RestApiTool`.
 *
 * The connection, entity, operation and action are fixed when the tool is
 * built, so the model supplies only the operation's own arguments. This tool
 * adds the fixed arguments back, together with the caller's access token when
 * the connection accepts one, and delegates the request.
 */
@experimental
export class IntegrationConnectorTool extends BaseTool {
  private readonly connectionName: string;
  private readonly connectionHost: string;
  private readonly connectionServiceName: string;
  private readonly entity?: string;
  private readonly action?: string;
  private readonly operation: string;
  private readonly restApiTool: RestApiTool;
  private readonly authScheme?: OpenAPIV3.SecuritySchemeObject;
  private readonly authCredential?: AuthCredential;
  private readonly credentialKey?: string;

  constructor(options: IntegrationConnectorToolOptions) {
    super({name: options.name, description: options.description});
    this.connectionName = options.connectionName;
    this.connectionHost = options.connectionHost;
    this.connectionServiceName = options.connectionServiceName;
    this.entity = options.entity;
    this.action = options.action;
    this.operation = options.operation;
    this.restApiTool = options.restApiTool;
    this.authScheme = options.authScheme;
    this.authCredential = options.authCredential;
    this.credentialKey = options.credentialKey;
  }

  @experimental
  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: pruneConnectorSchema(this.restApiTool.getJsonSchema()),
    };
  }

  @experimental
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const toolContext = request.toolContext as Context;
    const authHandler = ToolAuthHandler.fromToolContext(
      toolContext,
      this.authScheme,
      this.authCredential,
      {credentialKey: this.credentialKey},
    );

    const authResult = await authHandler.prepareAuthCredentials();
    if (authResult.state === 'pending') {
      return {
        pending: true,
        message: 'Needs your authorization to access your data.',
      };
    }

    // A copy, because the caller's `args` object is the one recorded on the
    // function call event, and it must not gain an access token.
    const args: Record<string, unknown> = {...request.args};

    if (authResult.authCredential) {
      const token = authResult.authCredential.http?.credentials?.token;
      // The connector requires the key. An empty object is the "no token"
      // form it accepts, and an empty string is no token.
      args['dynamic_auth_config'] = {[DYNAMIC_AUTH_TOKEN_KEY]: token || {}};
    }

    args['connection_name'] = this.connectionName;
    args['service_name'] = this.connectionServiceName;
    args['host'] = this.connectionHost;
    args['entity'] = this.entity;
    args['operation'] = this.operation;
    args['action'] = this.action;

    // Argument names only: `dynamic_auth_config` holds a live access token.
    logger.debug(
      `Running tool: ${this.name} with args: ${Object.keys(args).join(', ')}`,
    );
    return this.restApiTool.runAsync({args, toolContext});
  }
}

/**
 * Removes the arguments the toolset supplies from an operation's schema.
 *
 * @returns The pruned schema. The input is not modified.
 */
function pruneConnectorSchema(
  schema: Record<string, unknown>,
): Record<string, unknown> {
  const pruned = {...schema};

  const properties = pruned['properties'];
  if (isRecord(properties)) {
    const kept: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(properties)) {
      if (!EXCLUDE_FIELDS.includes(name)) {
        kept[name] = value;
      }
    }
    pruned['properties'] = kept;
  }

  const required = pruned['required'];
  if (Array.isArray(required)) {
    pruned['required'] = required.filter(
      (name) =>
        !EXCLUDE_FIELDS.includes(name as string) &&
        !OPTIONAL_FIELDS.includes(name as string),
    );
  }

  return pruned;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
