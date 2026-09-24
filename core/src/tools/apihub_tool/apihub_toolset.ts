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
import {toSnakeCaseName} from '../../utils/case_utils.js';
import {experimental} from '../../utils/experimental.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {RestApiTool} from '../openapi_tool/rest_api_tool.js';
import {
  APIHubClient,
  BaseAPIHubClient,
} from './clients/apihub_client.js';

/**
 * Configuration options for initializing an {@link APIHubToolset}.
 */
export interface APIHubToolsetOptions {
  /**
   * The resource name of the API in Google Cloud API Hub, or its Cloud Console URL.
   * It must include the API name, and can optionally include the API version and spec name.
   *
   * - If `apihubResourceName` includes a spec resource name, the content of that
   *   spec is used for generating the tools.
   * - If `apihubResourceName` includes only an API or a version name, the
   *   first spec of the first version of that API is used.
   *
   * Example: `'projects/test-project/locations/us-central1/apis/test-api'`.
   */
  apihubResourceName: string;
  /**
   * Google OAuth2 access token used for authenticating requests to API Hub
   * when fetching specifications.
   */
  accessToken?: string;
  /**
   * Service account configuration as a JSON string or parsed object used for
   * creating the default API Hub client and fetching specifications.
   */
  serviceAccountJson?: string | Record<string, unknown>;
  /**
   * Optional custom API Hub client instance.
   */
  apihubClient?: BaseAPIHubClient;
  /**
   * Name of the toolset. If omitted, derived in `snake_case` from the OpenAPI
   * specification's `info.title` field.
   */
  name?: string;
  /**
   * Description of the toolset. If omitted, derived from the OpenAPI
   * specification's `info.description` field.
   */
  description?: string;
  /**
   * If `true`, the specification is loaded lazily when tools are requested.
   * Otherwise, the specification is fetched and parsed during initialization.
   */
  lazyLoadSpec?: boolean;
  /**
   * Authentication scheme applied to all tools generated in the toolset.
   */
  authScheme?: AuthScheme;
  /**
   * Authentication credential applied to all tools generated in the toolset.
   */
  authCredential?: AuthCredential;
  /**
   * Filter used to select which tools in the toolset are exposed to an agent.
   * Can be a predicate function or an array of tool names.
   */
  toolFilter?: ToolPredicate | string[];
  /**
   * Optional prefix prepended to generated tool names.
   */
  prefix?: string;
  /**
   * Whether to preserve original property names when parsing the OpenAPI specification.
   */
  preservePropertyNames?: boolean;
  /**
   * Optional callback providing additional HTTP headers at runtime.
   */
  headerProvider?: (context: ReadonlyContext) => Record<string, string>;
  /**
   * Optional credential key used to store and retrieve exchanged credentials.
   */
  credentialKey?: string;
}

function parseSpecDocument(specStr: string): {
  specDict?: OpenAPIV3.Document;
  title: string;
  description: string;
} {
  const loaded = yaml.load(specStr);
  if (!loaded || typeof loaded !== 'object' || Array.isArray(loaded)) {
    return {title: 'unnamed', description: ''};
  }
  const specDict = loaded as OpenAPIV3.Document;
  const rawInfo = specDict.info as unknown;
  const info =
    rawInfo && typeof rawInfo === 'object' && !Array.isArray(rawInfo)
      ? (rawInfo as Record<string, unknown>)
      : {};
  const rawTitle = info.title;
  const title = typeof rawTitle === 'string' ? rawTitle : 'unnamed';
  const rawDescription = info.description;
  const description =
    typeof rawDescription === 'string' ? rawDescription : '';
  return {specDict, title, description};
}

/**
 * Generates {@link RestApiTool} instances from a Google Cloud API Hub resource.
 *
 * @example
 * ```ts
 * const apihubToolset = new APIHubToolset({
 *   apihubResourceName:
 *     'projects/test-project/locations/us-central1/apis/test-api',
 *   serviceAccountJson: '...',
 * });
 *
 * const agent = new LlmAgent({
 *   name: 'api_agent',
 *   model: 'gemini-flash-latest',
 *   tools: [apihubToolset],
 * });
 * ```
 */
@experimental
export class APIHubToolset extends BaseToolset {
  name: string;
  description: string;
  readonly apihubResourceName: string;
  readonly lazyLoadSpec: boolean;
  readonly apihubClient: BaseAPIHubClient;
  readonly authScheme?: AuthScheme;
  readonly authCredential?: AuthCredential;
  readonly authConfig?: AuthConfig;
  generatedTools: Record<string, RestApiTool> = {};

  private openapiToolset?: OpenAPIToolset;
  private preparingPromise?: Promise<void>;
  private readonly preservePropertyNames?: boolean;
  private readonly headerProvider?: (
    context: ReadonlyContext,
  ) => Record<string, string>;
  private readonly credentialKey?: string;

  constructor(options: APIHubToolsetOptions) {
    super(options.toolFilter ?? [], options.prefix);
    this.name = options.name ?? '';
    this.description = options.description ?? '';
    this.apihubResourceName = options.apihubResourceName;
    this.lazyLoadSpec = options.lazyLoadSpec ?? false;
    this.apihubClient =
      options.apihubClient ??
      new APIHubClient({
        accessToken: options.accessToken,
        serviceAccountJson: options.serviceAccountJson,
      });
    this.authScheme = options.authScheme;
    this.authCredential = options.authCredential;
    this.authConfig = options.authScheme
      ? {
          authScheme: options.authScheme,
          rawAuthCredential: options.authCredential,
          credentialKey: options.credentialKey ?? '',
        }
      : undefined;
    this.preservePropertyNames = options.preservePropertyNames;
    this.headerProvider = options.headerProvider;
    this.credentialKey = options.credentialKey;

    if (!this.lazyLoadSpec) {
      this.startPrepareToolset();
    }
  }

  /**
   * Retrieves all available tools generated from the API Hub specification.
   *
   * @param readonlyContext Optional context used to evaluate `toolFilter`.
   * @returns A list of {@link RestApiTool} instances.
   */
  @experimental
  override async getTools(
    readonlyContext?: ReadonlyContext,
  ): Promise<RestApiTool[]> {
    if (!this.openapiToolset) {
      await this.prepareToolset();
    }
    if (!this.openapiToolset) {
      return [];
    }
    const tools = (await this.openapiToolset.getTools(
      readonlyContext,
    )) as RestApiTool[];
    for (const tool of tools) {
      this.generatedTools[tool.name] = tool;
    }
    return tools;
  }

  /**
   * Retrieves a specific tool by its name.
   *
   * @param name The name of the tool to retrieve.
   * @returns The tool with the given name, or `undefined` if no such tool exists.
   */
  @experimental
  getTool(name: string): RestApiTool | undefined {
    if (!this.openapiToolset) {
      const specResult = this.apihubClient.getSpecContent(
        this.apihubResourceName,
      );
      if (typeof specResult === 'string') {
        this.prepareFromSpec(specResult);
      }
    }
    const tool = this.openapiToolset?.getTool(name);
    if (tool) {
      this.generatedTools[tool.name] = tool;
    }
    return tool ?? this.generatedTools[name];
  }

  /**
   * Closes the underlying OpenAPI toolset and releases any held resources.
   */
  @experimental
  override async close(): Promise<void> {
    if (this.openapiToolset) {
      await this.openapiToolset.close();
    }
  }

  private startPrepareToolset(): void {
    const specResult = this.apihubClient.getSpecContent(
      this.apihubResourceName,
    );
    if (typeof specResult === 'string') {
      this.prepareFromSpec(specResult);
      return;
    }
    const promise = specResult.then((specStr) => {
      this.prepareFromSpec(specStr);
    });
    promise.catch(() => {});
    this.preparingPromise = promise;
  }

  private async prepareToolset(): Promise<void> {
    if (this.preparingPromise) {
      const pending = this.preparingPromise;
      this.preparingPromise = undefined;
      await pending;
      return;
    }
    const specStr = await this.apihubClient.getSpecContent(
      this.apihubResourceName,
    );
    this.prepareFromSpec(specStr);
  }

  private prepareFromSpec(specStr: string): void {
    this.generatedTools = {};
    const {specDict, title, description} = parseSpecDocument(specStr);
    if (!specDict) {
      return;
    }

    this.name = this.name || toSnakeCaseName(title);
    this.description = this.description || description;
    this.openapiToolset = new OpenAPIToolset({
      specDict,
      authCredential: this.authCredential,
      authScheme: this.authScheme as
        | OpenAPIV3.SecuritySchemeObject
        | undefined,
      toolFilter: this.toolFilter,
      prefix: this.prefix,
      preservePropertyNames: this.preservePropertyNames,
      headerProvider: this.headerProvider,
      credentialKey: this.credentialKey,
    });
  }
}

export {
  APIHubToolset as ApiHubToolset,
  type APIHubToolsetOptions as ApiHubToolsetOptions,
};
