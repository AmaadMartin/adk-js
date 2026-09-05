/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports `tests/unittests/tools/spanner/test_admin_tool.py`, read from
 * google/adk-python `main`. The titles below are descriptive, matching the
 * eleven sibling Spanner test files; this table maps them back:
 *
 * | Python test | Title here |
 * | --- | --- |
 * | `test_list_instances_success` | "reports the id of every instance" |
 * | `test_list_instances_error` | "reports a rejected listing as an error" |
 * | `test_get_instance_success` | "reports the six instance fields" |
 * | `test_get_instance_error` | "reports a rejected read as an error" |
 * | `test_list_instance_configs_success` | "reports the id of every instance config" |
 * | `test_get_instance_config_success` | "names the replica type instead of numbering it" |
 * | `test_get_instance_config_error` | "reports a rejected read as an error" |
 * | `test_create_instance_success` | "reports the instance it created" |
 * | `test_create_database_success` | "reports no results, unlike create_instance" |
 */

import {SpannerAdminToolset} from '@google/adk/tools/spanner';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {OPERATION_TIMEOUT_MS} from '../../../src/tools/spanner/client.js';
import {logger} from '../../../src/utils/logger.js';
import {
  confirmedToolContext,
  errorOf,
  runTool,
  spannerFake,
  successOf,
  testCredentialsConfig,
} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner', async () => {
  const {fakeSpannerModule} = await import('./spanner_test_utils.js');
  return fakeSpannerModule;
});

const PROJECT_ARGS = {project_id: 'test-project'};
const INSTANCE_ARGS = {...PROJECT_ARGS, instance_id: 'test-instance'};

function toolset(): SpannerAdminToolset {
  return new SpannerAdminToolset({credentialsConfig: testCredentialsConfig()});
}

/**
 * How long a tool call may take to arm its timeout timer.
 *
 * A wall-clock bound rather than a tick count: the call awaits the credentials
 * and the peer dependency first, and a loaded full-suite run needs more
 * event-loop turns for that than the file does on its own.
 */
const ARM_TIMER_DEADLINE_MS = 2000;

/** Yields to the real event loop until the tool call arms its timeout timer. */
async function waitForArmedTimer(): Promise<void> {
  const deadline = Date.now() + ARM_TIMER_DEADLINE_MS;
  while (vi.getTimerCount() === 0 && Date.now() < deadline) {
    await new Promise((resolve) => setImmediate(resolve));
  }
  expect(vi.getTimerCount()).toBe(1);
}

/** The `results` field of a tool call that must have succeeded. */
async function resultsOf(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  // Approved, so a gated tool runs its body instead of asking again. The
  // ungated five ignore it.
  return successOf(
    await runTool(toolset(), name, args, confirmedToolContext()),
  )['results'];
}

/** Runs one tool with the user's approval already given. */
function runApproved(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  return runTool(toolset(), name, args, confirmedToolContext());
}

describe('the Spanner admin tools', () => {
  beforeEach(() => {
    spannerFake.reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('spanner_list_instances', () => {
    it('reports the id of every instance', async () => {
      spannerFake.responses.instances = [
        {name: 'projects/test-project/instances/test-instance-1'},
        {name: 'projects/test-project/instances/test-instance-2'},
      ];

      const results = await resultsOf('spanner_list_instances', PROJECT_ARGS);

      expect(results).toEqual(['test-instance-1', 'test-instance-2']);
      expect(spannerFake.requestsFor('listInstancesAsync')).toEqual([
        {parent: 'projects/test-project'},
      ]);
      expect(spannerFake.pathArgsFor('projectPath')).toEqual([
        ['test-project'],
      ]);
      expect(spannerFake.closedClients).toBe(1);
    });

    it('reports a rejected listing as an error', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      spannerFake.failures.listInstances = new Error('test error');

      const result = await runTool(
        toolset(),
        'spanner_list_instances',
        PROJECT_ARGS,
      );

      expect(errorOf(result)).toContain('test error');
      expect(spannerFake.closedClients).toBe(1);
    });

    it('reports an empty project as an empty list', async () => {
      expect(await resultsOf('spanner_list_instances', PROJECT_ARGS)).toEqual(
        [],
      );
    });

    it('reports an instance with no name as an empty id', async () => {
      spannerFake.responses.instances = [{}];

      expect(await resultsOf('spanner_list_instances', PROJECT_ARGS)).toEqual([
        '',
      ]);
    });
  });

  describe('spanner_get_instance', () => {
    it('reports the six instance fields', async () => {
      spannerFake.responses.instance = {
        name: 'projects/test-project/instances/test-instance',
        displayName: 'Test Instance',
        config: 'projects/test-project/instanceConfigs/regional-us-central1',
        nodeCount: 1,
        processingUnits: 1000,
        labels: {env: 'test'},
      };

      const results = await resultsOf('spanner_get_instance', INSTANCE_ARGS);

      expect(results).toEqual({
        instance_id: 'test-instance',
        display_name: 'Test Instance',
        config: 'projects/test-project/instanceConfigs/regional-us-central1',
        node_count: 1,
        processing_units: 1000,
        labels: {env: 'test'},
      });
      expect(spannerFake.pathArgsFor('instancePath')).toEqual([
        ['test-project', 'test-instance'],
      ]);
      expect(spannerFake.requestsFor('getInstance')).toEqual([
        {name: 'projects/test-project/instances/test-instance'},
      ]);
    });

    it('reports an instance with no labels as having none', async () => {
      spannerFake.responses.instance = {displayName: 'No Labels'};

      const results = await resultsOf('spanner_get_instance', INSTANCE_ARGS);

      expect(results).toMatchObject({labels: {}});
    });

    it('reports a rejected read as an error', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      spannerFake.failures.getInstance = new Error('test error');

      const result = await runTool(
        toolset(),
        'spanner_get_instance',
        INSTANCE_ARGS,
      );

      expect(errorOf(result)).toContain('test error');
      expect(spannerFake.closedClients).toBe(1);
    });
  });

  describe('spanner_list_instance_configs', () => {
    it('reports the id of every instance config', async () => {
      spannerFake.responses.instanceConfigs = [
        {name: 'projects/test-project/instanceConfigs/config-1'},
        {name: 'projects/test-project/instanceConfigs/config-2'},
      ];

      const results = await resultsOf(
        'spanner_list_instance_configs',
        PROJECT_ARGS,
      );

      expect(results).toEqual(['config-1', 'config-2']);
      expect(spannerFake.requestsFor('listInstanceConfigsAsync')).toEqual([
        {parent: 'projects/test-project'},
      ]);
      expect(spannerFake.pathArgsFor('projectPath')).toEqual([
        ['test-project'],
      ]);
    });

    it('reports a rejected listing as an error', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      spannerFake.failures.listInstanceConfigs = new Error('test error');

      const result = await runTool(
        toolset(),
        'spanner_list_instance_configs',
        PROJECT_ARGS,
      );

      expect(errorOf(result)).toContain('test error');
    });
  });

  describe('spanner_get_instance_config', () => {
    const CONFIG_ARGS = {...PROJECT_ARGS, config_id: 'config-1'};

    it('names the replica type instead of numbering it', async () => {
      spannerFake.responses.instanceConfig = {
        name: 'projects/test-project/instanceConfigs/config-1',
        displayName: 'Config 1',
        labels: {env: 'test'},
        replicas: [
          {location: 'us-central1', type: 1, defaultLeaderLocation: true},
        ],
      };

      const results = await resultsOf(
        'spanner_get_instance_config',
        CONFIG_ARGS,
      );

      expect(results).toEqual({
        name: 'projects/test-project/instanceConfigs/config-1',
        display_name: 'Config 1',
        replicas: [
          {
            location: 'us-central1',
            type: 'READ_WRITE',
            default_leader_location: true,
          },
        ],
        labels: {env: 'test'},
      });
      expect(spannerFake.pathArgsFor('instanceConfigPath')).toEqual([
        ['test-project', 'config-1'],
      ]);
      expect(spannerFake.requestsFor('getInstanceConfig')).toEqual([
        {name: 'projects/test-project/instanceConfigs/config-1'},
      ]);
    });

    it('keeps a replica type the wire already names', async () => {
      spannerFake.responses.instanceConfig = {
        replicas: [{location: 'us-east1', type: 'READ_ONLY'}],
      };

      const results = await resultsOf(
        'spanner_get_instance_config',
        CONFIG_ARGS,
      );

      expect(results).toMatchObject({
        replicas: [expect.objectContaining({type: 'READ_ONLY'})],
      });
    });

    it('reports a replica with no type as unspecified', async () => {
      spannerFake.responses.instanceConfig = {
        replicas: [{location: 'us-west1'}],
      };

      const results = await resultsOf(
        'spanner_get_instance_config',
        CONFIG_ARGS,
      );

      expect(results).toMatchObject({
        replicas: [expect.objectContaining({type: 'TYPE_UNSPECIFIED'})],
      });
    });

    it('reports a config with no replicas as having none', async () => {
      spannerFake.responses.instanceConfig = {displayName: 'Empty'};

      const results = await resultsOf(
        'spanner_get_instance_config',
        CONFIG_ARGS,
      );

      expect(results).toMatchObject({replicas: [], labels: {}});
    });

    it('reports a rejected read as an error', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      spannerFake.failures.getInstanceConfig = new Error('test error');

      const result = await runTool(
        toolset(),
        'spanner_get_instance_config',
        CONFIG_ARGS,
      );

      expect(errorOf(result)).toContain('test error');
    });
  });

  describe('spanner_create_instance', () => {
    const CREATE_ARGS = {
      ...INSTANCE_ARGS,
      config_id: 'config-1',
      display_name: 'Test Instance',
    };

    it('reports the instance it created', async () => {
      const results = await resultsOf('spanner_create_instance', CREATE_ARGS);

      expect(results).toBe('Instance test-instance created successfully.');
      expect(spannerFake.requestsFor('createInstance')).toEqual([
        {
          parent: 'projects/test-project',
          instanceId: 'test-instance',
          instance: {
            displayName: 'Test Instance',
            config: 'projects/test-project/instanceConfigs/config-1',
            nodeCount: 1,
          },
        },
      ]);
      expect(spannerFake.requestsFor('operation.promise')).toHaveLength(1);
      expect(spannerFake.closedClients).toBe(1);
    });

    it('sends the node count the model asked for', async () => {
      await resultsOf('spanner_create_instance', {...CREATE_ARGS, nodes: 3});

      expect(spannerFake.requestsFor('createInstance')[0]).toMatchObject({
        instance: expect.objectContaining({nodeCount: 3}),
      });
    });

    it('reports a rejected creation as an error', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      spannerFake.failures.createInstance = new Error('test error');

      const result = await runApproved('spanner_create_instance', CREATE_ARGS);

      expect(errorOf(result)).toContain('test error');
      expect(spannerFake.closedClients).toBe(1);
    });

    it('reports a failed operation as an error', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      spannerFake.operationOutcome = 'reject';
      spannerFake.failures.operation = new Error('provisioning failed');

      const result = await runApproved('spanner_create_instance', CREATE_ARGS);

      expect(errorOf(result)).toContain('provisioning failed');
    });

    it('gives up on an operation that never finishes', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      // Only `setTimeout` is faked, so the loop below can still yield to the
      // real event loop while the tool call reaches its timeout timer.
      vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
      spannerFake.operationOutcome = 'pending';

      const pending = runApproved('spanner_create_instance', CREATE_ARGS);
      await waitForArmedTimer();
      await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS);
      const result = await pending;
      vi.useRealTimers();

      expect(errorOf(result)).toContain(
        `did not complete within ${OPERATION_TIMEOUT_MS} ms`,
      );
      // Cancelled, so google-gax stops polling once the tool has answered.
      expect(spannerFake.cancelledOperations).toBe(1);
      expect(spannerFake.closedClients).toBe(1);
    });

    it('keeps the timeout error when cancelling the operation fails', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.useFakeTimers({toFake: ['setTimeout', 'clearTimeout']});
      spannerFake.operationOutcome = 'pending';
      spannerFake.failures.cancelOperation = new Error('cancel failed');

      const pending = runApproved('spanner_create_instance', CREATE_ARGS);
      await waitForArmedTimer();
      await vi.advanceTimersByTimeAsync(OPERATION_TIMEOUT_MS);
      const result = await pending;
      vi.useRealTimers();

      expect(errorOf(result)).toContain(
        `did not complete within ${OPERATION_TIMEOUT_MS} ms`,
      );
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to close the Spanner operation'),
      );
    });

    it('refuses a node count below one', async () => {
      // The schema rejects it in `FunctionTool.runAsync`, before the tool body
      // and its `ERROR` envelope are reached.
      await expect(
        runApproved('spanner_create_instance', {...CREATE_ARGS, nodes: 0}),
      ).rejects.toThrow('Too small');
      expect(spannerFake.clientOptions).toEqual([]);
    });
  });

  describe('spanner_list_databases', () => {
    it('reports the id of every database', async () => {
      spannerFake.responses.databases = [
        {name: 'projects/test-project/instances/test-instance/databases/db-1'},
        {name: 'projects/test-project/instances/test-instance/databases/db-2'},
      ];

      const results = await resultsOf('spanner_list_databases', INSTANCE_ARGS);

      expect(results).toEqual(['db-1', 'db-2']);
      expect(spannerFake.pathArgsFor('databaseAdmin.instancePath')).toEqual([
        ['test-project', 'test-instance'],
      ]);
      expect(spannerFake.requestsFor('listDatabasesAsync')).toEqual([
        {parent: 'projects/test-project/instances/test-instance'},
      ]);
    });

    it('reports a rejected listing as an error', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      spannerFake.failures.listDatabases = new Error('test error');

      const result = await runTool(
        toolset(),
        'spanner_list_databases',
        INSTANCE_ARGS,
      );

      expect(errorOf(result)).toContain('test error');
    });
  });

  describe('spanner_create_database', () => {
    const CREATE_ARGS = {...INSTANCE_ARGS, database_id: 'db-1'};

    it('reports no results, unlike create_instance', async () => {
      const result = await runApproved('spanner_create_database', CREATE_ARGS);

      expect(result).toEqual({status: 'SUCCESS'});
      expect(spannerFake.requestsFor('createDatabase')).toEqual([
        {
          parent: 'projects/test-project/instances/test-instance',
          createStatement: 'CREATE DATABASE `db-1`',
        },
      ]);
      expect(spannerFake.requestsFor('operation.promise')).toHaveLength(1);
      expect(spannerFake.closedClients).toBe(1);
    });

    it('accepts the hyphen a Spanner database id may carry', async () => {
      const result = await runApproved('spanner_create_database', {
        ...CREATE_ARGS,
        database_id: 'my-catalog-db',
      });

      expect(result).toEqual({status: 'SUCCESS'});
      expect(spannerFake.requestsFor('createDatabase')[0]).toMatchObject({
        createStatement: 'CREATE DATABASE `my-catalog-db`',
      });
    });

    it.each([
      ['db`; DROP DATABASE `other', 'a backtick escaping the quoting'],
      ['My-DB', 'an upper-case letter'],
      ['1db', 'a leading digit'],
      ['db-', 'a trailing hyphen'],
      ['d', 'a single character'],
      ['a'.repeat(31), 'more than thirty characters'],
    ])('refuses %j, which carries %s', async (databaseId) => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});

      const result = await runApproved('spanner_create_database', {
        ...CREATE_ARGS,
        database_id: databaseId,
      });

      expect(errorOf(result)).toContain(
        'Invalid Spanner database id for database_id',
      );
      expect(spannerFake.clientOptions).toEqual([]);
      expect(spannerFake.requestsFor('createDatabase')).toEqual([]);
    });

    it('reports a rejected creation as an error', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      spannerFake.failures.createDatabase = new Error('test error');

      const result = await runApproved('spanner_create_database', CREATE_ARGS);

      expect(errorOf(result)).toContain('test error');
      expect(spannerFake.closedClients).toBe(1);
    });
  });

  describe('the confirmation gate on the two create tools', () => {
    const CREATE_ARGS = {
      ...INSTANCE_ARGS,
      config_id: 'config-1',
      display_name: 'Test Instance',
      database_id: 'db',
    };

    it.each(['spanner_create_instance', 'spanner_create_database'])(
      '%s asks before it provisions anything',
      async (name) => {
        const result = await runTool(toolset(), name, CREATE_ARGS);

        expect(result).toEqual({
          error:
            'This tool call requires confirmation, please approve or reject.',
        });
        expect(spannerFake.clientOptions).toEqual([]);
      },
    );

    it.each(['spanner_create_instance', 'spanner_create_database'])(
      '%s provisions nothing once the user rejects it',
      async (name) => {
        const result = await runTool(
          toolset(),
          name,
          CREATE_ARGS,
          confirmedToolContext(false),
        );

        expect(result).toEqual({error: 'This tool call is rejected.'});
        expect(spannerFake.clientOptions).toEqual([]);
      },
    );

    it.each([
      'spanner_list_instances',
      'spanner_get_instance',
      'spanner_list_databases',
      'spanner_list_instance_configs',
      'spanner_get_instance_config',
    ])('%s runs without asking', async (name) => {
      const result = await runTool(toolset(), name, {
        ...CREATE_ARGS,
        config_id: 'config-1',
      });

      expect(successOf(result)['status']).toBe('SUCCESS');
      expect(spannerFake.clientOptions).toHaveLength(1);
    });
  });

  describe('the shared client lifecycle', () => {
    it('sends the ADK attribution with the project', async () => {
      await resultsOf('spanner_list_instances', PROJECT_ARGS);

      expect(spannerFake.clientOptions).toEqual([
        expect.objectContaining({
          projectId: 'test-project',
          libName: 'adk-spanner-tool google-adk',
        }),
      ]);
    });

    it('keeps the result when closing the client fails', async () => {
      const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      spannerFake.failures.closeClient = new Error('close failed');
      spannerFake.responses.instances = [
        {name: 'projects/test-project/instances/only'},
      ];

      const results = await resultsOf('spanner_list_instances', PROJECT_ARGS);

      expect(results).toEqual(['only']);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('Failed to close the Spanner client'),
      );
    });

    it('opens one client per call and closes it again', async () => {
      await resultsOf('spanner_list_instances', PROJECT_ARGS);
      await resultsOf('spanner_list_databases', INSTANCE_ARGS);

      expect(spannerFake.clientOptions).toHaveLength(2);
      expect(spannerFake.closedClients).toBe(2);
    });

    it('reports a missing authorization without opening a client', async () => {
      vi.spyOn(logger, 'error').mockImplementation(() => {});
      const unauthorized = new SpannerAdminToolset({
        credentialsConfig: {clientId: 'id', clientSecret: 'secret'},
      });

      const result = await runTool(
        unauthorized,
        'spanner_list_instances',
        PROJECT_ARGS,
      );

      expect(errorOf(result)).toContain('User authorization is required');
      expect(spannerFake.clientOptions).toEqual([]);
    });
  });
});
