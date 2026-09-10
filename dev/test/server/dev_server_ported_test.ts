/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests ported from adk-python, keeping the Python test names verbatim.
 *
 * Sources, at `adk-python@main`:
 * - `tests/unittests/cli/test_adk_web_server_tests.py`
 * - `tests/unittests/cli/test_fast_api.py`
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {DevServer} from '../../src/server/dev_server.js';
import {
  makeAgentsDir,
  STUB_AGENT_LOADER,
  stubHomeDir,
  TEST_APP_NAME,
  TestHttpClient,
  testsDirOf,
  writeTestFile,
} from './dev_server_test_utils.js';

describe('DevServer (ported from adk-python)', () => {
  let agentsDir: string;
  let homeDir: string;
  let server: DevServer;
  let client: TestHttpClient;

  beforeEach(async () => {
    agentsDir = await makeAgentsDir();
    homeDir = await makeAgentsDir();
    // The consent record lives at `~/.adk/config.json`, so the whole read and
    // write path runs unmocked against a temporary home directory.
    stubHomeDir(homeDir);

    server = new DevServer({agentsDir, agentLoader: STUB_AGENT_LOADER});
    await server.start();
    client = new TestHttpClient(server.url);
  });

  afterEach(async () => {
    await server.stop();
    vi.unstubAllEnvs();
    await fs.rm(agentsDir, {recursive: true, force: true});
    await fs.rm(homeDir, {recursive: true, force: true});
  });

  it('test_list_tests_empty', async () => {
    const response = await client.get(`/dev/apps/${TEST_APP_NAME}/tests`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual([]);
  });

  it('test_create_test', async () => {
    await fs.mkdir(path.join(agentsDir, TEST_APP_NAME));

    const response = await client.put(
      `/dev/apps/${TEST_APP_NAME}/tests/my_test.json`,
      {session_data: {events: []}},
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({status: 'success', file: 'my_test.json'});
    await expect(
      fs.readFile(
        path.join(testsDirOf(agentsDir, TEST_APP_NAME), 'my_test.json'),
        'utf-8',
      ),
    ).resolves.toBe('{\n  "events": []\n}\n');
  });

  it('test_list_tests_not_empty', async () => {
    await writeTestFile(agentsDir, TEST_APP_NAME, 'test1.json', '{}');
    await writeTestFile(agentsDir, TEST_APP_NAME, 'test2.json', '{}');

    const response = await client.get(`/dev/apps/${TEST_APP_NAME}/tests`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual(['test1.json', 'test2.json']);
  });

  it('test_delete_test', async () => {
    const filePath = await writeTestFile(
      agentsDir,
      TEST_APP_NAME,
      'test1.json',
      '{}',
    );

    const response = await client.delete(
      `/dev/apps/${TEST_APP_NAME}/tests/test1.json`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({status: 'success'});
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it('test_get_test_content', async () => {
    await writeTestFile(
      agentsDir,
      TEST_APP_NAME,
      'test_get.json',
      '{"foo": "bar"}',
    );

    const response = await client.get(
      `/dev/apps/${TEST_APP_NAME}/tests/test_get.json`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({foo: 'bar'});
  });

  it('test_get_test_content_not_found', async () => {
    const response = await client.get(
      `/dev/apps/${TEST_APP_NAME}/tests/non_existent.json`,
    );

    expect(response.status).toBe(404);
    expect(response.body).toEqual({error: 'Test file not found'});
  });

  it('test_telemetry_get_endpoint', async () => {
    await fs.mkdir(path.join(homeDir, '.adk'));
    await fs.writeFile(
      path.join(homeDir, '.adk', 'config.json'),
      '{"telemetry": true}',
      'utf-8',
    );

    const response = await client.get('/config/telemetry');

    expect(response.status).toBe(200);
    expect(response.body).toEqual({telemetry: true});
  });

  it('test_telemetry_post_endpoint_success', async () => {
    const response = await client.post(
      '/config/telemetry',
      {telemetry: true},
      {'x-adk-telemetry-request': 'true'},
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual({telemetry: true});
    await expect(
      fs.readFile(path.join(homeDir, '.adk', 'config.json'), 'utf-8'),
    ).resolves.toBe('{\n  "telemetry": true\n}\n');
  });

  it('test_telemetry_post_endpoint_missing_header', async () => {
    const response = await client.post('/config/telemetry', {telemetry: true});

    expect(response.status).toBe(400);
    expect(response.text).toContain(
      'Forbidden: missing required security header',
    );
  });
});

/**
 * Ported with an adjusted path list. adk-python asserts 404 on the API server
 * for `/dev/apps/{app}/debug/trace/...` too, but adk-js registers that route
 * and `/dev/apps/{app}/build_graph` on `AdkApiServer`, and has done so since
 * before this change. Removing them would take capability away from
 * `adk api_server`, so the test asserts what adk-js does: only the routes this
 * change introduces are dev-only.
 */
describe('test_dev_only_endpoints_absent_when_web_disabled', () => {
  const DEV_ONLY_PATHS = [
    '/config/telemetry',
    `/dev/apps/${TEST_APP_NAME}/tests`,
    `/dev/apps/${TEST_APP_NAME}/graph`,
  ];
  let agentsDir: string;
  let apiServer: AdkApiServer;
  let devServer: DevServer;
  let apiClient: TestHttpClient;
  let devClient: TestHttpClient;

  beforeEach(async () => {
    agentsDir = await makeAgentsDir();
    apiServer = new AdkApiServer({agentsDir, agentLoader: STUB_AGENT_LOADER});
    devServer = new DevServer({agentsDir, agentLoader: STUB_AGENT_LOADER});
    await apiServer.start();
    await devServer.start();
    apiClient = new TestHttpClient(apiServer.url);
    devClient = new TestHttpClient(devServer.url);
  });

  afterEach(async () => {
    await apiServer.stop();
    await devServer.stop();
    await fs.rm(agentsDir, {recursive: true, force: true});
  });

  it('serves no dev-only route from the API server', async () => {
    for (const devOnlyPath of DEV_ONLY_PATHS) {
      const response = await apiClient.get(devOnlyPath);
      expect(response.status, devOnlyPath).toBe(404);
    }
  });

  it('serves every dev-only route from the dev server', async () => {
    for (const devOnlyPath of DEV_ONLY_PATHS) {
      const response = await devClient.get(devOnlyPath);
      expect(response.status, devOnlyPath).toBe(200);
    }
  });

  it('keeps the production endpoints on the API server', async () => {
    expect((await apiClient.get('/health')).status).toBe(200);
    expect((await apiClient.get('/list-apps')).status).toBe(200);
  });

  it('serves the trace and build_graph routes from both servers', async () => {
    const tracePath = `/dev/apps/${TEST_APP_NAME}/debug/trace/some-event`;
    const graphPath = `/dev/apps/${TEST_APP_NAME}/build_graph`;

    for (const client of [apiClient, devClient]) {
      // The route is registered and answers its own "no such trace" body,
      // rather than the framework's response for an unregistered path.
      expect((await client.get(tracePath)).body).toEqual({
        error: 'Trace not found',
      });
      expect((await client.get(graphPath)).status).toBe(200);
    }
  });
});
