/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  SpannerAdminToolset,
  SpannerCredentialsConfig,
  version,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {CREATE_OPERATION_TIMEOUT_MS} from '../../../src/tools/spanner/admin_tool.js';
import {
  completedOperation,
  DatabaseAdminClientMock,
  fakeDatabaseAdmin,
  fakeInstanceAdmin,
  FUNCTION_CALL_ID,
  InstanceAdminClientMock,
  makeToolContext,
  resetSpannerFakes,
  testCredentialsConfig,
} from './spanner_test_utils.js';

vi.mock('@google-cloud/spanner-api', async () => {
  const {fakeSpannerModule} = await import('./spanner_test_utils.js');
  return fakeSpannerModule;
});

const PROJECT = 'my-project';

/** Runs one tool of a freshly built toolset and returns its result. */
async function runTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const toolset = new SpannerAdminToolset({
    credentialsConfig: testCredentialsConfig(),
  });
  const tool = (await toolset.getTools()).find(
    (candidate: BaseTool) => candidate.name === name,
  );
  if (!tool) {
    expect.fail(`toolset does not expose ${name}`);
  }
  return tool.runAsync({args, toolContext: makeToolContext()});
}

describe('Spanner admin tools', () => {
  beforeEach(() => {
    resetSpannerFakes();
  });

  describe('spanner_list_instances', () => {
    it('reduces full resource names to instance ids', async () => {
      fakeInstanceAdmin.listInstances.mockResolvedValue([
        [
          {name: `projects/${PROJECT}/instances/first`},
          // A name with more segments than the usual three, so that an
          // index-based split would pick the wrong segment.
          {name: `projects/${PROJECT}/locations/eu/instances/second`},
        ],
      ]);

      const result = await runTool('spanner_list_instances', {
        project_id: PROJECT,
      });

      expect(fakeInstanceAdmin.listInstances).toHaveBeenCalledWith({
        parent: `projects/${PROJECT}`,
      });
      expect(result).toEqual({status: 'SUCCESS', results: ['first', 'second']});
    });

    it('returns an empty list when the project has no instances', async () => {
      fakeInstanceAdmin.listInstances.mockResolvedValue([[]]);

      expect(
        await runTool('spanner_list_instances', {project_id: PROJECT}),
      ).toEqual({status: 'SUCCESS', results: []});
    });

    it('reports an instance the API left unnamed as an empty id', async () => {
      // Every field of a generated proto is optional, so `name` can be absent
      // even though the API always sets it.
      fakeInstanceAdmin.listInstances.mockResolvedValue([[{}]]);

      expect(
        await runTool('spanner_list_instances', {project_id: PROJECT}),
      ).toEqual({status: 'SUCCESS', results: ['']});
    });

    it('reports a rejected call as an error result', async () => {
      fakeInstanceAdmin.listInstances.mockRejectedValue(
        new Error('permission denied'),
      );

      expect(
        await runTool('spanner_list_instances', {project_id: PROJECT}),
      ).toEqual({status: 'ERROR', error_details: 'permission denied'});
    });

    it('reports a non-Error rejection as a string', async () => {
      fakeInstanceAdmin.listInstances.mockRejectedValue('channel closed');

      expect(
        await runTool('spanner_list_instances', {project_id: PROJECT}),
      ).toEqual({status: 'ERROR', error_details: 'channel closed'});
    });
  });

  describe('spanner_get_instance', () => {
    it('reports every instance detail', async () => {
      fakeInstanceAdmin.getInstance.mockResolvedValue([
        {
          name: `projects/${PROJECT}/instances/my-instance`,
          displayName: 'My Instance',
          config: `projects/${PROJECT}/instanceConfigs/regional-us-central1`,
          nodeCount: 2,
          processingUnits: 2000,
          labels: {env: 'prod'},
        },
      ]);

      const result = await runTool('spanner_get_instance', {
        project_id: PROJECT,
        instance_id: 'my-instance',
      });

      expect(fakeInstanceAdmin.getInstance).toHaveBeenCalledWith({
        name: `projects/${PROJECT}/instances/my-instance`,
      });
      expect(result).toEqual({
        status: 'SUCCESS',
        results: {
          instance_id: 'my-instance',
          display_name: 'My Instance',
          config: `projects/${PROJECT}/instanceConfigs/regional-us-central1`,
          node_count: 2,
          processing_units: 2000,
          labels: {env: 'prod'},
        },
      });
    });

    it('reports absent labels as an empty object', async () => {
      fakeInstanceAdmin.getInstance.mockResolvedValue([
        {
          name: `projects/${PROJECT}/instances/my-instance`,
          displayName: 'My Instance',
          config: 'regional-us-central1',
          nodeCount: 1,
          processingUnits: 1000,
          labels: null,
        },
      ]);

      const result = await runTool('spanner_get_instance', {
        project_id: PROJECT,
        instance_id: 'my-instance',
      });

      expect(result).toMatchObject({results: {labels: {}}});
    });

    it('reports absent node and processing counts as zero', async () => {
      fakeInstanceAdmin.getInstance.mockResolvedValue([
        {
          name: `projects/${PROJECT}/instances/my-instance`,
          displayName: 'My Instance',
          config: 'regional-us-central1',
          nodeCount: null,
          processingUnits: null,
          labels: {},
        },
      ]);

      const result = await runTool('spanner_get_instance', {
        project_id: PROJECT,
        instance_id: 'my-instance',
      });

      expect(result).toMatchObject({
        results: {node_count: 0, processing_units: 0},
      });
    });

    it('reports a rejected call as an error result', async () => {
      fakeInstanceAdmin.getInstance.mockRejectedValue(new Error('not found'));

      expect(
        await runTool('spanner_get_instance', {
          project_id: PROJECT,
          instance_id: 'missing',
        }),
      ).toEqual({status: 'ERROR', error_details: 'not found'});
    });
  });

  describe('spanner_list_instance_configs', () => {
    it('reduces full resource names to config ids', async () => {
      fakeInstanceAdmin.listInstanceConfigs.mockResolvedValue([
        [
          {name: `projects/${PROJECT}/instanceConfigs/regional-us-central1`},
          {name: `projects/${PROJECT}/locations/eu/instanceConfigs/nam3`},
        ],
      ]);

      const result = await runTool('spanner_list_instance_configs', {
        project_id: PROJECT,
      });

      expect(fakeInstanceAdmin.listInstanceConfigs).toHaveBeenCalledWith({
        parent: `projects/${PROJECT}`,
      });
      expect(result).toEqual({
        status: 'SUCCESS',
        results: ['regional-us-central1', 'nam3'],
      });
    });

    it('returns an empty list when the project has no configs', async () => {
      fakeInstanceAdmin.listInstanceConfigs.mockResolvedValue([[]]);

      expect(
        await runTool('spanner_list_instance_configs', {project_id: PROJECT}),
      ).toEqual({status: 'SUCCESS', results: []});
    });

    it('reports a rejected call as an error result', async () => {
      fakeInstanceAdmin.listInstanceConfigs.mockRejectedValue(
        new Error('quota exceeded'),
      );

      expect(
        await runTool('spanner_list_instance_configs', {project_id: PROJECT}),
      ).toEqual({status: 'ERROR', error_details: 'quota exceeded'});
    });
  });

  describe('spanner_get_instance_config', () => {
    it.each([
      {label: 'a numeric replica type', type: 1},
      {label: 'a named replica type', type: 'READ_WRITE'},
    ])('reports $label as the enum name', async ({type}) => {
      fakeInstanceAdmin.getInstanceConfig.mockResolvedValue([
        {
          name: `projects/${PROJECT}/instanceConfigs/regional-us-central1`,
          displayName: 'us-central1',
          replicas: [
            {location: 'us-central1', type, defaultLeaderLocation: true},
          ],
          labels: {},
        },
      ]);

      const result = await runTool('spanner_get_instance_config', {
        project_id: PROJECT,
        config_id: 'regional-us-central1',
      });

      expect(fakeInstanceAdmin.getInstanceConfig).toHaveBeenCalledWith({
        name: `projects/${PROJECT}/instanceConfigs/regional-us-central1`,
      });
      expect(result).toEqual({
        status: 'SUCCESS',
        results: {
          name: `projects/${PROJECT}/instanceConfigs/regional-us-central1`,
          display_name: 'us-central1',
          replicas: [
            {
              location: 'us-central1',
              type: 'READ_WRITE',
              default_leader_location: true,
            },
          ],
          labels: {},
        },
      });
    });

    it('reports an unset replica type as TYPE_UNSPECIFIED', async () => {
      fakeInstanceAdmin.getInstanceConfig.mockResolvedValue([
        {
          name: 'nam3',
          displayName: 'nam3',
          replicas: [{location: 'us-east4', defaultLeaderLocation: false}],
          labels: null,
        },
      ]);

      const result = await runTool('spanner_get_instance_config', {
        project_id: PROJECT,
        config_id: 'nam3',
      });

      expect(result).toMatchObject({
        results: {
          replicas: [{type: 'TYPE_UNSPECIFIED'}],
          labels: {},
        },
      });
    });

    it('reports a replica type the enum does not know as an error', async () => {
      fakeInstanceAdmin.getInstanceConfig.mockResolvedValue([
        {
          name: 'nam3',
          displayName: 'nam3',
          replicas: [{location: 'us-east4', type: 99}],
          labels: {},
        },
      ]);

      expect(
        await runTool('spanner_get_instance_config', {
          project_id: PROJECT,
          config_id: 'nam3',
        }),
      ).toEqual({
        status: 'ERROR',
        error_details: 'Unknown Spanner replica type: 99.',
      });
    });

    it('reports a config without replicas as an empty list', async () => {
      fakeInstanceAdmin.getInstanceConfig.mockResolvedValue([
        {name: 'nam3', displayName: 'nam3', labels: {}},
      ]);

      expect(
        await runTool('spanner_get_instance_config', {
          project_id: PROJECT,
          config_id: 'nam3',
        }),
      ).toMatchObject({results: {replicas: []}});
    });

    it('reports a rejected call as an error result', async () => {
      fakeInstanceAdmin.getInstanceConfig.mockRejectedValue(
        new Error('no such config'),
      );

      expect(
        await runTool('spanner_get_instance_config', {
          project_id: PROJECT,
          config_id: 'nope',
        }),
      ).toEqual({status: 'ERROR', error_details: 'no such config'});
    });
  });

  describe('spanner_create_instance', () => {
    it('creates the instance and waits for the operation', async () => {
      const operation = completedOperation();
      fakeInstanceAdmin.createInstance.mockResolvedValue([operation]);

      const result = await runTool('spanner_create_instance', {
        project_id: PROJECT,
        instance_id: 'new-instance',
        config_id: 'regional-us-central1',
        display_name: 'New Instance',
        nodes: 3,
      });

      expect(fakeInstanceAdmin.createInstance).toHaveBeenCalledWith(
        {
          parent: `projects/${PROJECT}`,
          instanceId: 'new-instance',
          instance: {
            displayName: 'New Instance',
            config: `projects/${PROJECT}/instanceConfigs/regional-us-central1`,
            nodeCount: 3,
          },
        },
        expect.objectContaining({
          longrunning: expect.objectContaining({
            totalTimeoutMillis: CREATE_OPERATION_TIMEOUT_MS,
          }),
        }),
      );
      expect(operation.promise).toHaveBeenCalled();
      expect(result).toEqual({
        status: 'SUCCESS',
        results: 'Instance new-instance created successfully.',
      });
    });

    it('defaults to one node when the model omits nodes', async () => {
      fakeInstanceAdmin.createInstance.mockResolvedValue([
        completedOperation(),
      ]);

      await runTool('spanner_create_instance', {
        project_id: PROJECT,
        instance_id: 'new-instance',
        config_id: 'regional-us-central1',
        display_name: 'New Instance',
      });

      expect(fakeInstanceAdmin.createInstance).toHaveBeenCalledWith(
        expect.objectContaining({
          instance: expect.objectContaining({nodeCount: 1}),
        }),
        expect.anything(),
      );
    });

    it('reports a failed operation as an error result', async () => {
      fakeInstanceAdmin.createInstance.mockResolvedValue([
        {promise: vi.fn().mockRejectedValue(new Error('instance exists'))},
      ]);

      expect(
        await runTool('spanner_create_instance', {
          project_id: PROJECT,
          instance_id: 'new-instance',
          config_id: 'regional-us-central1',
          display_name: 'New Instance',
        }),
      ).toEqual({status: 'ERROR', error_details: 'instance exists'});
    });
  });

  describe('spanner_list_databases', () => {
    it('reduces full resource names to database ids', async () => {
      fakeDatabaseAdmin.listDatabases.mockResolvedValue([
        [
          {name: `projects/${PROJECT}/instances/my-instance/databases/first`},
          {
            name: `projects/${PROJECT}/instances/my-instance/backups/b/databases/second`,
          },
        ],
      ]);

      const result = await runTool('spanner_list_databases', {
        project_id: PROJECT,
        instance_id: 'my-instance',
      });

      expect(fakeDatabaseAdmin.listDatabases).toHaveBeenCalledWith({
        parent: `projects/${PROJECT}/instances/my-instance`,
      });
      expect(result).toEqual({status: 'SUCCESS', results: ['first', 'second']});
    });

    it('returns an empty list when the instance has no databases', async () => {
      fakeDatabaseAdmin.listDatabases.mockResolvedValue([[]]);

      expect(
        await runTool('spanner_list_databases', {
          project_id: PROJECT,
          instance_id: 'my-instance',
        }),
      ).toEqual({status: 'SUCCESS', results: []});
    });

    it('reports a rejected call as an error result', async () => {
      fakeDatabaseAdmin.listDatabases.mockRejectedValue(
        new Error('instance not found'),
      );

      expect(
        await runTool('spanner_list_databases', {
          project_id: PROJECT,
          instance_id: 'my-instance',
        }),
      ).toEqual({status: 'ERROR', error_details: 'instance not found'});
    });
  });

  describe('spanner_create_database', () => {
    it('quotes the database id and waits for the operation', async () => {
      const operation = completedOperation();
      fakeDatabaseAdmin.createDatabase.mockResolvedValue([operation]);

      const result = await runTool('spanner_create_database', {
        project_id: PROJECT,
        instance_id: 'my-instance',
        database_id: 'my-database',
      });

      expect(fakeDatabaseAdmin.createDatabase).toHaveBeenCalledWith(
        {
          parent: `projects/${PROJECT}/instances/my-instance`,
          createStatement: 'CREATE DATABASE `my-database`',
        },
        expect.objectContaining({
          longrunning: expect.objectContaining({
            totalTimeoutMillis: CREATE_OPERATION_TIMEOUT_MS,
          }),
        }),
      );
      expect(operation.promise).toHaveBeenCalled();
      // adk-python returns the status alone here, with no `results` key.
      expect(result).toEqual({status: 'SUCCESS'});
    });

    it('rejects a database id that would break out of the backticks', async () => {
      const result = await runTool('spanner_create_database', {
        project_id: PROJECT,
        instance_id: 'my-instance',
        database_id: 'ok` OPTIONS (version_retention_period = `1h',
      });

      expect(result).toEqual({
        status: 'ERROR',
        error_details:
          'Invalid database id "ok` OPTIONS (version_retention_period = `1h": ' +
          'it cannot contain a backtick.',
      });
      expect(fakeDatabaseAdmin.createDatabase).not.toHaveBeenCalled();
    });

    it('reports a failed operation as an error result', async () => {
      fakeDatabaseAdmin.createDatabase.mockResolvedValue([
        {promise: vi.fn().mockRejectedValue(new Error('database exists'))},
      ]);

      expect(
        await runTool('spanner_create_database', {
          project_id: PROJECT,
          instance_id: 'my-instance',
          database_id: 'my-database',
        }),
      ).toEqual({status: 'ERROR', error_details: 'database exists'});
    });
  });
  describe('admin client lifecycle', () => {
    it('closes both clients after a call succeeds', async () => {
      fakeInstanceAdmin.listInstances.mockResolvedValue([[]]);

      await runTool('spanner_list_instances', {project_id: PROJECT});

      expect(fakeInstanceAdmin.close).toHaveBeenCalledTimes(1);
      expect(fakeDatabaseAdmin.close).toHaveBeenCalledTimes(1);
    });

    it('closes both clients after a call is rejected', async () => {
      fakeInstanceAdmin.listInstances.mockRejectedValue(new Error('nope'));

      await runTool('spanner_list_instances', {project_id: PROJECT});

      expect(fakeInstanceAdmin.close).toHaveBeenCalledTimes(1);
      expect(fakeDatabaseAdmin.close).toHaveBeenCalledTimes(1);
    });

    it('builds fresh clients for every call', async () => {
      fakeInstanceAdmin.listInstances.mockResolvedValue([[]]);

      await runTool('spanner_list_instances', {project_id: PROJECT});
      await runTool('spanner_list_instances', {project_id: PROJECT});

      expect(InstanceAdminClientMock).toHaveBeenCalledTimes(2);
      expect(DatabaseAdminClientMock).toHaveBeenCalledTimes(2);
    });

    it('sends the ADK attribution to the Admin API', async () => {
      fakeInstanceAdmin.listInstances.mockResolvedValue([[]]);

      await runTool('spanner_list_instances', {project_id: PROJECT});

      expect(InstanceAdminClientMock).toHaveBeenCalledWith(
        expect.objectContaining({
          libName: 'adk-spanner-tool google-adk',
          libVersion: version,
        }),
      );
    });
  });

  describe('credential resolution', () => {
    async function runWith(
      credentialsConfig: SpannerCredentialsConfig,
      toolContext: Context,
    ): Promise<unknown> {
      const [listInstances] = await new SpannerAdminToolset({
        credentialsConfig,
        toolFilter: ['spanner_list_instances'],
      }).getTools();
      return listInstances.runAsync({args: {project_id: PROJECT}, toolContext});
    }

    it('asks the user to authorize before the OAuth flow completes', async () => {
      const context = makeToolContext();

      const result = await runWith(
        {clientId: 'client-id', clientSecret: 'client-secret'},
        context,
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details:
          'User authorization is required to access Google services for' +
          ' spanner_list_instances. Please complete the authorization flow.',
      });
      expect(
        context.actions.requestedAuthConfigs[FUNCTION_CALL_ID],
      ).toBeDefined();
      expect(InstanceAdminClientMock).not.toHaveBeenCalled();
    });

    it('reports a missing external access token as an error result', async () => {
      const result = await runWith(
        {externalAccessTokenKey: 'spanner_token'},
        makeToolContext(),
      );

      expect(result).toEqual({
        status: 'ERROR',
        error_details:
          'external_access_token_key is provided but no access token found in' +
          ' tool_context.state with key spanner_token.',
      });
      expect(InstanceAdminClientMock).not.toHaveBeenCalled();
    });

    it('calls the API with the external access token', async () => {
      fakeInstanceAdmin.listInstances.mockResolvedValue([[]]);
      const context = makeToolContext();
      context.state.set('spanner_token', 'test-token');

      const result = await runWith(
        {externalAccessTokenKey: 'spanner_token'},
        context,
      );

      expect(result).toEqual({status: 'SUCCESS', results: []});
      const authClient = InstanceAdminClientMock.mock.calls[0][0].authClient;
      expect(authClient.credentials.access_token).toBe('test-token');
    });
  });
});
