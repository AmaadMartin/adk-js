/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The BigQuery toolset.
 *
 * Ported from adk-python
 * `src/google/adk/integrations/bigquery/bigquery_toolset.py` (branch `main`).
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {BigQueryCredentialsConfig} from './bigquery_credentials.js';
import {BigQueryClientCache, BigQueryToolDeps} from './client.js';
import {BigQueryToolConfig, createBigQueryToolConfig} from './config.js';
import {createDataInsightsTool} from './data_insights_tool.js';
import {createMetadataTools} from './metadata_tool.js';
import {createQueryTools} from './query_tool.js';
import {createSearchTool} from './search_tool.js';

/** How to build a {@link BigQueryToolset}. */
export interface BigQueryToolsetOptions {
  /**
   * Which tools to expose: the names to keep, or a predicate. An absent or
   * empty filter exposes all of them, and a name the toolset does not have
   * selects nothing.
   */
  toolFilter?: ToolPredicate | string[];
  /**
   * How the tools authenticate. Absent means the application default
   * credentials of the process.
   */
  credentialsConfig?: BigQueryCredentialsConfig;
  /** How the tools behave. Absent means every default. */
  bigqueryToolConfig?: BigQueryToolConfig;
}

/**
 * Tools for reading BigQuery data and metadata, and for running BigQuery's
 * AI and ML analyses.
 *
 * The toolset exposes eleven tools: `list_dataset_ids`, `get_dataset_info`,
 * `list_table_ids`, `get_table_info`, `get_job_info`, `execute_sql`,
 * `forecast`, `analyze_contribution`, `detect_anomalies`,
 * `ask_data_insights` and `search_catalog`.
 *
 * `@google-cloud/bigquery` and `@google-cloud/dataplex` are optional peer
 * dependencies, loaded on the first tool call. Building a toolset performs no
 * input or output and loads neither package.
 */
@experimental
export class BigQueryToolset extends BaseToolset {
  private readonly clients: BigQueryClientCache;
  private readonly tools: BaseTool[];

  constructor(options: BigQueryToolsetOptions = {}) {
    super(options.toolFilter ?? []);
    this.clients = new BigQueryClientCache(options.credentialsConfig);
    const deps: BigQueryToolDeps = {
      clients: this.clients,
      settings: createBigQueryToolConfig(options.bigqueryToolConfig),
      credentialsConfig: options.credentialsConfig,
    };
    this.tools = [
      ...createMetadataTools(deps),
      ...createQueryTools(deps),
      createDataInsightsTool(deps),
      createSearchTool(deps),
    ];
  }

  /**
   * Returns the tools the filter selects.
   *
   * @param context Read only by a predicate filter.
   * @return The selected tools.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (context) {
      return this.tools.filter((tool) => this.isToolSelected(tool, context));
    }
    // `isToolSelected` needs a context and only a predicate filter reads one.
    // Without a context a name filter still applies, and a predicate excludes
    // nothing.
    const filter = this.toolFilter;
    if (typeof filter === 'function' || filter.length === 0) {
      return this.tools;
    }
    return this.tools.filter((tool) => filter.includes(tool.name));
  }

  /**
   * Drops the BigQuery clients the tools built.
   *
   * adk-python's `close()` is a no-op because it builds a client per call.
   * This one caches them, so it has something to drop.
   */
  override async close(): Promise<void> {
    this.clients.close();
  }
}
