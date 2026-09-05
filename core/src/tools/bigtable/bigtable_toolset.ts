/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {experimental} from '../../utils/experimental.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {ToolInputParameters} from '../function_tool.js';
import {GoogleTool, GoogleToolExecuteFunction} from '../google_tool.js';

import {BigtableCredentialsConfig} from './bigtable_credentials.js';
import {BigtableClientPool} from './client.js';
import {
  getClusterInfo,
  getInstanceInfo,
  getTableInfo,
  listClusters,
  listInstances,
  listTables,
} from './metadata_tool.js';
import {SQL_PARAMETER_TYPE_NAMES, executeSql} from './query_tool.js';
import {
  BigtableToolSettings,
  DEFAULT_MAX_QUERY_RESULT_ROWS,
} from './settings.js';

/** The prefix the toolset gives every tool name it exposes to the model. */
export const DEFAULT_BIGTABLE_TOOL_NAME_PREFIX = 'bigtable';

const projectId = z
  .string()
  .describe('The Google Cloud project id that holds the instance.');
const instanceId = z.string().describe('The Bigtable instance id.');

const ProjectSchema = z.object({projectId});
const InstanceSchema = z.object({projectId, instanceId});
const TableSchema = z.object({
  projectId,
  instanceId,
  tableId: z.string().describe('The Bigtable table id.'),
});
const ClusterSchema = z.object({
  projectId,
  instanceId,
  clusterId: z.string().describe('The Bigtable cluster id.'),
});
const ExecuteSqlSchema = z.object({
  projectId,
  instanceId,
  query: z.string().describe('The GoogleSQL query to run.'),
  parameters: z
    .record(
      z.string(),
      z.union([z.string(), z.number(), z.boolean(), z.null()]),
    )
    .optional()
    .describe(
      'Values for the query parameters, keyed by the `@name` used in query.',
    ),
  parameterTypes: z
    .record(z.string(), z.enum(SQL_PARAMETER_TYPE_NAMES))
    .optional()
    .describe(
      'The GoogleSQL type of each query parameter, keyed by parameter name.',
    ),
});

/** Options accepted by {@link BigtableToolset}. */
export interface BigtableToolsetOptions {
  /**
   * Which tools to expose: a list of unprefixed tool names, or a predicate.
   * An empty list exposes none. Leave it unset to expose all of them.
   */
  toolFilter?: ToolPredicate | string[];
  /** How the tools obtain credentials. Unset means application default. */
  credentialsConfig?: BigtableCredentialsConfig;
  /** Settings shared by every tool, such as the query row cap. */
  bigtableToolSettings?: BigtableToolSettings;
}

/** The filter a toolset built without one uses: every tool is admitted. */
const passAll: ToolPredicate = () => true;

/** One Bigtable operation: the tool, plus the name a filter matches. */
interface BigtableToolEntry {
  operation: string;
  tool: BaseTool;
}

/**
 * Tools for reading Bigtable data and metadata (Experimental).
 *
 * The tools it exposes, once the prefix is applied, are
 * `bigtable_list_instances`, `bigtable_get_instance_info`,
 * `bigtable_list_tables`, `bigtable_get_table_info`,
 * `bigtable_list_clusters`, `bigtable_get_cluster_info` and
 * `bigtable_execute_sql`.
 *
 * Constructing the toolset performs no I/O: the Bigtable package is loaded,
 * and a client opened, on the first tool call.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class BigtableToolset extends BaseToolset {
  private readonly credentialsConfig?: BigtableCredentialsConfig;
  private readonly toolSettings?: BigtableToolSettings;
  private readonly clients = new BigtableClientPool();

  constructor(options: BigtableToolsetOptions = {}) {
    // An unset filter becomes a pass-all predicate rather than `[]`, because
    // the base class reads `[]` as no filter while adk-python reads it as a
    // membership test that nothing satisfies.
    super(options.toolFilter ?? passAll, DEFAULT_BIGTABLE_TOOL_NAME_PREFIX);
    this.credentialsConfig = options.credentialsConfig;
    this.toolSettings = options.bigtableToolSettings;
  }

  /**
   * Returns the tools the filter admits, under their prefixed names.
   *
   * The prefix is applied here, as `McpToolset` and `OpenApiToolset` apply
   * theirs, because nothing downstream applies it. The filter still names the
   * unprefixed operation, which is how adk-python's filter reads.
   */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.buildTools()
      .filter((entry) => this.isSelected(entry, context))
      .map((entry) => entry.tool);
  }

  /** Releases every Bigtable client the tools opened. */
  override async close(): Promise<void> {
    return this.clients.close();
  }

  /**
   * Whether the filter admits an operation.
   *
   * A list is a membership test, so an empty list admits nothing. A predicate
   * with no context to read admits the tool, as `OpenApiToolset` does.
   */
  private isSelected(
    entry: BigtableToolEntry,
    context?: ReadonlyContext,
  ): boolean {
    if (typeof this.toolFilter === 'function') {
      return context === undefined || this.toolFilter(entry.tool, context);
    }
    return this.toolFilter.includes(entry.operation);
  }

  /** Builds the tool for one Bigtable operation. */
  private buildTool<TParameters extends ToolInputParameters>(
    operation: string,
    description: string,
    parameters: TParameters,
    execute: GoogleToolExecuteFunction<TParameters>,
  ): BigtableToolEntry {
    return {
      operation,
      tool: new GoogleTool({
        name: `${DEFAULT_BIGTABLE_TOOL_NAME_PREFIX}_${operation}`,
        description,
        parameters,
        execute,
        credentialsConfig: this.credentialsConfig,
      }),
    };
  }

  /** Builds one tool per Bigtable operation, in a stable order. */
  private buildTools(): BigtableToolEntry[] {
    const clients = this.clients;

    return [
      this.buildTool(
        'list_instances',
        'List the Bigtable instance ids in a Google Cloud project.',
        ProjectSchema,
        async (input, call) =>
          listInstances(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
          ),
      ),
      this.buildTool(
        'get_instance_info',
        'Get the metadata of a Bigtable instance.',
        InstanceSchema,
        async (input, call) =>
          getInstanceInfo(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
            input.instanceId,
          ),
      ),
      this.buildTool(
        'list_tables',
        'List the tables of a Bigtable instance.',
        InstanceSchema,
        async (input, call) =>
          listTables(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
            input.instanceId,
          ),
      ),
      this.buildTool(
        'get_table_info',
        'Get the column families of a Bigtable table.',
        TableSchema,
        async (input, call) =>
          getTableInfo(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
            input.instanceId,
            input.tableId,
          ),
      ),
      this.buildTool(
        'list_clusters',
        'List the clusters of a Bigtable instance.',
        InstanceSchema,
        async (input, call) =>
          listClusters(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
            input.instanceId,
          ),
      ),
      this.buildTool(
        'get_cluster_info',
        'Get the metadata of a Bigtable cluster.',
        ClusterSchema,
        async (input, call) =>
          getClusterInfo(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
            input.instanceId,
            input.clusterId,
          ),
      ),
      this.buildTool(
        'execute_sql',
        'Execute a GoogleSQL query against a Bigtable instance.',
        ExecuteSqlSchema,
        async (input, call) =>
          executeSql(await clients.get(input.projectId, call.credentials), {
            instanceId: input.instanceId,
            query: input.query,
            parameters: input.parameters,
            parameterTypes: input.parameterTypes,
            maxRows:
              this.toolSettings?.maxQueryResultRows ??
              DEFAULT_MAX_QUERY_RESULT_ROWS,
          }),
      ),
    ];
  }
}
