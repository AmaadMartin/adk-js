/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {BaseTool} from '../base_tool.js';
import {FunctionTool} from '../function_tool.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {Context} from '../../agents/context.js';
import {BigtableToolSettings} from './settings.js';
import {BigtableCredentialsConfig} from './bigtable_credentials.js';
import * as metadataTool from './metadata_tool.js';
import * as queryTool from './query_tool.js';

export const DEFAULT_BIGTABLE_TOOL_NAME_PREFIX = 'bigtable';

export class BigtableToolset extends BaseToolset {
  private readonly config?: BigtableCredentialsConfig;
  private readonly toolSettings?: BigtableToolSettings;
  private readonly viewParameterNames?: string[];

  constructor(options?: {
    toolFilter?: ToolPredicate | string[];
    credentialsConfig?: BigtableCredentialsConfig;
    bigtableToolSettings?: BigtableToolSettings;
    viewParameterNames?: string[];
  }) {
    super(options?.toolFilter || [], DEFAULT_BIGTABLE_TOOL_NAME_PREFIX);
    this.config = options?.credentialsConfig;
    this.toolSettings = options?.bigtableToolSettings;
    this.viewParameterNames = options?.viewParameterNames;
  }

  async getTools(readonlyContext?: ReadonlyContext): Promise<BaseTool[]> {
    const allTools: BaseTool[] = [
      new FunctionTool({
        name: 'bigtable_list_instances',
        description: 'List Bigtable instance ids in a Google Cloud project.',
        parameters: metadataTool.ListInstancesArgsSchema,
        execute: async (args) => metadataTool.listInstances(args.projectId, this.config),
      }),
      new FunctionTool({
        name: 'bigtable_get_instance_info',
        description: 'Get metadata information about a Bigtable instance.',
        parameters: metadataTool.GetInstanceInfoArgsSchema,
        execute: async (args) => metadataTool.getInstanceInfo(args.projectId, args.instanceId, this.config),
      }),
      new FunctionTool({
        name: 'bigtable_list_tables',
        description: 'List tables and their metadata in a Bigtable instance.',
        parameters: metadataTool.ListTablesArgsSchema,
        execute: async (args) => metadataTool.listTables(args.projectId, args.instanceId, this.config),
      }),
      new FunctionTool({
        name: 'bigtable_get_table_info',
        description: 'Get metadata information about a Bigtable table.',
        parameters: metadataTool.GetTableInfoArgsSchema,
        execute: async (args) => metadataTool.getTableInfo(args.projectId, args.instanceId, args.tableId, this.config),
      }),
      new FunctionTool({
        name: 'bigtable_list_clusters',
        description: 'List clusters and their metadata in a Bigtable instance.',
        parameters: metadataTool.ListClustersArgsSchema,
        execute: async (args) => metadataTool.listClusters(args.projectId, args.instanceId, this.config),
      }),
      new FunctionTool({
        name: 'bigtable_get_cluster_info',
        description: 'Get detailed metadata information about a Bigtable cluster.',
        parameters: metadataTool.GetClusterInfoArgsSchema,
        execute: async (args) => metadataTool.getClusterInfo(args.projectId, args.instanceId, args.clusterId, this.config),
      }),
      new FunctionTool({
        name: 'execute_sql',
        description: 'Execute a GoogleSQL query from a Bigtable table.',
        parameters: queryTool.ExecuteSqlArgsSchema,
        execute: async (args) => queryTool.executeSql(
          args.projectId,
          args.instanceId,
          args.query,
          this.config,
          this.toolSettings,
          args.parameters,
          args.parameterTypes,
          args._viewParameters
        ),
      }),
    ];

    if (this.viewParameterNames && this.viewParameterNames.length > 0) {
      allTools.push(
        new FunctionTool({
          name: 'execute_sql_parameterized',
          description: 'Execute a GoogleSQL query from a Bigtable table using parameterized views to securely check permissions.',
          parameters: queryTool.ExecuteSqlArgsSchema,
          execute: async (args, toolContext?: Context) => {
             const viewParams: Record<string, any> = {};
             if (toolContext) {
               for (const paramName of this.viewParameterNames!) {
                 if ((toolContext as any)[paramName] !== undefined) {
                   viewParams[paramName] = (toolContext as any)[paramName];
                 } else if (toolContext.state && (toolContext.state as any)[paramName] !== undefined) {
                   viewParams[paramName] = (toolContext.state as any)[paramName];
                 }
               }
             }
             const finalViewParams = { ...args._viewParameters, ...viewParams };
             return queryTool.executeSql(
               args.projectId,
               args.instanceId,
               args.query,
               this.config,
               this.toolSettings,
               args.parameters,
               args.parameterTypes,
               Object.keys(finalViewParams).length > 0 ? finalViewParams : undefined
             );
          }
        })
      );
    }

    return allTools.filter(tool => {
        return this.isToolSelected(tool, readonlyContext);
    });
  }

  async close(): Promise<void> {
    // No explicit resources to close for Bigtable client wrappers.
  }
}
