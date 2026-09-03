/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bigtable, ICluster, IInstance} from '@google-cloud/bigtable';

import {logger} from '../../utils/logger.js';
import {GoogleToolStatus} from '../google_tool.js';

/** Instance lifecycle states, keyed by the value the API returns. */
const INSTANCE_STATE_NAMES: Readonly<Record<number, string>> = {
  0: 'STATE_NOT_KNOWN',
  1: 'READY',
  2: 'CREATING',
};

/** Instance types, keyed by the value the API returns. */
const INSTANCE_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: 'TYPE_UNSPECIFIED',
  1: 'PRODUCTION',
  2: 'DEVELOPMENT',
};

/** Cluster lifecycle states, keyed by the value the API returns. */
const CLUSTER_STATE_NAMES: Readonly<Record<number, string>> = {
  0: 'STATE_NOT_KNOWN',
  1: 'READY',
  2: 'CREATING',
  3: 'RESIZING',
  4: 'DISABLED',
};

/** Cluster storage types, keyed by the value the API returns. */
const STORAGE_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: 'STORAGE_TYPE_UNSPECIFIED',
  1: 'SSD',
  2: 'HDD',
};

const UNKNOWN_STATE = 'UNKNOWN_STATE';
const UNKNOWN_TYPE = 'UNKNOWN_TYPE';
const UNKNOWN_STORAGE_TYPE = 'UNKNOWN_STORAGE_TYPE';

/** What every metadata tool returns when it succeeds. */
export interface BigtableMetadataResult<T> {
  status: GoogleToolStatus.SUCCESS;
  results: T;
}

/** The properties of one Bigtable instance. */
export interface BigtableInstanceInfo {
  projectId: string;
  instanceId: string;
  displayName?: string;
  state: string;
  type: string;
  labels?: Record<string, string>;
}

/** The properties of one Bigtable table. */
export interface BigtableTableInfo {
  projectId: string;
  instanceId: string;
  tableId: string;
  tableName: string;
}

/** The column families of one Bigtable table. */
export interface BigtableTableDetails {
  projectId: string;
  instanceId: string;
  tableId: string;
  columnFamilies: string[];
}

/** The properties of one Bigtable cluster. */
export interface BigtableClusterInfo {
  projectId: string;
  instanceId: string;
  clusterId: string;
  clusterName: string;
  state: string;
  serveNodes?: number;
  defaultStorageType: string;
  locationId: string;
}

/** A cluster's properties plus its autoscaling limits. */
export interface BigtableClusterDetails extends BigtableClusterInfo {
  minServeNodes?: number;
  maxServeNodes?: number;
  cpuUtilizationPercent?: number;
}

/**
 * The name of a protobuf enum value.
 *
 * The Bigtable SDK surfaces an enum either as its name or as its number,
 * depending on how the response was decoded, so both are accepted.
 */
function enumName(
  value: number | string | null | undefined,
  names: Readonly<Record<number, string>>,
  unknown: string,
): string {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number') {
    return names[value] ?? `${unknown}_${value}`;
  }
  return unknown;
}

/** The last segment of a resource name, which is the resource's own id. */
function resourceId(name: string | null | undefined): string {
  return name?.split('/').pop() ?? '';
}

/**
 * The locations the API could not reach, if the response reports any.
 *
 * `getClusters` declares its second value as an operation, but the SDK passes
 * the list response through, so the field is read defensively.
 */
function failedLocations(response: unknown): string[] {
  if (response === null || typeof response !== 'object') {
    return [];
  }
  const value = (response as Record<string, unknown>)['failedLocations'];
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/** Logs the locations a list call could not reach, and carries on. */
function warnFailedLocations(resource: string, locations: string[]): void {
  if (locations.length > 0) {
    logger.warn(
      `Failed to list ${resource} from the following locations: ` +
        locations.join(', '),
    );
  }
}

/** Maps an instance's metadata onto the shape the model reads. */
function toInstanceInfo(
  projectId: string,
  instanceId: string,
  metadata: IInstance | undefined,
): BigtableInstanceInfo {
  return {
    projectId,
    instanceId,
    displayName: metadata?.displayName ?? undefined,
    state: enumName(metadata?.state, INSTANCE_STATE_NAMES, UNKNOWN_STATE),
    type: enumName(metadata?.type, INSTANCE_TYPE_NAMES, UNKNOWN_TYPE),
    labels: metadata?.labels ?? undefined,
  };
}

/** Maps a cluster's metadata onto the shape the model reads. */
function toClusterInfo(
  projectId: string,
  instanceId: string,
  clusterId: string,
  metadata: ICluster | undefined,
): BigtableClusterInfo {
  return {
    projectId,
    instanceId,
    clusterId,
    clusterName: metadata?.name ?? '',
    state: enumName(metadata?.state, CLUSTER_STATE_NAMES, UNKNOWN_STATE),
    serveNodes: metadata?.serveNodes ?? undefined,
    defaultStorageType: enumName(
      metadata?.defaultStorageType,
      STORAGE_TYPE_NAMES,
      UNKNOWN_STORAGE_TYPE,
    ),
    locationId: resourceId(metadata?.location),
  };
}

/** Lists the Bigtable instance ids in a Google Cloud project. */
export async function listInstances(
  client: Bigtable,
  projectId: string,
): Promise<BigtableMetadataResult<BigtableInstanceInfo[]>> {
  const [instances, unreachable] = await client.getInstances();
  warnFailedLocations('instances', unreachable ?? []);
  return {
    status: GoogleToolStatus.SUCCESS,
    results: instances.map((instance) =>
      toInstanceInfo(projectId, instance.id, instance.metadata),
    ),
  };
}

/** Reads the metadata of one Bigtable instance. */
export async function getInstanceInfo(
  client: Bigtable,
  projectId: string,
  instanceId: string,
): Promise<BigtableMetadataResult<BigtableInstanceInfo>> {
  const instance = client.instance(instanceId);
  const [metadata] = await instance.getMetadata();
  return {
    status: GoogleToolStatus.SUCCESS,
    results: toInstanceInfo(projectId, instanceId, metadata),
  };
}

/** Lists the tables of a Bigtable instance. */
export async function listTables(
  client: Bigtable,
  projectId: string,
  instanceId: string,
): Promise<BigtableMetadataResult<BigtableTableInfo[]>> {
  const [tables] = await client.instance(instanceId).getTables();
  return {
    status: GoogleToolStatus.SUCCESS,
    results: tables.map((table) => ({
      projectId,
      instanceId,
      tableId: table.id,
      tableName: table.name,
    })),
  };
}

/** Reads the column families of one Bigtable table. */
export async function getTableInfo(
  client: Bigtable,
  projectId: string,
  instanceId: string,
  tableId: string,
): Promise<BigtableMetadataResult<BigtableTableDetails>> {
  const [families] = await client
    .instance(instanceId)
    .table(tableId)
    .getFamilies();
  return {
    status: GoogleToolStatus.SUCCESS,
    results: {
      projectId,
      instanceId,
      tableId,
      columnFamilies: families.map((family) => family.id),
    },
  };
}

/** Lists the clusters of a Bigtable instance. */
export async function listClusters(
  client: Bigtable,
  projectId: string,
  instanceId: string,
): Promise<BigtableMetadataResult<BigtableClusterInfo[]>> {
  const [clusters, response] = await client.instance(instanceId).getClusters();
  warnFailedLocations('clusters', failedLocations(response));
  return {
    status: GoogleToolStatus.SUCCESS,
    results: clusters.map((cluster) =>
      toClusterInfo(projectId, instanceId, cluster.id, cluster.metadata),
    ),
  };
}

/** Reads the metadata and autoscaling limits of one Bigtable cluster. */
export async function getClusterInfo(
  client: Bigtable,
  projectId: string,
  instanceId: string,
  clusterId: string,
): Promise<BigtableMetadataResult<BigtableClusterDetails>> {
  const cluster = client.instance(instanceId).cluster(clusterId);
  const [metadata] = await cluster.getMetadata();
  const autoscaling = metadata?.clusterConfig?.clusterAutoscalingConfig;
  return {
    status: GoogleToolStatus.SUCCESS,
    results: {
      ...toClusterInfo(projectId, instanceId, clusterId, metadata),
      minServeNodes: autoscaling?.autoscalingLimits?.minServeNodes ?? undefined,
      maxServeNodes: autoscaling?.autoscalingLimits?.maxServeNodes ?? undefined,
      cpuUtilizationPercent:
        autoscaling?.autoscalingTargets?.cpuUtilizationPercent ?? undefined,
    },
  };
}
