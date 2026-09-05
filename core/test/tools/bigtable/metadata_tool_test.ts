/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';
import {BigtableClientCache} from '../../../src/tools/bigtable/client.js';
import {createMetadataTools} from '../../../src/tools/bigtable/metadata_tool.js';
import {logger} from '../../../src/utils/logger.js';
import {
  createToolContext,
  FakeBigtable,
  FakeBigtableSetup,
} from './bigtable_fakes.js';

vi.mock('@google-cloud/bigtable', () => ({Bigtable: FakeBigtable}));

const PROJECT = 'test-project';
const INSTANCE = 'test-instance';

/** Runs one metadata tool by name and returns its envelope. */
async function runTool(
  setup: FakeBigtableSetup,
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  FakeBigtable.reset(setup);
  const tools = createMetadataTools(new BigtableClientCache());
  const tool = tools.find((candidate) => candidate.name === name);
  if (tool === undefined) {
    return expect.fail(`no tool named ${name}`);
  }
  return tool.runAsync({args, toolContext: await createToolContext()});
}

describe('list_instances', () => {
  it('reports every instance with adk-python\u2019s field names', async () => {
    const result = await runTool(
      {
        listedInstances: [
          {
            id: INSTANCE,
            metadata: {
              displayName: 'Test Instance',
              state: 'READY',
              type: 'PRODUCTION',
              labels: {env: 'test'},
            },
          },
        ],
      },
      'list_instances',
      {project_id: PROJECT},
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      results: [
        {
          project_id: PROJECT,
          instance_id: INSTANCE,
          display_name: 'Test Instance',
          state: 'READY',
          type: 'PRODUCTION',
          labels: {env: 'test'},
        },
      ],
    });
  });

  it('reports the locations the admin API could not reach', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await runTool(
      {listedInstances: [], failedInstanceLocations: ['us-east1-b']},
      'list_instances',
      {project_id: PROJECT},
    );

    expect(warn).toHaveBeenCalledWith(
      'Failed to list instances from the following locations: us-east1-b',
    );
    warn.mockRestore();
  });

  it('stays quiet when every location answered', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await runTool(
      {listedInstances: [], failedInstanceLocations: []},
      'list_instances',
      {project_id: PROJECT},
    );

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('returns the ERROR envelope when the admin API fails', async () => {
    const result = await runTool(
      {listError: new Error('permission denied')},
      'list_instances',
      {project_id: PROJECT},
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'permission denied',
    });
  });
});

describe('get_instance_info', () => {
  it('reports the instance metadata', async () => {
    const result = await runTool(
      {
        instances: {
          [INSTANCE]: {
            metadata: {
              displayName: 'Test Instance',
              state: 'READY',
              type: 'PRODUCTION',
              labels: {},
            },
          },
        },
      },
      'get_instance_info',
      {project_id: PROJECT, instance_id: INSTANCE},
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      results: {
        project_id: PROJECT,
        instance_id: INSTANCE,
        display_name: 'Test Instance',
        state: 'READY',
        type: 'PRODUCTION',
        labels: {},
      },
    });
  });

  it('names a numeric enum value the way adk-python names an unmatched one', async () => {
    const result = await runTool(
      {instances: {[INSTANCE]: {metadata: {state: 7, type: 9}}}},
      'get_instance_info',
      {project_id: PROJECT, instance_id: INSTANCE},
    );

    expect(result).toMatchObject({
      results: {state: 'UNKNOWN_STATE_7', type: 'UNKNOWN_TYPE_9'},
    });
  });

  it('falls back to the unknown name when the API reported no state', async () => {
    const result = await runTool(
      {instances: {[INSTANCE]: {metadata: {}}}},
      'get_instance_info',
      {project_id: PROJECT, instance_id: INSTANCE},
    );

    expect(result).toMatchObject({
      results: {state: 'UNKNOWN_STATE', type: 'UNKNOWN_TYPE'},
    });
  });

  it('returns the ERROR envelope when the instance cannot be read', async () => {
    const result = await runTool(
      {instances: {[INSTANCE]: {error: new Error('instance not found')}}},
      'get_instance_info',
      {project_id: PROJECT, instance_id: INSTANCE},
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'instance not found',
    });
  });
});

describe('list_tables', () => {
  it('reports each table id and its resource name', async () => {
    const result = await runTool(
      {
        instances: {
          [INSTANCE]: {
            tables: [
              {
                id: 'test-table',
                name: `projects/${PROJECT}/instances/${INSTANCE}/tables/test-table`,
                families: [],
              },
            ],
          },
        },
      },
      'list_tables',
      {project_id: PROJECT, instance_id: INSTANCE},
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      results: [
        {
          project_id: PROJECT,
          instance_id: INSTANCE,
          table_id: 'test-table',
          table_name: `projects/${PROJECT}/instances/${INSTANCE}/tables/test-table`,
        },
      ],
    });
  });

  it('returns the ERROR envelope when the tables cannot be listed', async () => {
    const result = await runTool(
      {instances: {[INSTANCE]: {error: new Error('deadline exceeded')}}},
      'list_tables',
      {project_id: PROJECT, instance_id: INSTANCE},
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'deadline exceeded',
    });
  });
});

describe('get_table_info', () => {
  it('reports the column family ids', async () => {
    const result = await runTool(
      {
        instances: {
          [INSTANCE]: {
            tables: [
              {id: 'test-table', name: 'fake-name', families: ['cf1', 'cf2']},
            ],
          },
        },
      },
      'get_table_info',
      {project_id: PROJECT, instance_id: INSTANCE, table_id: 'test-table'},
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      results: {
        project_id: PROJECT,
        instance_id: INSTANCE,
        table_id: 'test-table',
        column_families: ['cf1', 'cf2'],
      },
    });
  });

  it('returns the ERROR envelope when the table cannot be read', async () => {
    const result = await runTool(
      {instances: {[INSTANCE]: {error: new Error('table not found')}}},
      'get_table_info',
      {project_id: PROJECT, instance_id: INSTANCE, table_id: 'missing'},
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'table not found',
    });
  });
});

describe('list_clusters', () => {
  it('reports each cluster with its zone taken from the location path', async () => {
    const result = await runTool(
      {
        instances: {
          [INSTANCE]: {
            clusters: [
              {
                id: 'test-cluster',
                name: 'fake-cluster-name',
                metadata: {
                  location: `projects/${PROJECT}/locations/us-central1-a`,
                  state: 'READY',
                  serveNodes: 3,
                  defaultStorageType: 'SSD',
                },
              },
            ],
          },
        },
      },
      'list_clusters',
      {project_id: PROJECT, instance_id: INSTANCE},
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      results: [
        {
          project_id: PROJECT,
          instance_id: INSTANCE,
          cluster_id: 'test-cluster',
          cluster_name: 'fake-cluster-name',
          state: 'READY',
          serve_nodes: 3,
          default_storage_type: 'SSD',
          location_id: 'us-central1-a',
        },
      ],
    });
  });

  it('reports the locations the admin API could not reach', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    await runTool(
      {
        instances: {
          [INSTANCE]: {clusters: [], failedClusterLocations: ['us-west1-c']},
        },
      },
      'list_clusters',
      {project_id: PROJECT, instance_id: INSTANCE},
    );

    expect(warn).toHaveBeenCalledWith(
      'Failed to list clusters from the following locations: us-west1-c',
    );
    warn.mockRestore();
  });

  it('reports an empty location id when the cluster carries no location', async () => {
    const result = await runTool(
      {
        instances: {
          [INSTANCE]: {
            clusters: [{id: 'c1', name: 'n1', metadata: {}}],
          },
        },
      },
      'list_clusters',
      {project_id: PROJECT, instance_id: INSTANCE},
    );

    expect(result).toMatchObject({
      results: [
        {location_id: '', default_storage_type: 'UNKNOWN_STORAGE_TYPE'},
      ],
    });
  });

  it('reports no clusters when the admin API answered with none', async () => {
    const result = await runTool(
      {instances: {[INSTANCE]: {}}},
      'list_clusters',
      {
        project_id: PROJECT,
        instance_id: INSTANCE,
      },
    );

    expect(result).toEqual({status: 'SUCCESS', results: []});
  });

  it('returns the ERROR envelope when the clusters cannot be listed', async () => {
    const result = await runTool(
      {instances: {[INSTANCE]: {error: new Error('cluster list failed')}}},
      'list_clusters',
      {project_id: PROJECT, instance_id: INSTANCE},
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'cluster list failed',
    });
  });
});

describe('get_cluster_info', () => {
  it('reports the autoscaling limits alongside the cluster metadata', async () => {
    const result = await runTool(
      {
        instances: {
          [INSTANCE]: {
            clusters: [
              {
                id: 'test-cluster',
                name: 'fake-cluster-name',
                metadata: {
                  location: `projects/${PROJECT}/locations/us-central1-a`,
                  state: 'READY',
                  serveNodes: 3,
                  defaultStorageType: 'SSD',
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
      },
      'get_cluster_info',
      {project_id: PROJECT, instance_id: INSTANCE, cluster_id: 'test-cluster'},
    );

    expect(result).toEqual({
      status: 'SUCCESS',
      results: {
        project_id: PROJECT,
        instance_id: INSTANCE,
        cluster_id: 'test-cluster',
        state: 'READY',
        serve_nodes: 3,
        default_storage_type: 'SSD',
        location_id: 'us-central1-a',
        min_serve_nodes: 1,
        max_serve_nodes: 10,
        cpu_utilization_percent: 80,
      },
    });
  });

  it('leaves the autoscaling limits out when the cluster does not autoscale', async () => {
    const result = await runTool(
      {
        instances: {
          [INSTANCE]: {
            clusters: [
              {id: 'test-cluster', name: 'n', metadata: {serveNodes: 3}},
            ],
          },
        },
      },
      'get_cluster_info',
      {project_id: PROJECT, instance_id: INSTANCE, cluster_id: 'test-cluster'},
    );

    expect(result).toMatchObject({
      results: {
        min_serve_nodes: undefined,
        max_serve_nodes: undefined,
        cpu_utilization_percent: undefined,
      },
    });
  });

  it('returns the ERROR envelope when the cluster cannot be read', async () => {
    const result = await runTool(
      {instances: {[INSTANCE]: {error: new Error('cluster not found')}}},
      'get_cluster_info',
      {project_id: PROJECT, instance_id: INSTANCE, cluster_id: 'missing'},
    );

    expect(result).toEqual({
      status: 'ERROR',
      error_details: 'cluster not found',
    });
  });
});
