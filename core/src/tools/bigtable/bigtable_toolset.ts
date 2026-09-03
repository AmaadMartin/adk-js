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
import {GoogleTool} from '../google_tool.js';

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
import {BigtableToolSettings} from './settings.js';

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
  private readonly toolSettings: BigtableToolSettings;
  private readonly clients = new BigtableClientPool();
  /**
   * The filter as the developer wrote it.
   *
   * `BaseToolset.isToolSelected` reads an empty list as "no filter" and
   * returns every tool, where adk-python reads it as a membership test that
   * nothing satisfies. The original value is kept here so that `getTools`
   * can apply adk-python's reading without changing the base class, which
   * other toolsets depend on.
   */
  private readonly filter?: ToolPredicate | string[];

  constructor(options: BigtableToolsetOptions = {}) {
    super(options.toolFilter ?? [], DEFAULT_BIGTABLE_TOOL_NAME_PREFIX);
    this.filter = options.toolFilter;
    this.credentialsConfig = options.credentialsConfig;
    this.toolSettings =
      options.bigtableToolSettings ?? new BigtableToolSettings();
  }

  /** Returns the tools the filter admits, under their unprefixed names. */
  override async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.buildTools().filter((tool) => this.isSelected(tool, context));
  }

  /** Releases every Bigtable client the tools opened. */
  override async close(): Promise<void> {
    return this.clients.close();
  }

  /**
   * Whether the filter admits a tool.
   *
   * Unset admits everything; a list is a membership test, so an empty list
   * admits nothing; a predicate decides. This is adk-python's reading, not
   * the base class's. A predicate with no context to read admits the tool,
   * as `OpenApiToolset` does.
   */
  private isSelected(tool: BaseTool, context?: ReadonlyContext): boolean {
    if (this.filter === undefined) {
      return true;
    }
    if (typeof this.filter === 'function') {
      return context === undefined || this.filter(tool, context);
    }
    return this.filter.includes(tool.name);
  }

  /** Builds one tool per Bigtable operation, in a stable order. */
  private buildTools(): BaseTool[] {
    const credentialsConfig = this.credentialsConfig;
    const toolSettings = this.toolSettings;
    const clients = this.clients;
    const shared = {credentialsConfig, toolSettings};

    return [
      new GoogleTool({
        ...shared,
        name: 'list_instances',
        description:
          'List the Bigtable instance ids in a Google Cloud project.',
        parameters: ProjectSchema,
        execute: async (input, call) =>
          listInstances(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
          ),
      }),
      new GoogleTool({
        ...shared,
        name: 'get_instance_info',
        description: 'Get the metadata of a Bigtable instance.',
        parameters: InstanceSchema,
        execute: async (input, call) =>
          getInstanceInfo(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
            input.instanceId,
          ),
      }),
      new GoogleTool({
        ...shared,
        name: 'list_tables',
        description: 'List the tables of a Bigtable instance.',
        parameters: InstanceSchema,
        execute: async (input, call) =>
          listTables(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
            input.instanceId,
          ),
      }),
      new GoogleTool({
        ...shared,
        name: 'get_table_info',
        description: 'Get the column families of a Bigtable table.',
        parameters: TableSchema,
        execute: async (input, call) =>
          getTableInfo(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
            input.instanceId,
            input.tableId,
          ),
      }),
      new GoogleTool({
        ...shared,
        name: 'list_clusters',
        description: 'List the clusters of a Bigtable instance.',
        parameters: InstanceSchema,
        execute: async (input, call) =>
          listClusters(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
            input.instanceId,
          ),
      }),
      new GoogleTool({
        ...shared,
        name: 'get_cluster_info',
        description: 'Get the metadata of a Bigtable cluster.',
        parameters: ClusterSchema,
        execute: async (input, call) =>
          getClusterInfo(
            await clients.get(input.projectId, call.credentials),
            input.projectId,
            input.instanceId,
            input.clusterId,
          ),
      }),
      new GoogleTool({
        ...shared,
        name: 'execute_sql',
        description: 'Execute a GoogleSQL query against a Bigtable instance.',
        parameters: ExecuteSqlSchema,
        execute: async (input, call) =>
          executeSql(await clients.get(input.projectId, call.credentials), {
            instanceId: input.instanceId,
            query: input.query,
            parameters: input.parameters,
            parameterTypes: input.parameterTypes,
            maxRows: (call.settings ?? toolSettings).maxQueryResultRows,
          }),
      }),
    ];
  }
}
