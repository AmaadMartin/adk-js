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
  createDatabaseTool,
  createInstanceTool,
  createSpannerAdminTool,
  getInstanceConfigTool,
  getInstanceTool,
  listDatabasesTool,
  listInstanceConfigsTool,
  listInstancesTool,
} from './admin_tool.js';
import {
  SpannerCredentialsConfig,
  SpannerCredentialsManager,
  validateSpannerCredentialsConfig,
} from './spanner_credentials.js';

/** Options for {@link SpannerAdminToolset}. */
export interface SpannerAdminToolsetOptions {
  /**
   * How the tools authenticate. Required: Spanner rejects an unauthenticated
   * call, so there is no working default.
   */
  credentialsConfig: SpannerCredentialsConfig;
  /**
   * Names of the tools to expose, or a predicate over them. Both see the tool
   * under its prefixed name. An empty array exposes nothing; omit the option
   * to expose everything.
   */
  toolFilter?: ToolPredicate | string[];
}

/**
 * Tools for administering Spanner instances and databases.
 *
 * The tool names are:
 *   - `spanner_create_database`
 *   - `spanner_list_instances`
 *   - `spanner_get_instance`
 *   - `spanner_list_databases`
 *   - `spanner_create_instance`
 *   - `spanner_list_instance_configs`
 *   - `spanner_get_instance_config`
 *
 * `spanner_create_instance` and `spanner_create_database` provision billable
 * Cloud Spanner resources. Pass a `toolFilter` naming only the five read-only
 * tools for an agent that inspects a project but cannot change it.
 *
 * Reading data is a different concern and is not part of this toolset: no
 * tool here reads a table, a schema or a query result.
 *
 * Every tool answers with a `SpannerToolResult` and never throws.
 *
 * Requires the optional peer dependency `@google-cloud/spanner`, which is
 * loaded on the first tool call. Install it with
 * `npm install @google-cloud/spanner`.
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
 * A `toolFilter` given as a string array matches the prefixed name, as it does
 * for `MCPToolset` and `OpenAPIToolset`. adk-python filters on the bare name,
 * so a filter ported from Python needs the prefix added:
 * `tool_filter=['list_instances']` becomes
 * `toolFilter: ['spanner_list_instances']`.
 *
 */
@experimental
export class SpannerAdminToolset extends BaseToolset {
  private readonly tools: BaseTool[];

  /**
   * @throws Error if `credentialsConfig` names no credential source or more
   *   than one.
   */
  constructor(options: SpannerAdminToolsetOptions) {
    super(options.toolFilter ?? (() => true));
    validateSpannerCredentialsConfig(options.credentialsConfig);
    const credentials = new SpannerCredentialsManager(
      options.credentialsConfig,
    );

    // The order adk-python's `SpannerAdminToolset.get_tools` builds them in.
    this.tools = [
      createSpannerAdminTool(credentials, createDatabaseTool),
      createSpannerAdminTool(credentials, listInstancesTool),
      createSpannerAdminTool(credentials, getInstanceTool),
      createSpannerAdminTool(credentials, listDatabasesTool),
      createSpannerAdminTool(credentials, createInstanceTool),
      createSpannerAdminTool(credentials, listInstanceConfigsTool),
      createSpannerAdminTool(credentials, getInstanceConfigTool),
    ];
  }

  /**
   * Filters here rather than through the inherited `isToolSelected`, which
   * reads an empty list as "no filter" and would expose every tool.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const filter = this.toolFilter;
    if (Array.isArray(filter)) {
      return this.tools.filter((tool) => filter.includes(tool.name));
    }
    return context
      ? this.tools.filter((tool) => filter(tool, context))
      : this.tools;
  }

  /**
   * A no-op, matching adk-python. Each tool call owns its Spanner client for
   * the length of that call and closes it before it resolves, so the toolset
   * holds no resource to release.
   */
  override async close(): Promise<void> {}
}
