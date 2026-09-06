/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import yaml from 'js-yaml';
import {OpenAPIV3} from 'openapi-types';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {toSnakeCase} from '../../utils/case_utils.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {OpenAPIToolset} from '../openapi_tool/openapi_toolset.js';
import {BaseAPIHubClient} from './clients/apihub_client.js';

/** Toolset name used when the specification carries no title. */
const UNNAMED_TOOLSET = 'unnamed';

/** Options for {@link APIHubToolset}. */
export interface APIHubToolsetOptions {
  /**
   * The API Hub resource name to read the specification from, for example
   * `projects/my-project/locations/us-central1/apis/my-api`.
   */
  apihubResourceName: string;

  /** The client that fetches the specification. */
  apihubClient: BaseAPIHubClient;

  /** Toolset name. Defaults to the snake_cased title of the specification. */
  name?: string;

  /** Toolset description. Defaults to the description in the specification. */
  description?: string;

  /**
   * Whether to defer the fetch until the first `getTools()` call. By default
   * the constructor starts the fetch immediately.
   */
  lazyLoadSpec?: boolean;

  /** Auth scheme applied to every tool in the toolset. */
  authScheme?: OpenAPIV3.SecuritySchemeObject;

  /** Auth credential applied to every tool in the toolset. */
  authCredential?: AuthCredential;

  /** Filter selecting which tools the toolset exposes. */
  toolFilter?: ToolPredicate | string[];
}

/**
 * Generates tools from an API Hub specification.
 *
 * The specification is fetched once per instance and parsed into an
 * {@link OpenAPIToolset}, which produces one tool per operation.
 *
 * @example
 * ```ts
 * const toolset = new APIHubToolset({
 *   apihubResourceName:
 *     'projects/my-project/locations/us-central1/apis/my-api',
 *   apihubClient: myApiHubClient,
 * });
 *
 * const agent = new LlmAgent({
 *   name: 'my_agent',
 *   model: 'gemini-2.0-flash',
 *   tools: [toolset],
 * });
 * ```
 */
@experimental
export class APIHubToolset extends BaseToolset {
  name: string;
  description: string;

  private openapiToolset?: OpenAPIToolset;
  private preparation?: Promise<void>;

  constructor(private readonly options: APIHubToolsetOptions) {
    super(options.toolFilter ?? []);
    this.name = options.name ?? '';
    this.description = options.description ?? '';

    if (!options.lazyLoadSpec) {
      this.startPreparation();
    }
  }

  @experimental
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    await this.startPreparation();
    return this.openapiToolset?.getTools(context) ?? [];
  }

  @experimental
  override async close(): Promise<void> {
    await this.openapiToolset?.close();
  }

  /**
   * Starts the fetch once and returns the same promise on every later call, so
   * the specification is fetched at most once per instance.
   */
  private startPreparation(): Promise<void> {
    if (!this.preparation) {
      this.preparation = this.prepare();
      // Nothing awaits the eager fetch yet, so a failure would be reported as
      // an unhandled rejection. Latch it here; getTools() rethrows it.
      this.preparation.catch(() => {});
    }
    return this.preparation;
  }

  private async prepare(): Promise<void> {
    const specText = await this.options.apihubClient.getSpecContent(
      this.options.apihubResourceName,
    );
    const spec = yaml.load(specText) as OpenAPIV3.Document | undefined;
    if (!spec) {
      return;
    }

    this.name = this.name || toSnakeCase(spec.info?.title ?? UNNAMED_TOOLSET);
    this.description = this.description || spec.info?.description || '';
    this.openapiToolset = new OpenAPIToolset({
      specDict: spec,
      authScheme: this.options.authScheme,
      authCredential: this.options.authCredential,
      toolFilter: this.options.toolFilter,
    });
  }
}
