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

/** Options for {@link APIHubToolset}. */
export interface APIHubToolsetOptions {
  /**
   * The API Hub resource name. It must name an API, and may also name a
   * version and a spec, for example
   * `projects/p/locations/l/apis/a/versions/v/specs/s`. A Cloud Console API
   * Hub URL is also accepted.
   */
  apihubResourceName: string;
  /**
   * A Google access token, for example from `gcloud auth
   * print-access-token`. Ignored when `apihubClient` is set.
   */
  accessToken?: string;
  /**
   * A service account key, as a JSON string. Ignored when `apihubClient` is
   * set.
   */
  serviceAccountJson?: string;
  /** Name of the toolset. Defaults to the spec's title, in snake_case. */
  name?: string;
  /** Description of the toolset. Defaults to the spec's description. */
  description?: string;
  /**
   * Fetches the spec on the first `getTools()` call instead of at
   * construction time.
   */
  lazyLoadSpec?: boolean;
  /** Auth scheme that applies to every tool in the toolset. */
  authScheme?: AuthScheme;
  /** Auth credential that applies to every tool in the toolset. */
  authCredential?: AuthCredential;
  /** Fetches the spec. Overrides `accessToken` and `serviceAccountJson`. */
  apihubClient?: BaseAPIHubClient;
  /** Selects which of the generated tools the toolset exposes. */
  toolFilter?: ToolPredicate | string[];
}

/**
 * Generates tools from an API Hub resource.
 *
 * ```ts
 * const toolset = new APIHubToolset({
 *   apihubResourceName:
 *     'projects/test-project/locations/us-central1/apis/test-api',
 *   serviceAccountJson: serviceAccountKey,
 * });
 * const agent = new LlmAgent({
 *   name: 'api_agent',
 *   model: 'gemini-flash-latest',
 *   tools: [toolset],
 * });
 * ```
 *
 * The resource name must name an API, and may also name a version and a spec.
 * A resource name that names a spec uses that spec. A resource name that names
 * only an API or a version uses the first spec of the first version.
 *
 * A TypeScript constructor cannot await, so the spec arrives after the
 * constructor returns. A spec that fails to fetch or to parse rejects the
 * first `getTools()` call, and the next call fetches it again.
 */
@experimental
export class APIHubToolset extends BaseToolset {
  /**
   * Name of the toolset. Empty until the spec is prepared, unless the
   * constructor set it.
   */
  name: string;
  /**
   * Description of the toolset. Empty until the spec is prepared, unless the
   * constructor set it.
   */
  description: string;
  private readonly apihubClient: BaseAPIHubClient;
  private readonly apihubResourceName: string;
  private readonly authScheme?: AuthScheme;
  private readonly authCredential?: AuthCredential;
  private openapiToolset?: OpenAPIToolset;
  private prepared?: Promise<void>;

  constructor(options: APIHubToolsetOptions) {
    super(options.toolFilter ?? []);
    this.name = options.name ?? '';
    this.description = options.description ?? '';
    this.apihubResourceName = options.apihubResourceName;
    this.authScheme = options.authScheme;
    this.authCredential = options.authCredential;
    this.apihubClient =
      options.apihubClient ??
      new APIHubClient({
        accessToken: options.accessToken,
        serviceAccountJson: options.serviceAccountJson,
      });

    if (!options.lazyLoadSpec) {
      this.prepared = this.prepareToolset();
      // Nothing awaits this promise yet, and an unhandled rejection would end
      // the process. getTools() still reports the failure.
      this.prepared.catch(() => {});
    }
  }

  @experimental
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    this.prepared ??= this.prepareToolset();
    try {
      await this.prepared;
    } catch (e: unknown) {
      // Fetch again on the next call, as the Python SDK does.
      this.prepared = undefined;
      throw e;
    }
    return this.openapiToolset?.getTools(context) ?? [];
  }

  @experimental
  override async close(): Promise<void> {
    await this.openapiToolset?.close();
  }

  private async prepareToolset(): Promise<void> {
    const specStr = await this.apihubClient.getSpecContent(
      this.apihubResourceName,
    );
    const spec = yaml.load(specStr) as OpenAPIV3.Document | undefined;
    // An empty document parses to undefined, and a document that holds plain
    // text parses to a string. Neither carries an `info` block or a path, so
    // the toolset stays unprepared and exposes no tool.
    if (!spec || typeof spec !== 'object') {
      return;
    }

    // A spec is remote content, so its `info` block may be absent, and YAML
    // parses an unquoted `title: 1.0` as a number.
    const title =
      typeof spec.info?.title === 'string' ? spec.info.title : 'unnamed';
    const description =
      typeof spec.info?.description === 'string' ? spec.info.description : '';
    this.name ||= snakeCase(title);
    this.description ||= description;

    this.openapiToolset = new OpenAPIToolset({
      specDict: spec,
      authScheme: this.authScheme,
      authCredential: this.authCredential,
      toolFilter: this.toolFilter,
    });
  }
}
