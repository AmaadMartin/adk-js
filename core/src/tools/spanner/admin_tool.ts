/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos} from '@google-cloud/spanner';
import {z} from 'zod';
import {FunctionTool, ToolExecuteArgument} from '../function_tool.js';
import {
  SpannerDatabaseAdminClient,
  SpannerInstanceAdminClient,
  waitForOperation,
  withDatabaseAdminClient,
  withInstanceAdminClient,
} from './client.js';
import {SpannerCredentialsManager} from './spanner_credentials.js';
import {runSpannerTool, SpannerToolResult} from './tool_result.js';

/** Prefix prepended to every tool name in the Spanner toolsets. */
export const SPANNER_TOOL_NAME_PREFIX = 'spanner';

/** How long a Spanner database id may be. */
const DATABASE_ID_MAX_LENGTH = 30;

/**
 * The database ids Spanner accepts.
 *
 * `CreateDatabaseRequest.create_statement` documents the grammar as
 * `[a-z][a-z0-9_\-]*[a-z0-9]`, between 2 and 30 characters.
 */
const SPANNER_DATABASE_ID_RE = /^[a-z][a-z0-9_-]*[a-z0-9]$/;

/**
 * Rejects a database id Spanner would not accept.
 *
 * The id is quoted into a `CREATE DATABASE` statement, so refusing anything
 * outside the grammar also keeps a backtick out of that statement.
 *
 * @param value The database id.
 * @param paramName The parameter the value came from, named in the error.
 * @throws Error if the id is outside Spanner's database id grammar.
 */
function validateDatabaseId(value: string, paramName: string): void {
  if (
    value.length > DATABASE_ID_MAX_LENGTH ||
    !SPANNER_DATABASE_ID_RE.test(value)
  ) {
    throw new Error(
      `Invalid Spanner database id for ${paramName}: ${JSON.stringify(value)}.` +
        ' A database id must match [a-z][a-z0-9_-]*[a-z0-9] and be between 2' +
        ` and ${DATABASE_ID_MAX_LENGTH} characters long.`,
    );
  }
}

/**
 * The schema of any admin tool: every one names the project whose
 * administration endpoint it calls.
 */
type AdminParams = z.ZodObject<{project_id: z.ZodString}>;

/** What every Spanner admin tool declares, whichever endpoint it calls. */
interface SpannerAdminToolBase<TParams extends AdminParams> {
  /** Tool name without the `spanner_` prefix. */
  name: string;
  description: string;
  parameters: TParams;
  /** Set on the tools that create billable resources. */
  requireConfirmation?: boolean;
  /** Rejects an argument before any client is built. */
  validate?(args: ToolExecuteArgument<TParams>): void;
}

/**
 * One Spanner admin tool. `admin` picks the endpoint, so `run` receives the
 * client it actually calls rather than one it has to narrow.
 */
export type SpannerAdminToolDefinition<TParams extends AdminParams> =
  | (SpannerAdminToolBase<TParams> & {
      admin: 'instance';
      run(
        client: SpannerInstanceAdminClient,
        args: ToolExecuteArgument<TParams>,
      ): Promise<object>;
    })
  | (SpannerAdminToolBase<TParams> & {
      admin: 'database';
      run(
        client: SpannerDatabaseAdminClient,
        args: ToolExecuteArgument<TParams>,
      ): Promise<object>;
    });

/**
 * Wraps one Spanner administration call as a prefixed tool that never throws.
 *
 * Validating the arguments, resolving the credentials, loading the optional
 * peer dependency and the call itself are all inside the same guard, so every
 * failure reaches the model as an `ERROR` result.
 *
 * @param credentials Resolves the calling end user's Spanner credentials.
 * @param definition What the tool declares and which endpoint it calls.
 * @return The tool, named `spanner_<definition.name>`.
 */
export function createSpannerAdminTool<TParams extends AdminParams>(
  credentials: SpannerCredentialsManager,
  definition: SpannerAdminToolDefinition<TParams>,
): FunctionTool<TParams> {
  const name = `${SPANNER_TOOL_NAME_PREFIX}_${definition.name}`;
  return new FunctionTool({
    name,
    description: definition.description,
    parameters: definition.parameters,
    requireConfirmation: definition.requireConfirmation ?? false,
    execute(args, toolContext): Promise<SpannerToolResult> {
      return runSpannerTool(name, async () => {
        definition.validate?.(args);
        const authClient = await credentials.getAuthClient(toolContext);
        if (!authClient) {
          throw new Error(
            'User authorization is required to access Google services for' +
              ` ${name}. Please complete the authorization flow.`,
          );
        }
        const target = {projectId: args.project_id, authClient};
        return definition.admin === 'instance'
          ? withInstanceAdminClient(target, (client) =>
              definition.run(client, args),
            )
          : withDatabaseAdminClient(target, (client) =>
              definition.run(client, args),
            );
      });
    },
  });
}

/** A replica type as the wire carries it: its number, or its name. */
type ReplicaTypeField =
  protos.google.spanner.admin.instance.v1.IReplicaInfo['type'];

/**
 * The name of every replica type, by number.
 *
 * `Record` over the enum makes this total, so a replica type added to
 * `@google-cloud/spanner` fails the build here rather than reporting nothing.
 */
const REPLICA_TYPE_NAMES: Record<
  protos.google.spanner.admin.instance.v1.ReplicaInfo.ReplicaType,
  keyof typeof protos.google.spanner.admin.instance.v1.ReplicaInfo.ReplicaType
> = {
  0: 'TYPE_UNSPECIFIED',
  1: 'READ_WRITE',
  2: 'READ_ONLY',
  3: 'WITNESS',
};

/** One replica of an instance config, as the model reads it. */
interface ReplicaSummary {
  location: string | null | undefined;
  type: string;
  default_leader_location: boolean | null | undefined;
}

const projectIdField = z
  .string()
  .describe('The Google Cloud project id that owns the Spanner resources.');
const instanceIdField = z.string().describe('The Spanner instance id.');

const projectParams = z.object({project_id: projectIdField});

const instanceParams = projectParams.extend({instance_id: instanceIdField});

const configParams = projectParams.extend({
  config_id: z
    .string()
    .describe('The Spanner instance config id, e.g. regional-us-central1.'),
});

const createInstanceParams = instanceParams.extend({
  config_id: z
    .string()
    .describe('The Spanner instance config id, e.g. regional-us-central1.'),
  display_name: z.string().describe('The display name for the instance.'),
  nodes: z
    .int()
    .positive()
    .default(1)
    .describe('The number of nodes for the instance. Defaults to 1.'),
});

const createDatabaseParams = instanceParams.extend({
  database_id: z.string().describe('The Spanner database id to create.'),
});

/**
 * The resource id of every resource a listing call pages through: the last
 * path segment of each resource name.
 */
async function collectResourceIds(
  resources: AsyncIterable<{name?: string | null}>,
): Promise<string[]> {
  const ids: string[] = [];
  for await (const resource of resources) {
    const path = resource.name ?? '';
    ids.push(path.slice(path.lastIndexOf('/') + 1));
  }
  return ids;
}

/**
 * The name of a replica type, which is what adk-python reports.
 *
 * The generated interfaces carry an enum field as either its number or its
 * name, so both are accepted. A replica with no type reads as unspecified.
 */
function replicaTypeName(type: ReplicaTypeField): string {
  return typeof type === 'number'
    ? REPLICA_TYPE_NAMES[type]
    : (type ?? 'TYPE_UNSPECIFIED');
}

export const listInstancesTool: SpannerAdminToolDefinition<
  typeof projectParams
> = {
  name: 'list_instances',
  description: 'List the Spanner instances within a Google Cloud project.',
  parameters: projectParams,
  admin: 'instance',
  async run(client, args) {
    const results = await collectResourceIds(
      client.listInstancesAsync({parent: client.projectPath(args.project_id)}),
    );
    return {results};
  },
};

export const getInstanceTool: SpannerAdminToolDefinition<
  typeof instanceParams
> = {
  name: 'get_instance',
  description: 'Get the details of one Spanner instance.',
  parameters: instanceParams,
  admin: 'instance',
  async run(client, args) {
    const [instance] = await client.getInstance({
      name: client.instancePath(args.project_id, args.instance_id),
    });
    return {
      results: {
        instance_id: args.instance_id,
        display_name: instance.displayName,
        config: instance.config,
        node_count: instance.nodeCount,
        processing_units: instance.processingUnits,
        labels: instance.labels ?? {},
      },
    };
  },
};

export const listInstanceConfigsTool: SpannerAdminToolDefinition<
  typeof projectParams
> = {
  name: 'list_instance_configs',
  description:
    'List the Spanner instance configs available to a Google Cloud project.' +
    ' An instance config decides where an instance stores its data.',
  parameters: projectParams,
  admin: 'instance',
  async run(client, args) {
    const results = await collectResourceIds(
      client.listInstanceConfigsAsync({
        parent: client.projectPath(args.project_id),
      }),
    );
    return {results};
  },
};

export const getInstanceConfigTool: SpannerAdminToolDefinition<
  typeof configParams
> = {
  name: 'get_instance_config',
  description:
    'Get the details of one Spanner instance config, including where its' +
    ' replicas are located.',
  parameters: configParams,
  admin: 'instance',
  async run(client, args) {
    const [config] = await client.getInstanceConfig({
      name: client.instanceConfigPath(args.project_id, args.config_id),
    });
    const replicas: ReplicaSummary[] = (config.replicas ?? []).map(
      (replica) => ({
        location: replica.location,
        type: replicaTypeName(replica.type),
        default_leader_location: replica.defaultLeaderLocation,
      }),
    );
    return {
      results: {
        name: config.name,
        display_name: config.displayName,
        replicas,
        labels: config.labels ?? {},
      },
    };
  },
};

export const createInstanceTool: SpannerAdminToolDefinition<
  typeof createInstanceParams
> = {
  name: 'create_instance',
  description:
    'Create a Spanner instance. This provisions billable Cloud Spanner' +
    ' compute capacity that is charged until the instance is deleted.',
  parameters: createInstanceParams,
  admin: 'instance',
  requireConfirmation: true,
  async run(client, args) {
    const [operation] = await client.createInstance({
      parent: client.projectPath(args.project_id),
      instanceId: args.instance_id,
      instance: {
        displayName: args.display_name,
        config: client.instanceConfigPath(args.project_id, args.config_id),
        nodeCount: args.nodes,
      },
    });
    await waitForOperation(operation);
    return {results: `Instance ${args.instance_id} created successfully.`};
  },
};

export const listDatabasesTool: SpannerAdminToolDefinition<
  typeof instanceParams
> = {
  name: 'list_databases',
  description: 'List the Spanner databases within an instance.',
  parameters: instanceParams,
  admin: 'database',
  async run(client, args) {
    const results = await collectResourceIds(
      client.listDatabasesAsync({
        parent: client.instancePath(args.project_id, args.instance_id),
      }),
    );
    return {results};
  },
};

export const createDatabaseTool: SpannerAdminToolDefinition<
  typeof createDatabaseParams
> = {
  name: 'create_database',
  description:
    'Create an empty Spanner database on an existing instance. The database' +
    ' is billed for the storage it uses until it is dropped.',
  parameters: createDatabaseParams,
  admin: 'database',
  requireConfirmation: true,
  // `database_id` is quoted into the CREATE DATABASE statement below, so a
  // backtick in it would escape the quoting. adk-python does not check this.
  validate(args) {
    validateDatabaseId(args.database_id, 'database_id');
  },
  async run(client, args) {
    const [operation] = await client.createDatabase({
      parent: client.instancePath(args.project_id, args.instance_id),
      createStatement: `CREATE DATABASE \`${args.database_id}\``,
    });
    await waitForOperation(operation);
    // adk-python reports no `results` for this tool, unlike `create_instance`.
    return {};
  },
};
