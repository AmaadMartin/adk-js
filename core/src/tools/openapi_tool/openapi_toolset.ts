/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenApiSpecParser} from './openapi_spec_parser/openapi_spec_parser.js';
import {createRestApiTool, RestApiTool} from './rest_api_tool.js';

/** Options for {@link OpenAPIToolset}. */
export interface OpenAPIToolsetOptions {
  /** The parsed OpenAPI spec. Takes precedence over `specStr`. */
  specDict?: OpenAPIV3.Document;
  /** The OpenAPI spec as a JSON or YAML string. Used when `specDict` is absent. */
  specStr?: string;
  /** How to parse `specStr`. Defaults to `'json'`. */
  specType?: 'json' | 'yaml';
  /**
   * Selects the generated tools the toolset exposes. A `string[]` matches tool
   * names; a {@link ToolPredicate} decides per tool.
   */
  toolFilter?: ToolPredicate | string[];
  /**
   * Prepended to every generated tool name as `${prefix}_${name}`. Use it when
   * several specs generate tools with similar names.
   */
  prefix?: string;
  /**
   * Keeps the spec's original property names instead of converting them to
   * snake_case. Set it for an API that expects camelCase parameter names.
   */
  preservePropertyNames?: boolean;
  /** Auth scheme applied to every generated tool. */
  authScheme?: OpenAPIV3.SecuritySchemeObject;
  /** Auth credential applied to every generated tool. */
  authCredential?: AuthCredential;
  /** Stable key used for interactive auth and credential caching across tools. */
  credentialKey?: string;
  /**
   * Returns extra headers for every API call. It receives the current context,
   * so it can produce a correlation id or a per-request token.
   */
  headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  /**
   * `fetch` implementation used for every generated tool's API call. Defaults
   * to `globalThis.fetch`. Pass a wrapper to supply a custom certificate
   * authority, a proxy, or request signing.
   */
  fetchFn?: typeof globalThis.fetch;
}

/**
 * Parses an OpenAPI spec into a set of {@link RestApiTool}s.
 *
 * ```ts
 * // From a spec string...
 * const toolset = new OpenAPIToolset({specStr, specType: 'yaml'});
 * // ...or from a parsed spec.
 * const toolset = new OpenAPIToolset({specDict: spec});
 *
 * // Give an agent every generated tool...
 * const agent = new LlmAgent({name: 'api', model, tools: [toolset]});
 * // ...or one of them.
 * const tool = toolset.getTool('get_users');
 * ```
 */
@experimental
export class OpenAPIToolset extends BaseToolset {
  private tools: RestApiTool[] = [];

  constructor(options: OpenAPIToolsetOptions = {}) {
    super(options.toolFilter || [], options.prefix);

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
      let toolName = op.name;
      if (this.prefix) {
        toolName = `${this.prefix}_${toolName}`;
      }

      const tool = createRestApiTool(
        {
          name: toolName,
          description: op.description,
          endpoint: op.endpoint,
          operation: op.operation,
          authScheme: op.authScheme,
        },
        {
          preservePropertyNames: options.preservePropertyNames,
          headerProvider: options.headerProvider,
          credentialKey: options.credentialKey,
          fetchFn: options.fetchFn,
        },
      );

      logger.debug(`Parsed tool: ${tool.name}`);
      this.tools.push(tool);
    }

    for (const tool of this.tools) {
      if (options.authScheme) tool.configureAuthScheme(options.authScheme);
      if (options.authCredential) {
        tool.configureAuthCredential(options.authCredential);
      }
    }
  }

  /**
   * Sets the credential key on every generated tool, replacing the key the
   * toolset was constructed with.
   */
  @experimental
  public configureCredentialKeyAll(credentialKey: string) {
    for (const tool of this.tools) {
      tool.configureCredentialKey(credentialKey);
    }
  }

  /**
   * Sets the `fetch` implementation on every generated tool, replacing the one
   * the toolset was constructed with.
   */
  @experimental
  public configureFetchAll(fetchFn: typeof globalThis.fetch) {
    for (const tool of this.tools) {
      tool.configureFetch(fetchFn);
    }
  }

  /**
   * Returns the generated tool with this name, or `undefined`.
   *
   * The name includes `prefix` when one is configured, because the toolset
   * prefixes each tool at construction.
   */
  @experimental
  public getTool(name: string): RestApiTool | undefined {
    return this.tools.find((tool) => tool.name === name);
  }

  @experimental
  override async getTools(context?: ReadonlyContext): Promise<RestApiTool[]> {
    const filter = this.toolFilter;
    if (!filter || (Array.isArray(filter) && filter.length === 0)) {
      return [...this.tools];
    }

    if (Array.isArray(filter)) {
      return this.tools.filter((tool) => filter.includes(tool.name));
    }

    if (context) {
      return this.tools.filter((tool) => this.isToolSelected(tool, context));
    }

    // Predicate filter requested but no context provided — return all tools
    // and log a warning so callers are aware the filter was not applied.
    logger.warn(
      'OpenAPIToolset: a ToolPredicate toolFilter was provided but getTools() ' +
        'was called without a ReadonlyContext. The filter will not be applied.',
    );
    return [...this.tools];
  }

  @experimental
  override async close(): Promise<void> {
    // No persistent connections to close in this implementation
    return Promise.resolve();
  }
}

/**
 * Parses an OpenAPI spec string.
 *
 * @throws {Error} If the string does not describe an object. A JSON or YAML
 *     syntax error propagates from the underlying parser.
 */
function loadSpec(
  specStr: string,
  specType: 'json' | 'yaml' | undefined,
): OpenAPIV3.Document {
  const parsed: unknown =
    specType === 'yaml' || (!specType && specStr.trim().startsWith('---'))
      ? yaml.load(specStr)
      : JSON.parse(specStr);

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('The OpenAPI specification must be an object');
  }

  return parsed as OpenAPIV3.Document;
}
