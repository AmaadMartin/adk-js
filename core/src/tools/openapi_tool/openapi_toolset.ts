/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';
import {experimental} from '../../utils/experimental.js';
import {SslVerify} from '../../utils/ssl_utils.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenApiSpecParser} from './openapi_spec_parser/openapi_spec_parser.js';
import {DEFAULT_OPENAPI_CREDENTIAL_KEY} from './openapi_spec_parser/tool_auth_handler.js';
import {createRestApiTool, FetchFn, RestApiTool} from './rest_api_tool.js';

@experimental
export class OpenAPIToolset extends BaseToolset {
  private tools: RestApiTool[] = [];
  private readonly authConfig?: AuthConfig;

  constructor(
    options: {
      specDict?: OpenAPIV3.Document;
      specStr?: string;
      specType?: 'json' | 'yaml';
      toolFilter?: ToolPredicate | string[];
      prefix?: string;
      preservePropertyNames?: boolean;
      authScheme?: AuthScheme;
      authCredential?: AuthCredential;
      credentialKey?: string;
      headerProvider?: (context: ReadonlyContext) => Record<string, string>;
      /** Issues each tool's request. Defaults to `globalThis.fetch`. */
      fetchFn?: FetchFn;
      sslVerify?: SslVerify;
      /** Deadline for one call. Defaults to `DEFAULT_REQUEST_TIMEOUT_MS`. */
      timeoutMs?: number;
    } = {},
  ) {
    super(options.toolFilter || [], options.prefix);

    this.authConfig = options.authScheme
      ? {
          authScheme: options.authScheme,
          rawAuthCredential: options.authCredential,
          credentialKey:
            options.credentialKey ?? DEFAULT_OPENAPI_CREDENTIAL_KEY,
        }
      : undefined;

    let spec = options.specDict;
    if (!spec && options.specStr) {
      spec = loadSpec(options.specStr, options.specType);
    }

    if (!spec) {
      throw new Error('Either specDict or specStr must be provided.');
    }

    const parser = new OpenApiSpecParser({
      preservePropertyNames: options.preservePropertyNames,
    });
    const parsedOperations = parser.parse(spec);

    for (const op of parsedOperations) {
      const tool = createRestApiTool(
        // The name stays the one the spec parser derived from the operation
        // id. `getToolsWithPrefix()` on the base class applies the prefix.
        {...op},
        {
          preservePropertyNames: options.preservePropertyNames,
          headerProvider: options.headerProvider,
          credentialKey: options.credentialKey,
          fetchFn: options.fetchFn,
          sslVerify: options.sslVerify,
          timeoutMs: options.timeoutMs,
        },
      );

      this.tools.push(tool);
    }

    for (const tool of this.tools) {
      if (this.authConfig) {
        tool.configureAuthScheme(this.authConfig.authScheme);
      }
      if (options.authCredential) {
        tool.configureAuthCredential(options.authCredential);
      }
    }
  }

  /**
   * Returns the generated tool with this name, or `undefined`.
   *
   * The name never includes `prefix`, because `getToolsWithPrefix()` on the
   * base class applies the prefix to a copy of the tool.
   */
  @experimental
  public getTool(name: string): RestApiTool | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  /**
   * Sets TLS certificate verification on every generated tool.
   *
   * Use it for an enterprise environment where requests pass through a
   * TLS-intercepting proxy with its own certificate authority.
   *
   * @param sslVerify The setting. Call with no argument to restore the default
   *     verification against the system CA.
   */
  @experimental
  public configureSslVerifyAll(sslVerify?: SslVerify) {
    for (const tool of this.tools) {
      tool.configureSslVerify(sslVerify);
    }
  }

  /**
   * Returns the auth config built from the `authScheme`, `authCredential` and
   * `credentialKey` options, or `undefined` when no auth scheme was given.
   *
   * The object is the toolset's own, so a host can fill in
   * `exchangedAuthCredential` before it calls {@link getTools}.
   */
  @experimental
  public getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }

  @experimental
  override async getTools(context?: ReadonlyContext): Promise<RestApiTool[]> {
    return this.tools.filter((tool) => this.isToolSelected(tool, context));
  }

  @experimental
  override async close(): Promise<void> {
    // No persistent connections to close in this implementation
    return Promise.resolve();
  }
}

/**
 * Parses an OpenAPI spec string into a spec document.
 *
 * @throws If `specType` is not a supported type, or if the string does not
 *     parse to an object. A JSON or YAML syntax error propagates from the
 *     underlying parser.
 */
function loadSpec(
  specStr: string,
  specType?: 'json' | 'yaml',
): OpenAPIV3.Document {
  const parsed = parseSpecString(specStr, specType);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The OpenAPI specification must be an object');
  }
  return parsed as OpenAPIV3.Document;
}

/**
 * Parses an OpenAPI spec string with the parser that `specType` names. With no
 * `specType`, a string that starts with a YAML document marker is read as YAML
 * and everything else as JSON.
 */
function parseSpecString(specStr: string, specType?: 'json' | 'yaml'): unknown {
  if (specType === 'yaml' || (!specType && specStr.trim().startsWith('---'))) {
    return yaml.load(specStr);
  }
  if (specType === 'json' || !specType) {
    return JSON.parse(specStr);
  }
  throw new Error(`Unsupported spec type: ${String(specType)}`);
}
