/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos} from '@google-cloud/spanner-api';
import {z} from 'zod';
import {formatError} from '../../utils/error_utils.js';
import {BaseTool} from '../base_tool.js';
import {FunctionTool, ToolExecuteArgument} from '../function_tool.js';
import type {
  SpannerAdminClientProvider,
  SpannerAdminClients,
} from './client.js';

/** Prefix prepended to every tool name in the Spanner admin toolset. */
export const SPANNER_TOOL_NAME_PREFIX = 'spanner';

/**
 * How long a create operation may run before it is reported as an error,
 * matching adk-python's `operation.result(timeout=300)`.
 */
export const CREATE_OPERATION_TIMEOUT_MS = 300_000;

/**
 * Polling settings for a create operation. google-gax replaces its default
 * backoff outright when `longrunning` is supplied rather than merging into it,
 * so the delays below repeat `createDefaultBackoffSettings()`; only the total
 * bound is ours. Without it gax polls with a deadline of `Infinity`, so a
 * create that never completes would hang the tool call forever.
 */
const CREATE_OPERATION_CALL_OPTIONS = {
  longrunning: {
    initialRetryDelayMillis: 100,
    retryDelayMultiplier: 1.3,
    maxRetryDelayMillis: 60_000,
    totalTimeoutMillis: CREATE_OPERATION_TIMEOUT_MS,
  },
};

/**
 * What a Spanner admin tool returns to the model. A tool never throws: a
 * rejected Admin API call, a create operation that fails or exceeds its
 * 300-second bound, missing credentials and a missing
 * `@google-cloud/spanner-api` package all arrive as `ERROR`.
 *
 * The keys are `snake_case` because they cross the model boundary and must
 * match what adk-python emits.
 */
export type SpannerToolResult =
  | {status: 'SUCCESS'; results?: unknown}
  | {status: 'ERROR'; error_details: string};

type ReplicaType =
  protos.google.spanner.admin.instance.v1.ReplicaInfo.ReplicaType;
type ReplicaTypeName =
  keyof typeof protos.google.spanner.admin.instance.v1.ReplicaInfo.ReplicaType;

/**
 * Names of the `ReplicaInfo.ReplicaType` enum values. The client returns
 * either the number or the name, and adk-python always reports the name.
 * Typing the map as `Record<ReplicaType, ...>` makes the compiler reject it if
 * the proto gains a value, and keeps the enum out of the runtime import.
 */
const REPLICA_TYPE_NAMES: Record<ReplicaType, ReplicaTypeName> = {
  0: 'TYPE_UNSPECIFIED',
  1: 'READ_WRITE',
  2: 'READ_ONLY',
  3: 'WITNESS',
};

const projectIdField = z.string().describe('The Google Cloud project id.');
const instanceIdField = z.string().describe('The Spanner instance id.');

/** What a tool scoped to a project takes. */
const projectParams = z.object({project_id: projectIdField});

/** What a tool scoped to one instance takes. */
const instanceParams = z.object({
  project_id: projectIdField,
  instance_id: instanceIdField,
});

const getInstanceConfigParams = z.object({
  project_id: projectIdField,
  config_id: z.string().describe('The Spanner instance config id.'),
});

const createInstanceParams = z.object({
  project_id: projectIdField,
  instance_id: z.string().describe('The Spanner instance id to create.'),
  config_id: z
    .string()
    .describe('The instance config id, e.g. regional-us-central1.'),
  display_name: z.string().describe('The display name for the instance.'),
  nodes: z
    .number()
    .default(1)
    .describe('Number of nodes for the instance. Defaults to 1.'),
});

const createDatabaseParams = z.object({
  project_id: projectIdField,
  instance_id: instanceIdField,
  database_id: z
    .string()
    .describe('The Spanner database id. It cannot contain a backtick.'),
});

/**
 * Reduces a resource to the last segment of its name, so
 * `projects/p/instances/i` reads as `i`. The generated protos type every field
 * as optional, so a nameless resource yields the empty string.
 */
function resourceId({name}: {name?: string | null}): string {
  return name ? name.slice(name.lastIndexOf('/') + 1) : '';
}

/** Reports a replica type as its enum name, whatever form the client used. */
function replicaTypeName(
  type: ReplicaType | ReplicaTypeName | null | undefined,
): ReplicaTypeName {
  if (typeof type !== 'number') {
    return type ?? 'TYPE_UNSPECIFIED';
  }
  const name = REPLICA_TYPE_NAMES[type];
  if (name === undefined) {
    // adk-python raises here too: `ReplicaInfo.ReplicaType(r.type)` rejects a
    // value the generated enum does not know.
    throw new Error(`Unknown Spanner replica type: ${type}.`);
  }
  return name;
}

/**
 * Rejects a database id that would break out of the backticks quoting it in
 * the `CREATE DATABASE` statement. The id comes from the model, so without
 * this it could append arbitrary DDL. adk-python has the same hole; this port
 * closes it.
 */
function assertQuotableDatabaseId(databaseId: string): void {
  if (databaseId.includes('`')) {
    throw new Error(
      `Invalid database id "${databaseId}": it cannot contain a backtick.`,
    );
  }
}

/** One admin tool: its model-facing schema and the Admin API call it makes. */
interface SpannerAdminToolDefinition<TParams extends z.ZodObject> {
  /** Tool name without the `spanner_` prefix. */
  name: string;
  description: string;
  parameters: TParams;
  /**
   * Set on an operation that provisions a billable resource, so the user must
   * approve the call before it runs. There is no option to turn this off: a
   * caller who does not want the tool at all can drop it with `toolFilter`.
   */
  requireConfirmation?: boolean;
  run(
    clients: SpannerAdminClients,
    args: ToolExecuteArgument<TParams>,
  ): Promise<SpannerToolResult>;
}

const listInstancesTool: SpannerAdminToolDefinition<typeof projectParams> = {
  name: 'list_instances',
  description: 'List Spanner instances within a project.',
  parameters: projectParams,
  async run({instanceAdmin}, {project_id}) {
    const [instances] = await instanceAdmin.listInstances({
      parent: instanceAdmin.projectPath(project_id),
    });
    return {
      status: 'SUCCESS',
      results: instances.map(resourceId),
    };
  },
};

const getInstanceTool: SpannerAdminToolDefinition<typeof instanceParams> = {
  name: 'get_instance',
  description: 'Get details of a Spanner instance.',
  parameters: instanceParams,
  async run({instanceAdmin}, {project_id, instance_id}) {
    const [instance] = await instanceAdmin.getInstance({
      name: instanceAdmin.instancePath(project_id, instance_id),
    });
    return {
      status: 'SUCCESS',
      results: {
        instance_id,
        display_name: instance.displayName,
        config: instance.config,
        node_count: instance.nodeCount,
        processing_units: instance.processingUnits,
        labels: {...instance.labels},
      },
    };
  },
};

const listInstanceConfigsTool: SpannerAdminToolDefinition<
  typeof projectParams
> = {
  name: 'list_instance_configs',
  description: 'List Spanner instance configs available for a project.',
  parameters: projectParams,
  async run({instanceAdmin}, {project_id}) {
    const [configs] = await instanceAdmin.listInstanceConfigs({
      parent: instanceAdmin.projectPath(project_id),
    });
    return {
      status: 'SUCCESS',
      results: configs.map(resourceId),
    };
  },
};

const getInstanceConfigTool: SpannerAdminToolDefinition<
  typeof getInstanceConfigParams
> = {
  name: 'get_instance_config',
  description: 'Get details of a Spanner instance config.',
  parameters: getInstanceConfigParams,
  async run({instanceAdmin}, {project_id, config_id}) {
    const [config] = await instanceAdmin.getInstanceConfig({
      name: instanceAdmin.instanceConfigPath(project_id, config_id),
    });
    return {
      status: 'SUCCESS',
      results: {
        name: config.name,
        display_name: config.displayName,
        replicas: (config.replicas ?? []).map((replica) => ({
          location: replica.location,
          type: replicaTypeName(replica.type),
          default_leader_location: replica.defaultLeaderLocation,
        })),
        labels: {...config.labels},
      },
    };
  },
};

const createInstanceTool: SpannerAdminToolDefinition<
  typeof createInstanceParams
> = {
  name: 'create_instance',
  description:
    'Create a Spanner instance. This creates a billable Google Cloud resource.',
  parameters: createInstanceParams,
  requireConfirmation: true,
  async run(
    {instanceAdmin},
    {project_id, instance_id, config_id, display_name, nodes},
  ) {
    const [operation] = await instanceAdmin.createInstance(
      {
        parent: instanceAdmin.projectPath(project_id),
        instanceId: instance_id,
        instance: {
          displayName: display_name,
          config: instanceAdmin.instanceConfigPath(project_id, config_id),
          nodeCount: nodes,
        },
      },
      CREATE_OPERATION_CALL_OPTIONS,
    );
    await operation.promise();
    return {
      status: 'SUCCESS',
      results: `Instance ${instance_id} created successfully.`,
    };
  },
};

const listDatabasesTool: SpannerAdminToolDefinition<typeof instanceParams> = {
  name: 'list_databases',
  description: 'List Spanner databases within an instance.',
  parameters: instanceParams,
  async run({databaseAdmin}, {project_id, instance_id}) {
    const [databases] = await databaseAdmin.listDatabases({
      parent: databaseAdmin.instancePath(project_id, instance_id),
    });
    return {
      status: 'SUCCESS',
      results: databases.map(resourceId),
    };
  },
};

const createDatabaseTool: SpannerAdminToolDefinition<
  typeof createDatabaseParams
> = {
  name: 'create_database',
  description:
    'Create a Spanner database. This creates a billable Google Cloud resource.',
  parameters: createDatabaseParams,
  requireConfirmation: true,
  async run({databaseAdmin}, {project_id, instance_id, database_id}) {
    assertQuotableDatabaseId(database_id);
    const [operation] = await databaseAdmin.createDatabase(
      {
        parent: databaseAdmin.instancePath(project_id, instance_id),
        createStatement: `CREATE DATABASE \`${database_id}\``,
      },
      CREATE_OPERATION_CALL_OPTIONS,
    );
    await operation.promise();
    return {status: 'SUCCESS'};
  },
};

/**
 * Wraps one operation as a prefixed tool. adk-python wraps every admin
 * function body in `try/except Exception`; the single `catch` here also covers
 * resolving the clients, so a missing peer dependency or missing credentials
 * reach the model as an error rather than as a thrown exception.
 */
function createSpannerTool<TParams extends z.ZodObject>(
  provider: SpannerAdminClientProvider,
  definition: SpannerAdminToolDefinition<TParams>,
): FunctionTool<TParams> {
  return new FunctionTool({
    name: `${SPANNER_TOOL_NAME_PREFIX}_${definition.name}`,
    description: definition.description,
    parameters: definition.parameters,
    requireConfirmation: definition.requireConfirmation,
    async execute(args) {
      try {
        return await definition.run(await provider.getClients(), args);
      } catch (err: unknown) {
        return {status: 'ERROR', error_details: formatError(err)};
      }
    },
  });
}

/**
 * Builds the seven Spanner admin tools, each bound to `provider` and named
 * with the `spanner_` prefix.
 */
export function createSpannerAdminTools(
  provider: SpannerAdminClientProvider,
): BaseTool[] {
  return [
    createSpannerTool(provider, listInstancesTool),
    createSpannerTool(provider, getInstanceTool),
    createSpannerTool(provider, listInstanceConfigsTool),
    createSpannerTool(provider, getInstanceConfigTool),
    createSpannerTool(provider, createInstanceTool),
    createSpannerTool(provider, listDatabasesTool),
    createSpannerTool(provider, createDatabaseTool),
  ];
}
