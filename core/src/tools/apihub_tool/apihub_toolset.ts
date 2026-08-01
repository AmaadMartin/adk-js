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
import {snakeCase} from '../../utils/case_utils.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {APIHubClient, BaseAPIHubClient} from './clients/apihub_client.js';

/** The part of an OpenAPI document the toolset reads for its own metadata. */
interface OpenApiInfo {
  title?: string;
  description?: string;
}

/** Options for {@link APIHubToolset}. */
export interface APIHubToolsetOptions {
  /**
   * The API Hub resource name, or the Cloud Console API Hub URL for it. It
   * must name an API and may additionally name a version and a spec.
   */
  apihubResourceName: string;
  /**
   * Google access token, e.g. from `gcloud auth print-access-token`. Used for
   * fetching the spec from API Hub.
   */
  accessToken?: string;
  /**
   * The service account config as a JSON string. Required if not relying on
   * Application Default Credentials.
   */
  serviceAccountJson?: string;
  /** Name of the toolset. Defaults to snake_case of the spec's title. */
  name?: string;
  /** Description of the toolset. Defaults to the spec's description. */
  description?: string;
  /**
   * If true, the spec is fetched on the first `getTools()` call instead of
   * during construction.
   */
  lazyLoadSpec?: boolean;
  /** Auth scheme that applies to all the tools in the toolset. */
  authScheme?: AuthScheme;
  /** Auth credential that applies to all the tools in the toolset. */
  authCredential?: AuthCredential;
  /** A custom API Hub client to fetch the spec with. */
  apihubClient?: BaseAPIHubClient;
  /**
   * The filter used to select the tools in the toolset. Either a predicate or
   * a list of tool names to expose.
   */
  toolFilter?: ToolPredicate | string[];
}

/**
 * Generates tools from a spec registered in Google Cloud API Hub.
 *
 * The spec named by `apihubResourceName` is fetched from API Hub and handed to
 * an {@link OpenAPIToolset}, which generates one tool per operation.
 *
 * Unless `lazyLoadSpec` is set, constructing the toolset starts the fetch, so
 * construction performs network I/O.
 *
 * @example
 * ```ts
 * const toolset = new APIHubToolset({
 *   apihubResourceName:
 *     'projects/test-project/locations/us-central1/apis/test-api',
 *   toolFilter: ['my_tool'],
 * });
 * const agent = new LlmAgent({name: 'a', model: 'gemini-2.5-flash',
 *                             tools: [toolset]});
 * ```
 */
@experimental
export class APIHubToolset extends BaseToolset {
  /** Name of the toolset. Derived from the spec's title once it loads. */
  name: string;
  /** Description of the toolset. Taken from the spec once it loads. */
  description: string;

  private readonly apihubResourceName: string;
  private readonly lazyLoadSpec: boolean;
  private readonly apihubClient: BaseAPIHubClient;
  private readonly authScheme?: AuthScheme;
  private readonly authCredential?: AuthCredential;
  private openapiToolset?: OpenAPIToolset;
  private preparePromise?: Promise<void>;

  constructor(options: APIHubToolsetOptions) {
    super(options.toolFilter ?? []);
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

    if (!this.lazyLoadSpec) {
      this.preparePromise = this.prepareToolset();
      // Nothing awaits the promise yet, so mark a rejection handled here to
      // keep it from surfacing as an unhandled rejection. The rejection is
      // still delivered to the await in getTools().
      this.preparePromise.catch(() => {});
    }
  }

  @experimental
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    this.preparePromise ??= this.prepareToolset();
    await this.preparePromise;
    return this.openapiToolset ? this.openapiToolset.getTools(context) : [];
  }

  @experimental
  override async close(): Promise<void> {
    await this.openapiToolset?.close();
  }

  private async prepareToolset(): Promise<void> {
    const specStr = await this.apihubClient.getSpecContent(
      this.apihubResourceName,
    );
    // js-yaml parses JSON too, since JSON is a subset of YAML.
    const spec: unknown = yaml.load(specStr);
    // An empty spec leaves the toolset with no tools rather than throwing,
    // matching adk-python. OpenAPIToolset rejects an absent spec outright.
    if (!spec || typeof spec !== 'object') {
      return;
    }

    const info = (spec as {info?: OpenApiInfo}).info;
    this.name = this.name || snakeCase(info?.title ?? 'unnamed');
    this.description = this.description || (info?.description ?? '');

    this.openapiToolset = new OpenAPIToolset({
      specDict: spec as OpenAPIV3.Document,
      authCredential: this.authCredential,
      authScheme: this.authScheme,
      toolFilter: this.toolFilter,
    });
  }
}
