/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {BaseToolset, ToolPredicate} from '../base_toolset.js';
import {FunctionTool} from '../function_tool.js';

import {BigtableCredentialsConfig} from './bigtable_credentials.js';
import {BigtableClientPool} from './client.js';
import * as metadataTool from './metadata_tool.js';
import * as queryTool from './query_tool.js';
import {BigtableToolSettings} from './settings.js';

export const DEFAULT_BIGTABLE_TOOL_NAME_PREFIX = 'bigtable';

/**
 * View parameters the invocation itself answers, keyed by both the snake_case
 * spelling adk-python uses and the camelCase spelling of the property. A name
 * listed here is read from the context and never from session state, so an
 * agent cannot widen its own access by writing `user_id` into state.
 */
const CONTEXT_VIEW_PARAMETERS = new Map<
  string,
  (context: ReadonlyContext) => string
>([
  ['user_id', (context) => context.userId],
  ['userId', (context) => context.userId],
  ['session_id', (context) => context.sessionId],
  ['sessionId', (context) => context.sessionId],
  ['invocation_id', (context) => context.invocationId],
  ['invocationId', (context) => context.invocationId],
  ['agent_name', (context) => context.agentName],
  ['agentName', (context) => context.agentName],
]);

/** Options accepted by {@link BigtableToolset}. */
export interface BigtableToolsetOptions {
  /**
   * Restricts which tools the toolset exposes. Names are matched against the
   * final, prefixed tool name (`bigtable_execute_sql`, not `execute_sql`).
   * A {@link ToolPredicate} is only applied when `getTools` receives a
   * {@link ReadonlyContext}.
   */
  toolFilter?: ToolPredicate | string[];
  credentialsConfig?: BigtableCredentialsConfig;
  bigtableToolSettings?: BigtableToolSettings;
  /**
   * Parameter names whose values are resolved from the invocation, and
   * injected into every query as trusted parameters. Supplying at least one
   * adds the `execute_sql_parameterized` tool.
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
@experimental
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
          metadataTool.listInstances(
            await this.clients.forProject(args.projectId),
          ),
      }),
      new FunctionTool({
        name: this.toolName('get_instance_info'),
        description: 'Get metadata information about a Bigtable instance.',
        parameters: metadataTool.GetInstanceInfoArgsSchema,
        execute: async (args) =>
          metadataTool.getInstanceInfo(
            await this.clients.forProject(args.projectId),
            args.instanceId,
          ),
      }),
      new FunctionTool({
        name: this.toolName('list_tables'),
        description: 'List tables and their metadata in a Bigtable instance.',
        parameters: metadataTool.ListTablesArgsSchema,
        execute: async (args) =>
          metadataTool.listTables(
            await this.clients.forProject(args.projectId),
            args.instanceId,
          ),
      }),
      new FunctionTool({
        name: this.toolName('get_table_info'),
        description: 'Get metadata information about a Bigtable table.',
        parameters: metadataTool.GetTableInfoArgsSchema,
        execute: async (args) =>
          metadataTool.getTableInfo(
            await this.clients.forProject(args.projectId),
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
            await this.clients.forProject(args.projectId),
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
            await this.clients.forProject(args.projectId),
            args.instanceId,
            args.clusterId,
          ),
      }),
      new FunctionTool({
        name: this.toolName('execute_sql'),
        description: 'Execute a GoogleSQL query from a Bigtable table.',
        parameters: queryTool.ExecuteSqlArgsSchema,
        execute: async (args) =>
          queryTool.executeSql(await this.clients.forProject(args.projectId), {
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
            queryTool.executeSql(
              await this.clients.forProject(args.projectId),
              {
                instanceId: args.instanceId,
                query: args.query,
                parameters: args.parameters,
                parameterTypes: args.parameterTypes,
                viewParameters: this.resolveViewParameters(toolContext),
                settings: this.toolSettings,
              },
            ),
        }),
      );
    }

    // An empty array (the default) means no filter: every tool is returned.
    const filter = this.toolFilter;
    if (!filter || (Array.isArray(filter) && filter.length === 0)) {
      return allTools;
    }

    if (readonlyContext) {
      return allTools.filter((tool) =>
        this.isToolSelected(tool, readonlyContext),
      );
    }

    if (Array.isArray(filter)) {
      // A name list needs no context, so it still applies.
      return allTools.filter((tool) => filter.includes(tool.name));
    }

    logger.warn(
      'BigtableToolset: a ToolPredicate toolFilter was provided but ' +
        'getTools() was called without a ReadonlyContext. The filter will ' +
        'not be applied.',
    );
    return allTools;
  }

  override async close(): Promise<void> {
    await this.clients.close();
  }

  private toolName(name: string): string {
    return this.prefix ? `${this.prefix}_${name}` : name;
  }

  /**
   * Reads the configured view parameters out of the invocation, which the
   * model cannot write to as part of a tool call. A name the invocation itself
   * answers (`user_id` and friends) wins over session state; anything else
   * falls back to state, and a name that resolves nowhere is skipped.
   */
  private resolveViewParameters(
    context?: ReadonlyContext,
  ): queryTool.BigtableQueryParameters {
    const viewParameters: queryTool.BigtableQueryParameters = {};
    if (!context) {
      return viewParameters;
    }

    for (const name of this.viewParameterNames) {
      const fromContext = CONTEXT_VIEW_PARAMETERS.get(name)?.(context);
      if (fromContext !== undefined) {
        viewParameters[name] = fromContext;
        continue;
      }

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
