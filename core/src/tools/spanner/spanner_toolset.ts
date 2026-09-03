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
  getTableSchemaTool,
  listNamedSchemasTool,
  listTableIndexColumnsTool,
  listTableIndexesTool,
  listTableNamesTool,
} from './metadata_tool.js';
import {getExecuteSqlTool} from './query_tool.js';
import {
  getVectorStoreSimilaritySearchTool,
  similaritySearchTool,
} from './search_tool.js';
import {
  Capabilities,
  resolveVectorStoreSettings,
  SpannerToolSettings,
} from './settings.js';
import {
  SpannerCredentialsConfig,
  SpannerCredentialsManager,
  validateSpannerCredentialsConfig,
} from './spanner_credentials.js';
import {createSpannerTool, SPANNER_TOOL_NAME_PREFIX} from './spanner_tool.js';

/** Options for {@link SpannerToolset}. */
export interface SpannerToolsetOptions {
  /**
   * How the tools authenticate. Required: Spanner rejects an unauthenticated
   * call, so there is no working default.
   */
  credentialsConfig: SpannerCredentialsConfig;
  /**
   * What the tools may do, how many rows a query returns, and which vector
   * store to search. Defaults to read-only data access with no vector store.
   */
  spannerToolSettings?: SpannerToolSettings;
  /**
   * Names of the tools to expose, or a predicate over them. Both see the tool
   * under its prefixed name. An empty array exposes nothing; omit the option
   * to expose everything.
   */
  toolFilter?: ToolPredicate | string[];
}

/**
 * Tools for reading Spanner data, schemas and indexes.
 *
 * The tool names are:
 *   - `spanner_list_table_names`
 *   - `spanner_list_table_indexes`
 *   - `spanner_list_table_index_columns`
 *   - `spanner_list_named_schemas`
 *   - `spanner_get_table_schema`
 *   - `spanner_execute_sql` (needs `Capabilities.DATA_READ`)
 *   - `spanner_similarity_search` (needs `Capabilities.DATA_READ`)
 *   - `spanner_vector_store_similarity_search` (needs `Capabilities.DATA_READ`
 *     and `vectorStoreSettings`)
 *
 * Every tool answers with a `SpannerToolResult` and never throws. Nothing
 * writes: each statement runs in a read-only snapshot.
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
 * const toolset = new SpannerToolset({credentialsConfig: {authClient}});
 * ```
 *
 * A `toolFilter` given as a string array matches the prefixed name, as it does
 * for `MCPToolset` and `OpenAPIToolset`. adk-python filters on the bare name,
 * so a filter ported from Python needs the prefix added:
 * `tool_filter=['execute_sql']` becomes
 * `toolFilter: ['spanner_execute_sql']`.
 *
 * An empty array exposes no tools, which follows adk-python and not
 * `BaseToolset.isToolSelected`. The base class reads an empty array as "no
 * filter"; this toolset reads an absent option as "no filter" instead, so both
 * intentions stay expressible.
 */
@experimental
export class SpannerToolset extends BaseToolset {
  private readonly tools: BaseTool[];

  /**
   * @throws Error if `credentialsConfig` names no credential source or more
   *   than one, or if `vectorStoreSettings` is not usable.
   */
  constructor(options: SpannerToolsetOptions) {
    // `BaseToolset` requires a filter, so an absent one becomes a predicate
    // that selects everything. That keeps "no filter" distinct from the empty
    // array, which adk-python reads as "expose nothing".
    super(options.toolFilter ?? (() => true), SPANNER_TOOL_NAME_PREFIX);
    validateSpannerCredentialsConfig(options.credentialsConfig);
    const settings = options.spannerToolSettings ?? {};
    if (settings.vectorStoreSettings) {
      resolveVectorStoreSettings(settings.vectorStoreSettings);
    }
    const credentials = new SpannerCredentialsManager(
      options.credentialsConfig,
    );

    this.tools = [
      createSpannerTool(credentials, listTableNamesTool),
      createSpannerTool(credentials, listTableIndexesTool),
      createSpannerTool(credentials, listTableIndexColumnsTool),
      createSpannerTool(credentials, listNamedSchemasTool),
      createSpannerTool(credentials, getTableSchemaTool),
    ];
    const capabilities = settings.capabilities ?? [Capabilities.DATA_READ];
    if (capabilities.includes(Capabilities.DATA_READ)) {
      this.tools.push(
        createSpannerTool(credentials, getExecuteSqlTool(settings)),
        createSpannerTool(credentials, similaritySearchTool),
      );
      if (settings.vectorStoreSettings) {
        this.tools.push(
          createSpannerTool(
            credentials,
            getVectorStoreSimilaritySearchTool(settings),
          ),
        );
      }
    }
  }

  /**
   * Selects a tool the way adk-python's `SpannerToolset._is_tool_selected`
   * does: a name the list carries selects the tool, and an empty list selects
   * none. The inherited version reads an empty list as "no filter" and would
   * expose every tool instead.
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
    // `OpenAPIToolset` returns every tool in the same situation.
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
