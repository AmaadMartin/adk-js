/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Bigtable} from '@google-cloud/bigtable';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import * as metadataTool from '../../../src/tools/bigtable/metadata_tool.js';

import type {FakeBigtable} from './bigtable_test_utils.js';
import {
  expectErrorDetails,
  expectSuccess,
  fakeCluster,
  fakeInstance,
  fakeTable,
} from './bigtable_test_utils.js';

const {bigtableMock, BigtableMock} = vi.hoisted(() => {
  const bigtableMock: FakeBigtable = {
    projectId: 'proj-1',
    getInstances: vi.fn(),
    instance: vi.fn(),
    close: vi.fn(async () => []),
  };
  return {bigtableMock, BigtableMock: vi.fn(() => bigtableMock)};
});

vi.mock('@google-cloud/bigtable', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@google-cloud/bigtable')>()),
  Bigtable: BigtableMock,
}));

describe('Bigtable Metadata Tool', () => {
  // Runtime value is `bigtableMock`; the type is the real client, which is
  // what the tools are declared against.
  let client: Bigtable;

  beforeEach(() => {
    vi.clearAllMocks();
    client = new Bigtable({projectId: 'proj-1'});
  });

  it('listInstances returns instances', async () => {
    bigtableMock.getInstances.mockResolvedValue([
      [
        {
          id: 'inst1',
          metadata: {
            displayName: 'Inst 1',
            state: 'READY',
            type: 'PRODUCTION',
            labels: {env: 'prod'},
          },
        },
      ],
    ]);

    expect(
      expectSuccess(await metadataTool.listInstances(client)).results,
    ).toEqual([
      {
        project_id: 'proj-1',
        instance_id: 'inst1',
        display_name: 'Inst 1',
        state: 'READY',
        type: 'PRODUCTION',
        labels: {env: 'prod'},
      },
    ]);
  });

  it('listInstances reports an instance with no labels as an empty map', async () => {
    bigtableMock.getInstances.mockResolvedValue([[{id: 'inst1'}]]);

    expect(
      expectSuccess(await metadataTool.listInstances(client)).results,
    ).toEqual([
      {
        project_id: 'proj-1',
        instance_id: 'inst1',
        display_name: undefined,
        state: undefined,
        type: undefined,
        labels: {},
      },
    ]);
  });

  it('getInstanceInfo reports an instance with no labels as an empty map', async () => {
    const instance = fakeInstance();
    instance.getMetadata.mockResolvedValue([{}]);
    bigtableMock.instance.mockReturnValue(instance);

    expect(
      expectSuccess(await metadataTool.getInstanceInfo(client, 'inst1')).results
        .labels,
    ).toEqual({});
  });

  it('listInstances reports the failure instead of throwing', async () => {
    bigtableMock.getInstances.mockRejectedValue(new Error('fail'));

    expect(
      expectErrorDetails(await metadataTool.listInstances(client)),
    ).toContain('fail');
  });

  it('getInstanceInfo returns the instance metadata', async () => {
    const instance = fakeInstance();
    instance.getMetadata.mockResolvedValue([
      {
        displayName: 'Inst 1',
        state: 'READY',
        type: 'PRODUCTION',
        labels: {env: 'prod'},
      },
    ]);
    bigtableMock.instance.mockReturnValue(instance);

    expect(
      expectSuccess(await metadataTool.getInstanceInfo(client, 'inst1'))
        .results,
    ).toEqual({
      project_id: 'proj-1',
      instance_id: 'inst1',
      display_name: 'Inst 1',
      state: 'READY',
      type: 'PRODUCTION',
      labels: {env: 'prod'},
    });
  });

  it('getInstanceInfo reports the failure instead of throwing', async () => {
    bigtableMock.instance.mockImplementation(() => {
      throw new Error('fail');
    });

    expect(
      expectErrorDetails(await metadataTool.getInstanceInfo(client, 'inst1')),
    ).toContain('fail');
  });

  it('listTables returns the tables', async () => {
    const instance = fakeInstance();
    instance.getTables.mockResolvedValue([
      [{id: 'table1', name: 'proj/inst1/table/table1'}],
    ]);
    bigtableMock.instance.mockReturnValue(instance);

    expect(
      expectSuccess(await metadataTool.listTables(client, 'inst1')).results,
    ).toEqual([
      {
        project_id: 'proj-1',
        instance_id: 'inst1',
        table_id: 'table1',
        table_name: 'proj/inst1/table/table1',
      },
    ]);
  });

  it('listTables reports the failure instead of throwing', async () => {
    bigtableMock.instance.mockImplementation(() => {
      throw new Error('fail');
    });

    expect(
      expectErrorDetails(await metadataTool.listTables(client, 'inst1')),
    ).toContain('fail');
  });

  it('getTableInfo returns the column families', async () => {
    const table = fakeTable();
    table.getMetadata.mockResolvedValue([
      {columnFamilies: {fam1: {}, fam2: {}}},
    ]);
    const instance = fakeInstance();
    instance.table.mockReturnValue(table);
    bigtableMock.instance.mockReturnValue(instance);

    expect(
      expectSuccess(await metadataTool.getTableInfo(client, 'inst1', 'table1'))
        .results.column_families,
    ).toEqual(['fam1', 'fam2']);
  });

  it('getTableInfo returns an empty list when there are no column families', async () => {
    const table = fakeTable();
    table.getMetadata.mockResolvedValue([{columnFamilies: undefined}]);
    const instance = fakeInstance();
    instance.table.mockReturnValue(table);
    bigtableMock.instance.mockReturnValue(instance);

    expect(
      expectSuccess(await metadataTool.getTableInfo(client, 'inst1', 'table1'))
        .results.column_families,
    ).toEqual([]);
  });

  it('getTableInfo reports the failure instead of throwing', async () => {
    const instance = fakeInstance();
    instance.table.mockImplementation(() => {
      throw new Error('fail');
    });
    bigtableMock.instance.mockReturnValue(instance);

    expect(
      expectErrorDetails(
        await metadataTool.getTableInfo(client, 'inst1', 'table1'),
      ),
    ).toContain('fail');
  });

  it('listClusters returns the clusters', async () => {
    const instance = fakeInstance();
    instance.getClusters.mockResolvedValue([
      [
        fakeCluster({
          id: 'clust1',
          name: 'clus',
          metadata: {
            state: 'READY',
            serveNodes: 3,
            defaultStorageType: 'SSD',
            location: 'us-east1',
          },
        }),
      ],
    ]);
    bigtableMock.instance.mockReturnValue(instance);

    expect(
      expectSuccess(await metadataTool.listClusters(client, 'inst1')).results,
    ).toEqual([
      {
        project_id: 'proj-1',
        instance_id: 'inst1',
        cluster_id: 'clust1',
        cluster_name: 'clus',
        state: 'READY',
        serve_nodes: 3,
        default_storage_type: 'SSD',
        location_id: 'us-east1',
      },
    ]);
  });

  it('listClusters reports the failure instead of throwing', async () => {
    bigtableMock.instance.mockImplementation(() => {
      throw new Error('fail');
    });

    expect(
      expectErrorDetails(await metadataTool.listClusters(client, 'inst1')),
    ).toContain('fail');
  });

  it('getClusterInfo returns the autoscaling configuration', async () => {
    const cluster = fakeCluster({id: 'clust1'});
    cluster.getMetadata.mockResolvedValue([
      {
        state: 'READY',
        serveNodes: 3,
        defaultStorageType: 'SSD',
        location: 'loc',
        clusterConfig: {
          clusterAutoscalingConfig: {
            autoscalingLimits: {minServeNodes: 1, maxServeNodes: 5},
            autoscalingTargets: {cpuUtilizationPercent: 50},
          },
        },
      },
    ]);
    const instance = fakeInstance();
    instance.cluster.mockReturnValue(cluster);
    bigtableMock.instance.mockReturnValue(instance);

    expect(
      expectSuccess(
        await metadataTool.getClusterInfo(client, 'inst1', 'clust1'),
      ).results,
    ).toEqual({
      project_id: 'proj-1',
      instance_id: 'inst1',
      cluster_id: 'clust1',
      state: 'READY',
      serve_nodes: 3,
      default_storage_type: 'SSD',
      location_id: 'loc',
      min_serve_nodes: 1,
      max_serve_nodes: 5,
      cpu_utilization_percent: 50,
    });
  });

  it('getClusterInfo reports the failure instead of throwing', async () => {
    bigtableMock.instance.mockImplementation(() => {
      throw new Error('fail');
    });

    expect(
      expectErrorDetails(
        await metadataTool.getClusterInfo(client, 'inst1', 'clust1'),
      ),
    ).toContain('fail');
  });
});
