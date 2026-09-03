/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  Bigtable,
  Cluster,
  ICluster,
  IInstance,
  Instance,
  protos,
} from '@google-cloud/bigtable';
import {z} from 'zod';

import {logger} from '../../utils/logger.js';
import {BaseTool} from '../base_tool.js';
import {FunctionTool} from '../function_tool.js';

import {BigtableClientCache} from './client.js';
import {runBigtableTool} from './tool_result.js';

type IListClustersResponse =
  protos.google.bigtable.admin.v2.IListClustersResponse;

const projectIdField = z.string().describe('The Google Cloud project id.');
const instanceIdField = z.string().describe('The Bigtable instance id.');

const projectSchema = z.object({project_id: projectIdField});
const instanceSchema = z.object({
  project_id: projectIdField,
  instance_id: instanceIdField,
});
const tableSchema = z.object({
  project_id: projectIdField,
  instance_id: instanceIdField,
  table_id: z.string().describe('The Bigtable table id.'),
});
const clusterSchema = z.object({
  project_id: projectIdField,
  instance_id: instanceIdField,
  cluster_id: z.string().describe('The Bigtable cluster id.'),
});

/**
 * Returns the name of a protobuf enum member reported by the admin API.
 *
 * google-gax decodes enums as their names, so the value is normally already
 * the name adk-python derives from the numeric value. A numeric value is
 * rendered the way adk-python renders an unmatched one, and a missing value
 * falls back to `unknown`.
 *
 * @param value The value the admin API reported.
 * @param unknown The name to use when the value carries none.
 * @return The enum member name.
 */
function enumName(
  value: string | number | null | undefined,
  unknown: string,
): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return `${unknown}_${value}`;
  }
  return unknown;
}

/** Returns the trailing segment of a resource name, or an empty string. */
function resourceId(name: string | null | undefined): string {
  return name?.split('/').pop() ?? '';
}

/** Reports the locations the admin API could not reach, if there were any. */
function warnFailedLocations(
  resource: string,
  failedLocations: string[] | null | undefined,
): void {
  if (!failedLocations?.length) {
    return;
  }
  logger.warn(
    `Failed to list ${resource} from the following locations: ` +
      failedLocations.join(', '),
  );
}

/** The instance fields adk-python's instance tools report. */
function instanceInfo(
  projectId: string,
  instanceId: string,
  metadata: IInstance | undefined,
) {
  return {
    project_id: projectId,
    instance_id: instanceId,
    display_name: metadata?.displayName,
    state: enumName(metadata?.state, 'UNKNOWN_STATE'),
    type: enumName(metadata?.type, 'UNKNOWN_TYPE'),
    labels: metadata?.labels,
  };
}

/** The cluster fields shared by `list_clusters` and `get_cluster_info`. */
function clusterInfo(
  projectId: string,
  instanceId: string,
  clusterId: string,
  metadata: ICluster | undefined,
) {
  return {
    project_id: projectId,
    instance_id: instanceId,
    cluster_id: clusterId,
    state: enumName(metadata?.state, 'UNKNOWN_STATE'),
    serve_nodes: metadata?.serveNodes,
    default_storage_type: enumName(
      metadata?.defaultStorageType,
      'UNKNOWN_STORAGE_TYPE',
    ),
    location_id: resourceId(metadata?.location),
  };
}

/**
 * Lists an instance's clusters through the callback overload.
 *
 * The promise overload types its second element as a long-running operation,
 * which hides `failedLocations`; the callback overload types it as the list
 * response it actually is.
 *
 * @param instance The instance whose clusters to list.
 * @return The clusters and the raw list response.
 */
function getClusters(
  instance: Instance,
): Promise<[Cluster[], IListClustersResponse]> {
  return new Promise((resolve, reject) => {
    instance.getClusters((err, clusters, response) => {
      if (err) {
        reject(err);
        return;
      }
      resolve([clusters ?? [], response ?? {}]);
    });
  });
}

/**
 * Builds the six Bigtable metadata tools.
 *
 * @param clients The client cache the tools read through.
 * @return The six tools.
 */
export function createMetadataTools(clients: BigtableClientCache): BaseTool[] {
  return [
    new FunctionTool({
      name: 'list_instances',
      description: 'List Bigtable instance ids in a Google Cloud project.',
      parameters: projectSchema,
      execute: (args) =>
        runBigtableTool('list_instances', async () => {
          const client = await clients.get(args.project_id);
          const [instances, failedLocations] = await client.getInstances();
          warnFailedLocations('instances', failedLocations);
          return {
            results: instances.map((instance) =>
              instanceInfo(args.project_id, instance.id, instance.metadata),
            ),
          };
        }),
    }),

    new FunctionTool({
      name: 'get_instance_info',
      description: 'Get metadata information about a Bigtable instance.',
      parameters: instanceSchema,
      execute: (args) =>
        runBigtableTool('get_instance_info', async () => {
          const instance = await getInstance(clients, args);
          const [metadata] = await instance.getMetadata();
          return {
            results: instanceInfo(args.project_id, instance.id, metadata),
          };
        }),
    }),

    new FunctionTool({
      name: 'list_tables',
      description: 'List tables and their metadata in a Bigtable instance.',
      parameters: instanceSchema,
      execute: (args) =>
        runBigtableTool('list_tables', async () => {
          const instance = await getInstance(clients, args);
          const [tables] = await instance.getTables();
          return {
            results: tables.map((table) => ({
              project_id: args.project_id,
              instance_id: args.instance_id,
              table_id: table.id,
              table_name: table.name,
            })),
          };
        }),
    }),

    new FunctionTool({
      name: 'get_table_info',
      description: 'Get metadata information about a Bigtable table.',
      parameters: tableSchema,
      execute: (args) =>
        runBigtableTool('get_table_info', async () => {
          const instance = await getInstance(clients, args);
          const table = instance.table(args.table_id);
          const [families] = await table.getFamilies();
          return {
            results: {
              project_id: args.project_id,
              instance_id: instance.id,
              table_id: table.id,
              column_families: families.map((family) => family.id),
            },
          };
        }),
    }),

    new FunctionTool({
      name: 'list_clusters',
      description: 'List clusters and their metadata in a Bigtable instance.',
      parameters: instanceSchema,
      execute: (args) =>
        runBigtableTool('list_clusters', async () => {
          const instance = await getInstance(clients, args);
          const [clusters, response] = await getClusters(instance);
          warnFailedLocations('clusters', response.failedLocations);
          return {
            results: clusters.map((cluster) => ({
              ...clusterInfo(
                args.project_id,
                args.instance_id,
                cluster.id,
                cluster.metadata,
              ),
              cluster_name: cluster.name,
            })),
          };
        }),
    }),

    new FunctionTool({
      name: 'get_cluster_info',
      description:
        'Get detailed metadata information about a Bigtable cluster.',
      parameters: clusterSchema,
      execute: (args) =>
        runBigtableTool('get_cluster_info', async () => {
          const instance = await getInstance(clients, args);
          const cluster = instance.cluster(args.cluster_id);
          const [metadata] = await cluster.getMetadata();
          const autoscaling = metadata?.clusterConfig?.clusterAutoscalingConfig;
          return {
            results: {
              ...clusterInfo(
                args.project_id,
                args.instance_id,
                cluster.id,
                metadata,
              ),
              min_serve_nodes: autoscaling?.autoscalingLimits?.minServeNodes,
              max_serve_nodes: autoscaling?.autoscalingLimits?.maxServeNodes,
              cpu_utilization_percent:
                autoscaling?.autoscalingTargets?.cpuUtilizationPercent,
            },
          };
        }),
    }),
  ];
}

/** Resolves the instance handle a metadata tool reads through. */
async function getInstance(
  clients: BigtableClientCache,
  args: {project_id: string; instance_id: string},
): Promise<Instance> {
  const client: Bigtable = await clients.get(args.project_id);
  return client.instance(args.instance_id);
}
