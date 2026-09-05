/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';

import {BigQueryCredentialsConfig} from './bigquery_credentials.js';
import {BigQueryTool} from './bigquery_tool.js';
import {
  DATASET_PARAMETERS,
  GET_DATASET_INFO_DESCRIPTION,
  GET_TABLE_INFO_DESCRIPTION,
  GET_TABLE_INFO_PARAMETERS,
  LIST_DATASET_IDS_DESCRIPTION,
  LIST_DATASET_IDS_PARAMETERS,
  LIST_TABLE_IDS_DESCRIPTION,
  getDatasetInfo,
  getTableInfo,
  listDatasetIds,
  listTableIds,
} from './metadata_tool.js';
import {
  EXECUTE_SQL_DESCRIPTION,
  EXECUTE_SQL_PARAMETERS,
  executeSql,
} from './query_tool.js';

/** The configuration for a {@link BigQueryToolset}. */
export interface BigQueryToolsetOptions {
  /**
   * Which tools to expose: the tool names to keep, or a predicate. An empty
   * array or an absent filter exposes all of them.
   */
  toolFilter?: ToolPredicate | string[];
  /**
   * How to obtain the OAuth credential. When absent the tools run without one
   * and the BigQuery client falls back to application default credentials.
   */
  credentialsConfig?: BigQueryCredentialsConfig;
}

/** Builds the five BigQuery tools, all sharing one credential configuration. */
function createBigQueryTools(
  credentialsConfig?: BigQueryCredentialsConfig,
): BaseTool[] {
  return [
    new BigQueryTool({
      name: 'list_dataset_ids',
      description: LIST_DATASET_IDS_DESCRIPTION,
      parameters: LIST_DATASET_IDS_PARAMETERS,
      execute: listDatasetIds,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'get_dataset_info',
      description: GET_DATASET_INFO_DESCRIPTION,
      parameters: DATASET_PARAMETERS,
      execute: getDatasetInfo,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'list_table_ids',
      description: LIST_TABLE_IDS_DESCRIPTION,
      parameters: DATASET_PARAMETERS,
      execute: listTableIds,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'get_table_info',
      description: GET_TABLE_INFO_DESCRIPTION,
      parameters: GET_TABLE_INFO_PARAMETERS,
      execute: getTableInfo,
      credentialsConfig,
    }),
    new BigQueryTool({
      name: 'execute_sql',
      description: EXECUTE_SQL_DESCRIPTION,
      parameters: EXECUTE_SQL_PARAMETERS,
      execute: executeSql,
      credentialsConfig,
    }),
  ];
}

/**
 * Tools for reading BigQuery data and metadata.
 *
 * The toolset exposes `list_dataset_ids`, `get_dataset_info`,
 * `list_table_ids`, `get_table_info` and `execute_sql`. Each one calls
 * BigQuery with an OAuth credential resolved from `credentialsConfig`, and
 * every tool in a session shares that one authorization.
 */
@experimental
export class BigQueryToolset extends BaseToolset {
  private readonly tools: BaseTool[];

  constructor(options: BigQueryToolsetOptions = {}) {
    super(options.toolFilter ?? []);
    this.tools = createBigQueryTools(options.credentialsConfig);
  }

  /**
   * Returns the tools the filter selects. A name the toolset does not have
   * simply selects nothing.
   *
   * @param context Used only by a predicate filter.
   * @return The selected tools.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    if (context) {
      return this.tools.filter((tool) => this.isToolSelected(tool, context));
    }
    // `isToolSelected` needs a context, and only a predicate filter reads it.
    // Without one, a name filter still applies and a predicate excludes
    // nothing.
    const filter = this.toolFilter;
    if (typeof filter === 'function' || filter.length === 0) {
      return this.tools;
    }
    return this.tools.filter((tool) => filter.includes(tool.name));
  }

  /** Resolves immediately: the tools hold no connection to release. */
  override async close(): Promise<void> {}
}
