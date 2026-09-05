/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos} from '@google-cloud/spanner';
import {z} from 'zod';
import {waitForOperation} from './client.js';
import {SpannerAdminToolDefinition} from './spanner_tool.js';
import {validateIdentifier} from './sql_validation.js';

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

/** Reads the project a call names. */
function projectOf(args: z.infer<typeof projectParams>): string {
  return args.project_id;
}

/** The resource id of a Spanner resource name, its last path segment. */
function resourceId(name: string | null | undefined): string {
  return (name ?? '').split('/').pop() ?? '';
}

/** Collects the resource ids of every resource a listing call pages through. */
async function collectResourceIds(
  resources: AsyncIterable<{name?: string | null}>,
): Promise<string[]> {
  const ids: string[] = [];
  for await (const resource of resources) {
    ids.push(resourceId(resource.name));
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
  projectId: projectOf,
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
  projectId: projectOf,
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
  projectId: projectOf,
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
  projectId: projectOf,
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
  projectId: projectOf,
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
  projectId: projectOf,
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
  projectId: projectOf,
  // `database_id` is quoted into the CREATE DATABASE statement below, so a
  // backtick in it would escape the quoting. adk-python does not check this.
  validate(args) {
    validateIdentifier(args.database_id, 'database_id');
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
