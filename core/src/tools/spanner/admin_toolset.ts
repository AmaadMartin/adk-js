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
  SPANNER_TOOL_NAME_PREFIX,
} from './admin_tool.js';
import {
  SpannerCredentialsManager,
  SpannerToolsetCredentialsConfig,
  validateSpannerCredentialsConfig,
} from './spanner_credentials.js';

/** Options for {@link SpannerAdminToolset}. */
export interface SpannerAdminToolsetOptions {
  /**
   * How the tools authenticate. Required: Spanner rejects an unauthenticated
   * call, so there is no working default.
   */
  credentialsConfig: SpannerToolsetCredentialsConfig;
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
 * Reading data is a different concern and is not part of this toolset. Use
 * `SpannerToolset` for tables, schemas and queries.
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
 * for `SpannerToolset`. adk-python filters on the bare name, so a filter
 * ported from Python needs the prefix added: `tool_filter=['list_instances']`
 * becomes `toolFilter: ['spanner_list_instances']`.
 *
 * An empty array exposes no tools, which follows adk-python and not
 * `BaseToolset.isToolSelected`. The base class reads an empty array as "no
 * filter"; this toolset reads an absent option as "no filter" instead, so both
 * intentions stay expressible.
 */
@experimental
export class SpannerAdminToolset extends BaseToolset {
  private readonly tools: BaseTool[];

  /**
   * @throws Error if `credentialsConfig` names no credential source or more
   *   than one.
   */
  constructor(options: SpannerAdminToolsetOptions) {
    // `BaseToolset` requires a filter, so an absent one becomes a predicate
    // that selects everything. That keeps "no filter" distinct from the empty
    // array, which adk-python reads as "expose nothing".
    super(options.toolFilter ?? (() => true), SPANNER_TOOL_NAME_PREFIX);
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
   * Selects a tool the way adk-python's
   * `SpannerAdminToolset._is_tool_selected` does: a name the list carries
   * selects the tool, and an empty list selects none. The inherited version
   * reads an empty list as "no filter" and would expose every tool instead.
   */
  protected override isToolSelected(
    tool: BaseTool,
    context: ReadonlyContext,
  ): boolean {
    const filter = this.toolFilter;
    return Array.isArray(filter)
      ? filter.includes(tool.name)
      : filter(tool, context);
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (context) {
      return this.tools.filter((tool) => this.isToolSelected(tool, context));
    }
    // A predicate needs a context, so without one only a name filter applies.
    // `SpannerToolset` returns every tool in the same situation.
    const filter = this.toolFilter;
    return Array.isArray(filter)
      ? this.tools.filter((tool) => filter.includes(tool.name))
      : this.tools;
  }

  /**
   * A no-op, matching adk-python. Each tool call owns its Spanner client for
   * the length of that call and closes it before it resolves, so the toolset
   * holds no resource to release.
   */
  override async close(): Promise<void> {}
}
