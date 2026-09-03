/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset} from '../base_toolset.js';
import {METADATA_TOOL_FACTORIES} from './metadata_tool.js';
import {createExecuteSqlTool} from './query_tool.js';
import {
  createSimilaritySearchTool,
  createVectorStoreSimilaritySearchTool,
} from './search_tool.js';
import {Capabilities, SpannerToolSettings} from './settings.js';
import {SpannerCredentialsConfig} from './spanner_credentials.js';
import {SpannerTool, SpannerToolFactoryOptions} from './spanner_tool.js';

/** The prefix the toolset puts in front of every tool name. */
export const DEFAULT_SPANNER_TOOL_NAME_PREFIX = 'spanner';

/**
 * Decides whether a tool is exposed to the model.
 *
 * The context is optional because `getTools()` is called without one in some
 * flows, and adk-python evaluates the predicate regardless.
 */
export type SpannerToolPredicate = (
  tool: BaseTool,
  context?: ReadonlyContext,
) => boolean;

/** Constructor options for {@link SpannerToolset}. */
export interface SpannerToolsetOptions {
  /**
   * Which tools to expose, by unprefixed name or by predicate. Omit it to
   * expose all of them; an empty array exposes none.
   */
  toolFilter?: SpannerToolPredicate | string[];
  /** How the tools authenticate. Omit it to use application default credentials. */
  credentialsConfig?: SpannerCredentialsConfig;
  /** The tool settings. Defaults to a fresh {@link SpannerToolSettings}. */
  spannerToolSettings?: SpannerToolSettings;
}

/**
 * Tools for reading a Cloud Spanner database: its tables, schemas, indexes
 * and named schemas, plus read-only SQL and vector similarity search.
 *
 * The tool names are `spanner_list_table_names`, `spanner_list_table_indexes`,
 * `spanner_list_table_index_columns`, `spanner_list_named_schemas`,
 * `spanner_get_table_schema`, `spanner_execute_sql`,
 * `spanner_similarity_search` and `spanner_vector_store_similarity_search`.
 *
 * The data-reading tools appear only when the settings carry
 * {@link Capabilities.DATA_READ}, and the vector store tool only when the
 * settings carry a vector store.
 */
@experimental
export class SpannerToolset extends BaseToolset {
  private readonly credentialsConfig?: SpannerCredentialsConfig;
  private readonly settings: SpannerToolSettings;
  /**
   * The filter as the caller gave it.
   *
   * `BaseToolset` reads an empty array as "no filter", while adk-python reads
   * it as "no tools". The raw option is kept so the adk-python rule can be
   * applied here without changing the shared base class.
   */
  private readonly requestedToolFilter?: SpannerToolPredicate | string[];

  constructor(options: SpannerToolsetOptions = {}) {
    super(options.toolFilter ?? [], DEFAULT_SPANNER_TOOL_NAME_PREFIX);
    this.requestedToolFilter = options.toolFilter;
    this.credentialsConfig = options.credentialsConfig;
    this.settings = options.spannerToolSettings ?? new SpannerToolSettings();
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const factoryOptions: SpannerToolFactoryOptions = {
      credentialsConfig: this.credentialsConfig,
      toolSettings: this.settings,
      prefix: this.prefix,
    };
    const tools = METADATA_TOOL_FACTORIES.map((create) =>
      create(factoryOptions),
    );
    if (this.settings.capabilities.includes(Capabilities.DATA_READ)) {
      tools.push(createExecuteSqlTool(factoryOptions));
      tools.push(createSimilaritySearchTool(factoryOptions));
      if (this.settings.vectorStoreSettings) {
        tools.push(createVectorStoreSimilaritySearchTool(factoryOptions));
      }
    }
    return tools.filter((tool) => this.isSelected(tool, context));
  }

  override async close(): Promise<void> {}

  /**
   * Applies adk-python's filter rule: no filter selects every tool, a
   * predicate decides, and an array selects the names it lists.
   */
  private isSelected(tool: SpannerTool, context?: ReadonlyContext): boolean {
    if (this.requestedToolFilter === undefined) {
      return true;
    }
    if (typeof this.requestedToolFilter === 'function') {
      return this.requestedToolFilter(tool, context);
    }
    return this.requestedToolFilter.includes(tool.baseName);
  }
}
