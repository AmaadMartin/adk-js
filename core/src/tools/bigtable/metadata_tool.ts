/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {getBigtableClient} from './client.js';
import {getLogger} from '../../utils/logger.js';
import {z} from 'zod';
import {BigtableCredentialsConfig} from './bigtable_credentials.js';

const logger = getLogger();

export const ListInstancesArgsSchema = z.object({
  projectId: z.string().describe('The Google Cloud project id.'),
});

export async function listInstances(
  projectId: string,
  config?: BigtableCredentialsConfig
): Promise<Record<string, any>> {
  try {
    const client = getBigtableClient(projectId, config);
    const [instances] = await client.getInstances();
    
    const results = instances.map((instance) => ({
      project_id: projectId,
      instance_id: instance.id,
      display_name: instance.metadata?.displayName,
      state: instance.metadata?.state,
      type: instance.metadata?.type,
      labels: instance.metadata?.labels || {},
    }));

    return {status: 'SUCCESS', results};
  } catch (ex: any) {
    logger.error(`Bigtable metadata tool failed: ${ex}`);
    return {
      status: 'ERROR',
      error_details: String(ex),
    };
  }
}

export const GetInstanceInfoArgsSchema = z.object({
  projectId: z.string().describe('The Google Cloud project id containing the instance.'),
  instanceId: z.string().describe('The Bigtable instance id.'),
});

export async function getInstanceInfo(
  projectId: string,
  instanceId: string,
  config?: BigtableCredentialsConfig
): Promise<Record<string, any>> {
  try {
    const client = getBigtableClient(projectId, config);
    const instance = client.instance(instanceId);
    const [metadata] = await instance.getMetadata();

    return {
      status: 'SUCCESS',
      results: {
        project_id: projectId,
        instance_id: instance.id,
        display_name: metadata.displayName,
        state: metadata.state,
        type: metadata.type,
        labels: metadata.labels || {},
      },
    };
  } catch (ex: any) {
    logger.error(`Bigtable metadata tool failed: ${ex}`);
    return {
      status: 'ERROR',
      error_details: String(ex),
    };
  }
}

export const ListTablesArgsSchema = z.object({
  projectId: z.string().describe('The Google Cloud project id containing the instance.'),
  instanceId: z.string().describe('The Bigtable instance id.'),
});

export async function listTables(
  projectId: string,
  instanceId: string,
  config?: BigtableCredentialsConfig
): Promise<Record<string, any>> {
  try {
    const client = getBigtableClient(projectId, config);
    const instance = client.instance(instanceId);
    const [tables] = await instance.getTables();

    const results = tables.map((table) => ({
      project_id: projectId,
      instance_id: instanceId,
      table_id: table.id,
      table_name: table.name,
    }));

    return {status: 'SUCCESS', results};
  } catch (ex: any) {
    logger.error(`Bigtable metadata tool failed: ${ex}`);
    return {
      status: 'ERROR',
      error_details: String(ex),
    };
  }
}

export const GetTableInfoArgsSchema = z.object({
  projectId: z.string().describe('The Google Cloud project id containing the instance.'),
  instanceId: z.string().describe('The Bigtable instance id containing the table.'),
  tableId: z.string().describe('The Bigtable table id.'),
});

export async function getTableInfo(
  projectId: string,
  instanceId: string,
  tableId: string,
  config?: BigtableCredentialsConfig
): Promise<Record<string, any>> {
  try {
    const client = getBigtableClient(projectId, config);
    const instance = client.instance(instanceId);
    const table = instance.table(tableId);
    const [metadata] = await table.getMetadata();

    const columnFamilies = metadata.columnFamilies
      ? Object.keys(metadata.columnFamilies)
      : [];

    return {
      status: 'SUCCESS',
      results: {
        project_id: projectId,
        instance_id: instanceId,
        table_id: table.id,
        column_families: columnFamilies,
      },
    };
  } catch (ex: any) {
    logger.error(`Bigtable metadata tool failed: ${ex}`);
    return {
      status: 'ERROR',
      error_details: String(ex),
    };
  }
}

export const ListClustersArgsSchema = z.object({
  projectId: z.string().describe('The Google Cloud project id containing the instance.'),
  instanceId: z.string().describe('The Bigtable instance id.'),
});

export async function listClusters(
  projectId: string,
  instanceId: string,
  config?: BigtableCredentialsConfig
): Promise<Record<string, any>> {
  try {
    const client = getBigtableClient(projectId, config);
    const instance = client.instance(instanceId);
    const [clusters] = await instance.getClusters();

    const results = clusters.map((cluster) => ({
      project_id: projectId,
      instance_id: instanceId,
      cluster_id: cluster.id,
      cluster_name: cluster.name,
      state: cluster.metadata?.state,
      serve_nodes: cluster.metadata?.serveNodes,
      default_storage_type: cluster.metadata?.defaultStorageType,
      location_id: cluster.metadata?.location,
    }));

    return {status: 'SUCCESS', results};
  } catch (ex: any) {
    logger.error(`Bigtable metadata tool failed: ${ex}`);
    return {
      status: 'ERROR',
      error_details: String(ex),
    };
  }
}

export const GetClusterInfoArgsSchema = z.object({
  projectId: z.string().describe('The Google Cloud project id containing the instance.'),
  instanceId: z.string().describe('The Bigtable instance id containing the cluster.'),
  clusterId: z.string().describe('The Bigtable cluster id.'),
});

export async function getClusterInfo(
  projectId: string,
  instanceId: string,
  clusterId: string,
  config?: BigtableCredentialsConfig
): Promise<Record<string, any>> {
  try {
    const client = getBigtableClient(projectId, config);
    const instance = client.instance(instanceId);
    const cluster = instance.cluster(clusterId);
    const [metadata] = await cluster.getMetadata();

    return {
      status: 'SUCCESS',
      results: {
        project_id: projectId,
        instance_id: instanceId,
        cluster_id: cluster.id,
        state: metadata.state,
        serve_nodes: metadata.serveNodes,
        default_storage_type: metadata.defaultStorageType,
        location_id: metadata.location,
        min_serve_nodes: metadata.clusterConfig?.clusterAutoscalingConfig?.autoscalingLimits?.minServeNodes,
        max_serve_nodes: metadata.clusterConfig?.clusterAutoscalingConfig?.autoscalingLimits?.maxServeNodes,
        cpu_utilization_percent: metadata.clusterConfig?.clusterAutoscalingConfig?.autoscalingTargets?.cpuUtilizationPercent,
      },
    };
  } catch (ex: any) {
    logger.error(`Bigtable metadata tool failed: ${ex}`);
    return {
      status: 'ERROR',
      error_details: String(ex),
    };
  }
}
