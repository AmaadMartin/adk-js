/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigQueryOptions} from '@google-cloud/bigquery';
import {
  BaseTool,
  BaseToolset,
  ReadonlyContext,
  ToolPredicate,
} from '@google/adk';

import {BigQueryToolConfig, resolveBigQueryToolConfig} from './config.js';
import {createBigQueryMetadataTools} from './metadata_tool.js';
import {createExecuteSqlTool} from './query_tool.js';
import {BigQueryToolDependencies} from './tool_dependencies.js';

/** How to build a {@link BigQueryToolset}. */
export interface BigQueryToolsetOptions {
  /**
   * Which tools to expose: a list of tool names, or a predicate over the tool
   * and the read-only context. An empty list exposes every tool.
   */
  toolFilter?: ToolPredicate | string[];
  /**
   * Prepended to each tool name, as `myPrefix_get_dataset_info`. A
   * `toolFilter` list then matches the prefixed name, as it does for every
   * other adk-js toolset. The prefix never reaches BigQuery: the user agent
   * keeps the plain tool name.
   */
  prefix?: string;
  /**
   * A pre-built Google auth client for every call, as
   * `@google-cloud/bigquery` accepts it. When it is omitted the tools resolve
   * Application Default Credentials.
   */
  credentials?: BigQueryOptions['authClient'];
  /** The settings every tool in the set shares. */
  toolConfig?: BigQueryToolConfig;
}

/**
 * BigQuery tools for an agent (experimental).
 *
 * The set covers dataset, table and job metadata, and runs SQL through
 * `execute_sql`. That tool admits a SELECT statement and nothing else until
 * `toolConfig.writeMode` says otherwise.
 *
 * ```ts
 * const agent = new LlmAgent({
 *   name: 'data_analyst',
 *   model: 'gemini-2.5-flash',
 *   instruction: 'Answer questions about our BigQuery data.',
 *   tools: [new BigQueryToolset({toolConfig: {location: 'US'}})],
 * });
 * ```
 *
 * @experimental Subject to change; not recommended for production use.
 */
export class BigQueryToolset extends BaseToolset {
  private readonly tools: BaseTool[];

  constructor(options: BigQueryToolsetOptions = {}) {
    super(options.toolFilter ?? [], options.prefix);
    const deps: BigQueryToolDependencies = {
      credentials: options.credentials,
      settings: resolveBigQueryToolConfig(options.toolConfig),
      prefix: options.prefix,
    };
    this.tools = [
      ...createBigQueryMetadataTools(deps),
      createExecuteSqlTool(deps),
    ];
  }

  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools.filter((tool) => {
      if (Array.isArray(this.toolFilter) && this.toolFilter.length > 0) {
        return this.toolFilter.includes(tool.name);
      }
      if (context) {
        return this.isToolSelected(tool, context);
      }
      return true;
    });
  }

  override async close(): Promise<void> {}
}
