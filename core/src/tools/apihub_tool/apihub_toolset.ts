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
import {toSnakeCaseName} from '../../utils/case_utils.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {APIHubClient, BaseAPIHubClient} from './clients/apihub_client.js';

const UNNAMED_TOOLSET = 'unnamed';

/** Options for the API Hub toolset. */
export interface APIHubToolsetOptions {
  /**
   * The resource name of the API, API version or API spec in API Hub, for
   * example `projects/p/locations/l/apis/a`. A name that stops at the API
   * resolves to the first spec of the first version.
   */
  apihubResourceName: string;
  /**
   * Google access token. Generate one with `gcloud auth print-access-token`.
   * Useful for local testing.
   */
  accessToken?: string;
  /**
   * The service account configuration as a JSON string. Required when not
   * using application default credentials.
   */
  serviceAccountJson?: string;
  /** Name of the toolset. Defaults to the snake_case spec title. */
  name?: string;
  /** Description of the toolset. Defaults to the spec description. */
  description?: string;
  /**
   * Fetches the spec on the first getTools() or getTool() call instead of
   * during construction.
   */
  lazyLoadSpec?: boolean;
  /** Auth scheme that applies to every tool in the toolset. */
  authScheme?: AuthScheme;
  /** Auth credential that applies to every tool in the toolset. */
  authCredential?: AuthCredential;
  /** A substitute API Hub client, chiefly for tests. */
  apihubClient?: BaseAPIHubClient;
  /** Selects which of the generated tools the agent sees. */
  toolFilter?: ToolPredicate | string[];
  /** Prefix added to every generated tool name. */
  prefix?: string;
}

/**
 * Generates tools from an API Hub resource.
 *
 * The toolset resolves the resource name to one OpenAPI specification, then
 * hands that specification to `OpenAPIToolset`, so the tools it produces are
 * ordinary `RestApiTool` instances.
 *
 * @example
 * ```ts
 * const apihubToolset = new APIHubToolset({
 *   apihubResourceName: 'projects/p/locations/us-central1/apis/my-api',
 *   serviceAccountJson: serviceAccountJson,
 * });
 *
 * const agent = new LlmAgent({
 *   name: 'api_agent',
 *   model: 'gemini-2.0-flash',
 *   tools: [apihubToolset],
 * });
 * ```
 */
@experimental
export class APIHubToolset extends BaseToolset {
  /** Name of the toolset. Set from the spec title when none was supplied. */
  name: string;
  /** Description of the toolset. Set from the spec when none was supplied. */
  description: string;
  readonly apihubResourceName: string;
  readonly lazyLoadSpec: boolean;

  private readonly apihubClient: BaseAPIHubClient;
  private readonly authScheme?: AuthScheme;
  private readonly authCredential?: AuthCredential;
  private toolsetPromise?: Promise<OpenAPIToolset | undefined>;

  constructor(options: APIHubToolsetOptions) {
    super(options.toolFilter ?? [], options.prefix);
    this.name = options.name ?? '';
    this.description = options.description ?? '';
    this.apihubResourceName = options.apihubResourceName;
    this.lazyLoadSpec = options.lazyLoadSpec ?? false;
    this.authScheme = options.authScheme;
    this.authCredential = options.authCredential;
    this.apihubClient =
      options.apihubClient ??
      new APIHubClient({
        accessToken: options.accessToken,
        serviceAccountJson: options.serviceAccountJson,
      });

    if (!this.lazyLoadSpec) {
      // A constructor cannot await, so the fetch starts here and the first
      // getTools() call reports any failure. The no-op catch keeps Node from
      // reporting an unhandled rejection before that call.
      this.prepare().catch(() => undefined);
    }
  }

  @experimental
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const toolset = await this.prepare();
    return toolset ? toolset.getTools(context) : [];
  }

  /**
   * Returns the generated tool with this name, or undefined.
   *
   * adk-python declares `get_tool` on both `APIHubToolset` and
   * `OpenAPIToolset` at `v0.1.0`, and the `APIHubToolset` class docstring
   * uses it to give one operation to an agent. It is part of the surface this
   * port carries, not a convenience added here.
   */
  @experimental
  async getTool(name: string): Promise<BaseTool | undefined> {
    const tools = await this.getTools();
    return tools.find((tool) => tool.name === name);
  }

  @experimental
  override async close(): Promise<void> {
    // A failed load leaves nothing to close, and getTools() already reports
    // that failure.
    const toolset = await this.toolsetPromise?.catch(() => undefined);
    await toolset?.close();
  }

  /** Fetches and parses the spec once, and reuses the result after that. */
  private prepare(): Promise<OpenAPIToolset | undefined> {
    this.toolsetPromise ??= this.loadToolset();
    return this.toolsetPromise;
  }

  private async loadToolset(): Promise<OpenAPIToolset | undefined> {
    const specStr = await this.apihubClient.getSpecContent(
      this.apihubResourceName,
    );
    const parsed = yaml.load(specStr);
    // An empty spec yields no tools. OpenAPIToolset throws when handed one, so
    // it is never constructed in that case.
    if (!parsed) {
      return undefined;
    }

    const spec = parsed as OpenAPIV3.Document;
    this.name =
      this.name || toSnakeCaseName(spec.info?.title ?? UNNAMED_TOOLSET);
    this.description = this.description || (spec.info?.description ?? '');

    return new OpenAPIToolset({
      specDict: spec,
      authScheme: this.authScheme,
      authCredential: this.authCredential,
      toolFilter: this.toolFilter,
      prefix: this.prefix,
    });
  }
}
