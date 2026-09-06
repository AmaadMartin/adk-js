/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Bigtable} from '@google-cloud/bigtable';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {BigtableClientPool} from '../../../src/tools/bigtable/client.js';
import {
  getClusterInfo,
  getInstanceInfo,
  getTableInfo,
  listClusters,
  listInstances,
  listTables,
} from '../../../src/tools/bigtable/metadata_tool.js';
import {GoogleToolStatus} from '../../../src/tools/google_tool.js';
import {logger} from '../../../src/utils/logger.js';

import {type FakeBigtableData, resetFakeBigtable} from './bigtable_fakes.js';

vi.mock('@google-cloud/bigtable', async () => ({
  Bigtable: (await import('./bigtable_fakes.js')).FakeBigtable,
}));

const PROJECT = 'test-project';
const INSTANCE = 'test-instance';

/** A client backed by the fake SDK, loaded the way the tools load it. */
async function clientWith(data: FakeBigtableData): Promise<Bigtable> {
  resetFakeBigtable(data);
  return new BigtableClientPool().get(PROJECT);
}

describe('listInstances', () => {
  beforeEach(() => {
    resetFakeBigtable();
  });

  it('reports every instance with its state and type as names', async () => {
    const client = await clientWith({
      instances: [
        {
          id: INSTANCE,
          metadata: {
            displayName: 'Test Instance',
            state: 1,
            type: 1,
            labels: {env: 'test'},
          },
        },
      ],
    });

    const result = await listInstances(client, PROJECT);

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      results: [
        {
          projectId: PROJECT,
          instanceId: INSTANCE,
          displayName: 'Test Instance',
          state: 'READY',
          type: 'PRODUCTION',
          labels: {env: 'test'},
        },
      ],
    });
  });

  it('accepts a state the API returned as a name', async () => {
    const client = await clientWith({
      instances: [{id: INSTANCE, metadata: {state: 'CREATING', type: 2}}],
    });

    const [instance] = (await listInstances(client, PROJECT)).results;

    expect(instance.state).toBe('CREATING');
    expect(instance.type).toBe('DEVELOPMENT');
  });

  it('names an unknown state after the value the API returned', async () => {
    const client = await clientWith({
      instances: [{id: INSTANCE, metadata: {state: 99}}],
    });

    const [instance] = (await listInstances(client, PROJECT)).results;

    expect(instance.state).toBe('UNKNOWN_STATE_99');
    expect(instance.type).toBe('UNKNOWN_TYPE');
  });

  it('reports the locations it could not reach and returns the rest', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const client = await clientWith({
      instances: [{id: INSTANCE, metadata: {state: 1}}],
      failedLocations: ['us-east1-b', 'us-east1-c'],
    });

    const result = await listInstances(client, PROJECT);

    expect(result.status).toBe(GoogleToolStatus.SUCCESS);
    expect(result.results).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'Failed to list instances from the following locations: us-east1-b, us-east1-c',
    );
    warn.mockRestore();
  });

  it('logs nothing when every location answered', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const client = await clientWith({
      instances: [{id: INSTANCE, metadata: {}}],
      failedLocations: [],
    });

    await listInstances(client, PROJECT);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('surfaces a failure by throwing, so the tool wraps it', async () => {
    const client = await clientWith({});
    vi.spyOn(client, 'getInstances').mockRejectedValue(new Error('denied'));

    await expect(listInstances(client, PROJECT)).rejects.toThrow('denied');
  });
});

describe('getInstanceInfo', () => {
  it('reports the metadata of one instance', async () => {
    const client = await clientWith({
      instanceData: {
        [INSTANCE]: {
          metadata: {displayName: 'Test Instance', state: 2, type: 2},
        },
      },
    });

    const result = await getInstanceInfo(client, PROJECT, INSTANCE);

    expect(result.results).toEqual({
      projectId: PROJECT,
      instanceId: INSTANCE,
      displayName: 'Test Instance',
      state: 'CREATING',
      type: 'DEVELOPMENT',
      labels: undefined,
    });
  });
});

describe('listTables', () => {
  it('reports each table id with its resource name', async () => {
    const client = await clientWith({
      instanceData: {
        [INSTANCE]: {
          tables: [
            {
              id: 'test-table',
              name: `projects/${PROJECT}/instances/${INSTANCE}/tables/test-table`,
            },
          ],
        },
      },
    });

    const result = await listTables(client, PROJECT, INSTANCE);

    expect(result).toEqual({
      status: GoogleToolStatus.SUCCESS,
      results: [
        {
          projectId: PROJECT,
          instanceId: INSTANCE,
          tableId: 'test-table',
          tableName: `projects/${PROJECT}/instances/${INSTANCE}/tables/test-table`,
        },
      ],
    });
  });
});

describe('getTableInfo', () => {
  it('reports the column families of a table', async () => {
    const client = await clientWith({
      instanceData: {[INSTANCE]: {families: {'test-table': ['cf1', 'cf2']}}},
    });

    const result = await getTableInfo(client, PROJECT, INSTANCE, 'test-table');

    expect(result.results).toEqual({
      projectId: PROJECT,
      instanceId: INSTANCE,
      tableId: 'test-table',
      columnFamilies: ['cf1', 'cf2'],
    });
  });
});

describe('listClusters', () => {
  it('reports each cluster with its location id', async () => {
    const client = await clientWith({
      instanceData: {
        [INSTANCE]: {
          clusters: [
            {
              id: 'test-cluster',
              metadata: {
                name: `projects/${PROJECT}/instances/${INSTANCE}/clusters/test-cluster`,
                state: 1,
                serveNodes: 3,
                defaultStorageType: 1,
                location: `projects/${PROJECT}/locations/us-central1-a`,
              },
            },
          ],
        },
      },
    });

    const result = await listClusters(client, PROJECT, INSTANCE);

    expect(result.results).toEqual([
      {
        projectId: PROJECT,
        instanceId: INSTANCE,
        clusterId: 'test-cluster',
        clusterName: `projects/${PROJECT}/instances/${INSTANCE}/clusters/test-cluster`,
        state: 'READY',
        serveNodes: 3,
        defaultStorageType: 'SSD',
        locationId: 'us-central1-a',
      },
    ]);
  });

  it('reports the locations it could not reach and returns the rest', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const client = await clientWith({
      instanceData: {
        [INSTANCE]: {
          clusters: [{id: 'test-cluster', metadata: {}}],
          clustersResponse: {failedLocations: ['us-west1-a']},
        },
      },
    });

    const result = await listClusters(client, PROJECT, INSTANCE);

    expect(result.results).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      'Failed to list clusters from the following locations: us-west1-a',
    );
    warn.mockRestore();
  });

  it('reads no locations from a response that carries none', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const client = await clientWith({
      instanceData: {
        [INSTANCE]: {
          clusters: [{id: 'test-cluster', metadata: {}}],
          clustersResponse: {failedLocations: ['ok', 7]},
        },
      },
    });

    await listClusters(client, PROJECT, INSTANCE);

    expect(warn).toHaveBeenCalledWith(
      'Failed to list clusters from the following locations: ok',
    );
    warn.mockRestore();
  });

  it('logs nothing when the response carries no location list', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const client = await clientWith({
      instanceData: {
        [INSTANCE]: {
          clusters: [{id: 'test-cluster', metadata: {}}],
          clustersResponse: {failedLocations: 'us-west1-a'},
        },
      },
    });

    await listClusters(client, PROJECT, INSTANCE);

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('logs nothing when the response is not an object', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const client = await clientWith({
      instanceData: {
        [INSTANCE]: {
          clusters: [{id: 'test-cluster', metadata: {}}],
          clustersResponse: null,
        },
      },
    });

    const result = await listClusters(client, PROJECT, INSTANCE);

    expect(result.results[0].locationId).toBe('');
    expect(result.results[0].defaultStorageType).toBe('UNKNOWN_STORAGE_TYPE');
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('getClusterInfo', () => {
  it('reports the autoscaling limits of a cluster', async () => {
    const client = await clientWith({
      instanceData: {
        [INSTANCE]: {
          clusters: [
            {
              id: 'test-cluster',
              metadata: {
                state: 3,
                serveNodes: 5,
                defaultStorageType: 2,
                location: `projects/${PROJECT}/locations/us-central1-b`,
                clusterConfig: {
                  clusterAutoscalingConfig: {
                    autoscalingLimits: {minServeNodes: 1, maxServeNodes: 10},
                    autoscalingTargets: {cpuUtilizationPercent: 80},
                  },
                },
              },
            },
          ],
        },
      },
    });

    const result = await getClusterInfo(
      client,
      PROJECT,
      INSTANCE,
      'test-cluster',
    );

    expect(result.results).toMatchObject({
      clusterId: 'test-cluster',
      state: 'RESIZING',
      serveNodes: 5,
      defaultStorageType: 'HDD',
      locationId: 'us-central1-b',
      minServeNodes: 1,
      maxServeNodes: 10,
      cpuUtilizationPercent: 80,
    });
  });

  it('omits the autoscaling limits of a cluster that has none', async () => {
    const client = await clientWith({
      instanceData: {
        [INSTANCE]: {clusters: [{id: 'test-cluster', metadata: {state: 4}}]},
      },
    });

    const result = await getClusterInfo(
      client,
      PROJECT,
      INSTANCE,
      'test-cluster',
    );

    expect(result.results.state).toBe('DISABLED');
    expect(result.results.minServeNodes).toBeUndefined();
    expect(result.results.maxServeNodes).toBeUndefined();
    expect(result.results.cpuUtilizationPercent).toBeUndefined();
  });
});
