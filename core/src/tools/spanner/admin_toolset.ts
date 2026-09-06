/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {
  createSpannerAdminTools,
  SPANNER_TOOL_NAME_PREFIX,
} from './admin_tool.js';
import {
  SpannerCredentialsConfig,
  SpannerCredentialsManager,
  validateSpannerCredentialsConfig,
} from './spanner_credentials.js';

/** Options for {@link SpannerAdminToolset}. */
export interface SpannerAdminToolsetOptions {
  /**
   * How the tools authenticate. Required: the Spanner Admin API rejects an
   * unauthenticated call, so there is no working default.
   */
  credentialsConfig: SpannerCredentialsConfig;
  /**
   * Names of the tools to expose, or a predicate over them. Both see the tool
   * under its prefixed name.
   */
  toolFilter?: ToolPredicate | string[];
}

/**
 * Tools for Spanner administration: instances, instance configs and databases.
 *
 * The tool names are:
 *   - `spanner_list_instances`
 *   - `spanner_get_instance`
 *   - `spanner_list_instance_configs`
 *   - `spanner_get_instance_config`
 *   - `spanner_create_instance`
 *   - `spanner_list_databases`
 *   - `spanner_create_database`
 *
 * Every tool answers with a {@link SpannerToolResult} and never throws.
 * `spanner_create_instance` and `spanner_create_database` create billable
 * Google Cloud resources, and both wait for the long-running operation,
 * bounded at 300 seconds.
 *
 * Requires the optional peer dependency `@google-cloud/spanner-api`, which is
 * loaded on the first tool call. Install it with
 * `npm install @google-cloud/spanner-api`.
 *
 * One identity for every end user, from Application Default Credentials:
 *
 * ```ts
 * const authClient = await new GoogleAuth({
 *   scopes: [...SPANNER_DEFAULT_SCOPES],
 * }).getClient();
 * const toolset = new SpannerAdminToolset({credentialsConfig: {authClient}});
 * ```
 *
 * Each end user acting as themselves, through the OAuth flow:
 *
 * ```ts
 * const toolset = new SpannerAdminToolset({
 *   credentialsConfig: {
 *     clientId: process.env.SPANNER_OAUTH_CLIENT_ID,
 *     clientSecret: process.env.SPANNER_OAUTH_CLIENT_SECRET,
 *   },
 * });
 * ```
 *
 * A `toolFilter` given as a string array matches the prefixed name, as it does
 * for `MCPToolset` and `OpenAPIToolset`. adk-python filters on the bare name,
 * so a filter ported from Python needs the prefix added:
 *
 * ```ts
 * const toolset = new SpannerAdminToolset({
 *   credentialsConfig,
 *   toolFilter: ['spanner_list_instances', 'spanner_list_databases'],
 * });
 * ```
 */
@experimental
export class SpannerAdminToolset extends BaseToolset {
  private readonly tools: BaseTool[];

  /**
   * @throws Error if `credentialsConfig` names no credential source, or more
   *   than one. See {@link validateSpannerCredentialsConfig}.
   */
  constructor(options: SpannerAdminToolsetOptions) {
    super(options.toolFilter ?? [], SPANNER_TOOL_NAME_PREFIX);
    validateSpannerCredentialsConfig(options.credentialsConfig);
    this.tools = createSpannerAdminTools(
      new SpannerCredentialsManager(options.credentialsConfig),
    );
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (context) {
      return this.tools.filter((tool) => this.isToolSelected(tool, context));
    }
    // A predicate needs a context, so without one only a name filter applies.
    const names = this.toolFilter;
    return Array.isArray(names) && names.length > 0
      ? this.tools.filter((tool) => names.includes(tool.name))
      : this.tools;
  }

  /**
   * A no-op, matching adk-python. Each tool call owns its Admin API clients
   * for the length of that call and closes them before it resolves, so the
   * toolset holds no resource to release.
   */
  override async close(): Promise<void> {}
}
