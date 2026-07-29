/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {getLogger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {FunctionTool} from '../function_tool.js';

import {BigtableCredentialsConfig} from './bigtable_credentials.js';
import {BigtableClientPool} from './client.js';
import * as metadataTool from './metadata_tool.js';
import * as queryTool from './query_tool.js';
import {BigtableToolSettings} from './settings.js';

export const DEFAULT_BIGTABLE_TOOL_NAME_PREFIX = 'bigtable';

const logger = getLogger();

/** Options accepted by {@link BigtableToolset}. */
export interface BigtableToolsetOptions {
  toolFilter?: ToolPredicate | string[];
  credentialsConfig?: BigtableCredentialsConfig;
  bigtableToolSettings?: BigtableToolSettings;
  /**
   * Session state keys whose values are injected into every query as trusted
   * parameters. Supplying at least one adds the `execute_sql_parameterized`
   * tool.
   */
  viewParameterNames?: string[];
  /**
   * Prefix prepended to every tool name. Defaults to
   * {@link DEFAULT_BIGTABLE_TOOL_NAME_PREFIX}; pass an empty string for
   * unprefixed names.
   */
  prefix?: string;
}

/** Tools for inspecting Bigtable metadata and running GoogleSQL queries. */
export class BigtableToolset extends BaseToolset {
  private readonly clients: BigtableClientPool;
  private readonly toolSettings?: BigtableToolSettings;
  private readonly viewParameterNames: string[];

  constructor(options?: BigtableToolsetOptions) {
    super(
      options?.toolFilter ?? [],
      options?.prefix ?? DEFAULT_BIGTABLE_TOOL_NAME_PREFIX,
    );
    this.clients = new BigtableClientPool(options?.credentialsConfig);
    this.toolSettings = options?.bigtableToolSettings;
    this.viewParameterNames = options?.viewParameterNames ?? [];
  }

  override async getTools(
    readonlyContext?: ReadonlyContext,
  ): Promise<BaseTool[]> {
    const allTools = [
      new FunctionTool({
        name: this.toolName('list_instances'),
        description: 'List Bigtable instance ids in a Google Cloud project.',
        parameters: metadataTool.ListInstancesArgsSchema,
        execute: async (args) =>
          metadataTool.listInstances(this.clients.forProject(args.projectId)),
      }),
      new FunctionTool({
        name: this.toolName('get_instance_info'),
        description: 'Get metadata information about a Bigtable instance.',
        parameters: metadataTool.GetInstanceInfoArgsSchema,
        execute: async (args) =>
          metadataTool.getInstanceInfo(
            this.clients.forProject(args.projectId),
            args.instanceId,
          ),
      }),
      new FunctionTool({
        name: this.toolName('list_tables'),
        description: 'List tables and their metadata in a Bigtable instance.',
        parameters: metadataTool.ListTablesArgsSchema,
        execute: async (args) =>
          metadataTool.listTables(
            this.clients.forProject(args.projectId),
            args.instanceId,
          ),
      }),
      new FunctionTool({
        name: this.toolName('get_table_info'),
        description: 'Get metadata information about a Bigtable table.',
        parameters: metadataTool.GetTableInfoArgsSchema,
        execute: async (args) =>
          metadataTool.getTableInfo(
            this.clients.forProject(args.projectId),
            args.instanceId,
            args.tableId,
          ),
      }),
      new FunctionTool({
        name: this.toolName('list_clusters'),
        description: 'List clusters and their metadata in a Bigtable instance.',
        parameters: metadataTool.ListClustersArgsSchema,
        execute: async (args) =>
          metadataTool.listClusters(
            this.clients.forProject(args.projectId),
            args.instanceId,
          ),
      }),
      new FunctionTool({
        name: this.toolName('get_cluster_info'),
        description:
          'Get detailed metadata information about a Bigtable cluster.',
        parameters: metadataTool.GetClusterInfoArgsSchema,
        execute: async (args) =>
          metadataTool.getClusterInfo(
            this.clients.forProject(args.projectId),
            args.instanceId,
            args.clusterId,
          ),
      }),
      new FunctionTool({
        name: this.toolName('execute_sql'),
        description: 'Execute a GoogleSQL query from a Bigtable table.',
        parameters: queryTool.ExecuteSqlArgsSchema,
        execute: async (args) =>
          queryTool.executeSql(this.clients.forProject(args.projectId), {
            instanceId: args.instanceId,
            query: args.query,
            parameters: args.parameters,
            parameterTypes: args.parameterTypes,
            settings: this.toolSettings,
          }),
      }),
    ];

    if (this.viewParameterNames.length > 0) {
      allTools.push(
        new FunctionTool({
          name: this.toolName('execute_sql_parameterized'),
          description:
            'Execute a GoogleSQL query from a Bigtable table using parameterized ' +
            'views to securely check permissions. The values of these parameters ' +
            `come from the session and must not be passed in: ${this.viewParameterNames.join(', ')}. ` +
            'Declare their types in parameterTypes like any other parameter.',
          parameters: queryTool.ExecuteSqlArgsSchema,
          execute: async (args, toolContext) =>
            queryTool.executeSql(this.clients.forProject(args.projectId), {
              instanceId: args.instanceId,
              query: args.query,
              parameters: args.parameters,
              parameterTypes: args.parameterTypes,
              viewParameters: this.resolveViewParameters(toolContext),
              settings: this.toolSettings,
            }),
        }),
      );
    }

    return allTools.filter((tool) => {
      if (Array.isArray(this.toolFilter) && this.toolFilter.length > 0) {
        return this.toolFilter.includes(tool.name);
      }
      return readonlyContext
        ? this.isToolSelected(tool, readonlyContext)
        : true;
    });
  }

  override async close(): Promise<void> {
    await this.clients.close();
  }

  private toolName(name: string): string {
    return this.prefix ? `${this.prefix}_${name}` : name;
  }

  /**
   * Reads the configured view parameters out of session state, which the model
   * cannot write to as part of a tool call.
   */
  private resolveViewParameters(
    context?: ReadonlyContext,
  ): queryTool.BigtableQueryParameters {
    const viewParameters: queryTool.BigtableQueryParameters = {};
    if (!context) {
      return viewParameters;
    }

    for (const name of this.viewParameterNames) {
      const value = context.state.get(name);
      if (value === undefined) {
        continue;
      }
      if (!isQueryParameterValue(value)) {
        logger.warn(
          `Bigtable view parameter '${name}' is not a usable query parameter value; skipping it.`,
        );
        continue;
      }
      viewParameters[name] = value;
    }
    return viewParameters;
  }
}

/** Narrows a session state value to something Bigtable accepts as a parameter. */
function isQueryParameterValue(
  value: unknown,
): value is queryTool.BigtableQueryParameterValue {
  switch (typeof value) {
    case 'string':
    case 'number':
    case 'boolean':
    case 'bigint':
      return true;
    default:
      return (
        value === null ||
        value instanceof Uint8Array ||
        value instanceof Date ||
        (Array.isArray(value) && value.every(isQueryParameterValue))
      );
  }
}
