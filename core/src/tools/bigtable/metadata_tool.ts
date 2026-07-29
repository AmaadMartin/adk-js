/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Bigtable} from '@google-cloud/bigtable';
import {z} from 'zod';

import {runBigtableTool} from './tool_result.js';

export const ListInstancesArgsSchema = z.object({
  projectId: z.string().describe('The Google Cloud project id.'),
});

export const GetInstanceInfoArgsSchema = z.object({
  projectId: z
    .string()
    .describe('The Google Cloud project id containing the instance.'),
  instanceId: z.string().describe('The Bigtable instance id.'),
});

export const ListTablesArgsSchema = GetInstanceInfoArgsSchema;

export const ListClustersArgsSchema = GetInstanceInfoArgsSchema;

export const GetTableInfoArgsSchema = z.object({
  projectId: z
    .string()
    .describe('The Google Cloud project id containing the instance.'),
  instanceId: z
    .string()
    .describe('The Bigtable instance id containing the table.'),
  tableId: z.string().describe('The Bigtable table id.'),
});

export const GetClusterInfoArgsSchema = z.object({
  projectId: z
    .string()
    .describe('The Google Cloud project id containing the instance.'),
  instanceId: z
    .string()
    .describe('The Bigtable instance id containing the cluster.'),
  clusterId: z.string().describe('The Bigtable cluster id.'),
});

/** Lists the Bigtable instances in the client's project. */
export function listInstances(client: Bigtable) {
  return runBigtableTool('list_instances', async () => {
    const [instances] = await client.getInstances();
    return instances.map((instance) => ({
      project_id: client.projectId,
      instance_id: instance.id,
      display_name: instance.metadata?.displayName,
      state: instance.metadata?.state,
      type: instance.metadata?.type,
      labels: instance.metadata?.labels ?? {},
    }));
  });
}

/** Reads the metadata of a single Bigtable instance. */
export function getInstanceInfo(client: Bigtable, instanceId: string) {
  return runBigtableTool('get_instance_info', async () => {
    const instance = client.instance(instanceId);
    const [metadata] = await instance.getMetadata();
    return {
      project_id: client.projectId,
      instance_id: instance.id,
      display_name: metadata.displayName,
      state: metadata.state,
      type: metadata.type,
      labels: metadata.labels ?? {},
    };
  });
}

/** Lists the tables of a Bigtable instance. */
export function listTables(client: Bigtable, instanceId: string) {
  return runBigtableTool('list_tables', async () => {
    const [tables] = await client.instance(instanceId).getTables();
    return tables.map((table) => ({
      project_id: client.projectId,
      instance_id: instanceId,
      table_id: table.id,
      table_name: table.name,
    }));
  });
}

/** Reads the metadata, including column families, of a Bigtable table. */
export function getTableInfo(
  client: Bigtable,
  instanceId: string,
  tableId: string,
) {
  return runBigtableTool('get_table_info', async () => {
    const table = client.instance(instanceId).table(tableId);
    const [metadata] = await table.getMetadata();
    return {
      project_id: client.projectId,
      instance_id: instanceId,
      table_id: table.id,
      column_families: Object.keys(metadata.columnFamilies ?? {}),
    };
  });
}

/** Lists the clusters of a Bigtable instance. */
export function listClusters(client: Bigtable, instanceId: string) {
  return runBigtableTool('list_clusters', async () => {
    const [clusters] = await client.instance(instanceId).getClusters();
    return clusters.map((cluster) => ({
      project_id: client.projectId,
      instance_id: instanceId,
      cluster_id: cluster.id,
      cluster_name: cluster.name,
      state: cluster.metadata?.state,
      serve_nodes: cluster.metadata?.serveNodes,
      default_storage_type: cluster.metadata?.defaultStorageType,
      location_id: cluster.metadata?.location,
    }));
  });
}

/** Reads the metadata, including autoscaling limits, of a Bigtable cluster. */
export function getClusterInfo(
  client: Bigtable,
  instanceId: string,
  clusterId: string,
) {
  return runBigtableTool('get_cluster_info', async () => {
    const cluster = client.instance(instanceId).cluster(clusterId);
    const [metadata] = await cluster.getMetadata();
    const autoscaling = metadata.clusterConfig?.clusterAutoscalingConfig;
    return {
      project_id: client.projectId,
      instance_id: instanceId,
      cluster_id: cluster.id,
      state: metadata.state,
      serve_nodes: metadata.serveNodes,
      default_storage_type: metadata.defaultStorageType,
      location_id: metadata.location,
      min_serve_nodes: autoscaling?.autoscalingLimits?.minServeNodes,
      max_serve_nodes: autoscaling?.autoscalingLimits?.maxServeNodes,
      cpu_utilization_percent:
        autoscaling?.autoscalingTargets?.cpuUtilizationPercent,
    };
  });
}
