/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {DevServer, resolveAgentDir} from '../../src/server/dev_server.js';
import {
  makeAgentsDir,
  STUB_AGENT_LOADER,
  stubHomeDir,
  TEST_APP_NAME,
  TEST_BROKEN_APP_NAME,
  TEST_WRAPPED_APP_NAME,
  TestHttpClient,
  testsDirOf,
  writeTestFile,
} from './dev_server_test_utils.js';

/** Runs `call`, and reports the HTTP status and message it threw. */
function captureError(call: () => void): {status: unknown; message: string} {
  try {
    call();
  } catch (error: unknown) {
    if (typeof error !== 'object' || error === null) {
      return {status: undefined, message: String(error)};
    }

    return {
      status: 'status' in error ? error.status : undefined,
      message: 'message' in error ? String(error.message) : String(error),
    };
  }

  return expect.fail('expected the call to throw');
}

describe('resolveAgentDir', () => {
  it('answers 500 when no agents directory is configured', () => {
    expect(captureError(() => resolveAgentDir(undefined, 'app'))).toEqual({
      status: 500,
      message: 'Agents directory is not configured',
    });
  });

  it('answers 400 for an empty app name', () => {
    expect(captureError(() => resolveAgentDir('/agents', ''))).toEqual({
      status: 400,
      message: 'App name cannot be empty',
    });
  });

  it.each(['../escape', 'a..b', 'a.', '.b', '/etc/passwd', 'a-b'])(
    'answers 400 for the app name %j',
    (appName) => {
      const {status, message} = captureError(() =>
        resolveAgentDir('/agents', appName),
      );

      expect(status).toBe(400);
      expect(message).toBe(
        `Invalid app name: "${appName}". App names must be valid identifiers ` +
          `or paths separated by dots.`,
      );
    },
  );

  it('resolves a nested app name to a nested directory', () => {
    expect(resolveAgentDir('/agents', 'parent.child')).toBe(
      path.resolve('/agents', 'parent', 'child'),
    );
  });

  it('resolves a plain app name directly under the agents directory', () => {
    expect(resolveAgentDir('/agents', 'app')).toBe(
      path.resolve('/agents', 'app'),
    );
  });
});

describe('DevServer', () => {
  let agentsDir: string;
  let homeDir: string;
  let server: DevServer;
  let client: TestHttpClient;

  beforeEach(async () => {
    agentsDir = await makeAgentsDir();
    homeDir = await makeAgentsDir();
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

  describe('app name validation', () => {
    it('answers 400 and writes nothing for an app name that escapes', async () => {
      const response = await client.put('/dev/apps/a..b/tests/escape.json', {
        session_data: {},
      });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error:
          'Invalid app name: "a..b". App names must be valid identifiers or ' +
          'paths separated by dots.',
      });
      await expect(fs.readdir(agentsDir)).resolves.toEqual([]);
    });

    it('answers 500 when the server has no agents directory', async () => {
      const unconfigured = new DevServer({agentLoader: STUB_AGENT_LOADER});
      await unconfigured.start();

      const response = await new TestHttpClient(unconfigured.url).get(
        `/dev/apps/${TEST_APP_NAME}/tests`,
      );

      expect(response.status).toBe(500);
      expect(response.body).toEqual({
        error: 'Agents directory is not configured',
      });
      await unconfigured.stop();
    });
  });

  describe('GET /dev/apps/:appName/tests', () => {
    it('lists only the JSON files, sorted', async () => {
      await writeTestFile(agentsDir, TEST_APP_NAME, 'b.json', '{}');
      await writeTestFile(agentsDir, TEST_APP_NAME, 'a.json', '{}');
      await writeTestFile(agentsDir, TEST_APP_NAME, 'notes.txt', 'ignored');

      const response = await client.get(`/dev/apps/${TEST_APP_NAME}/tests`);

      expect(response.body).toEqual(['a.json', 'b.json']);
    });

    it('answers 500 when the tests path cannot be read', async () => {
      // A file where the tests directory belongs makes readdir fail with
      // ENOTDIR, which is not the "no such directory" case that answers [].
      await fs.mkdir(path.join(agentsDir, TEST_APP_NAME));
      await fs.writeFile(testsDirOf(agentsDir, TEST_APP_NAME), '', 'utf-8');

      const response = await client.get(`/dev/apps/${TEST_APP_NAME}/tests`);

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('Failed to list tests'),
      });
    });
  });

  describe('PUT /dev/apps/:appName/tests/:testName', () => {
    it('writes sorted keys, two-space indent and a trailing newline', async () => {
      await client.put(`/dev/apps/${TEST_APP_NAME}/tests/exact.json`, {
        session_data: {
          b: 1,
          a: [{z: 1, y: 2}],
          'c': {'nested_b': 2, 'nested_a': 1},
        },
      });

      const written = await fs.readFile(
        path.join(testsDirOf(agentsDir, TEST_APP_NAME), 'exact.json'),
        'utf-8',
      );

      expect(written).toBe(
        [
          '{',
          '  "a": [',
          '    {',
          '      "y": 2,',
          '      "z": 1',
          '    }',
          '  ],',
          '  "b": 1,',
          '  "c": {',
          '    "nested_a": 1,',
          '    "nested_b": 2',
          '  }',
          '}',
          '',
        ].join('\n'),
      );
    });

    it('appends the .json suffix and reports the saved name', async () => {
      const response = await client.put(
        `/dev/apps/${TEST_APP_NAME}/tests/no_suffix`,
        {session_data: {}},
      );

      expect(response.body).toEqual({
        status: 'success',
        file: 'no_suffix.json',
      });
      await expect(
        fs.readdir(testsDirOf(agentsDir, TEST_APP_NAME)),
      ).resolves.toEqual(['no_suffix.json']);
    });

    it('keeps a traversing test name inside the tests directory', async () => {
      const response = await client.put(
        `/dev/apps/${TEST_APP_NAME}/tests/${encodeURIComponent('../../escape.json')}`,
        {session_data: {}},
      );

      expect(response.body).toEqual({status: 'success', file: 'escape.json'});
      await expect(
        fs.readdir(testsDirOf(agentsDir, TEST_APP_NAME)),
      ).resolves.toEqual(['escape.json']);
      await expect(fs.readdir(agentsDir)).resolves.toEqual([TEST_APP_NAME]);
      await expect(
        fs.readdir(path.join(agentsDir, TEST_APP_NAME)),
      ).resolves.toEqual(['tests']);
    });

    it('writes non-ASCII characters unescaped', async () => {
      await client.put(`/dev/apps/${TEST_APP_NAME}/tests/jp.json`, {
        session_data: {question: '日本語の質問'},
      });

      const written = await fs.readFile(
        path.join(testsDirOf(agentsDir, TEST_APP_NAME), 'jp.json'),
        'utf-8',
      );

      expect(written).toContain('日本語の質問');
      expect(written).not.toContain('\\u');
    });

    it('answers 400 when session_data is not an object', async () => {
      const response = await client.put(
        `/dev/apps/${TEST_APP_NAME}/tests/bad.json`,
        {session_data: 'not an object'},
      );

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'Field "session_data" must be an object',
      });
      await expect(fs.readdir(agentsDir)).resolves.toEqual([]);
    });

    it('answers 400 when the request body is not an object', async () => {
      const response = await client.put(
        `/dev/apps/${TEST_APP_NAME}/tests/bad.json`,
        ['session_data'],
      );

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'Field "session_data" must be an object',
      });
      await expect(fs.readdir(agentsDir)).resolves.toEqual([]);
    });
  });

  describe('GET /dev/apps/:appName/tests/:testName', () => {
    it('answers 500 when the stored file is not valid JSON', async () => {
      await writeTestFile(agentsDir, TEST_APP_NAME, 'broken.json', '{not json');

      const response = await client.get(
        `/dev/apps/${TEST_APP_NAME}/tests/broken.json`,
      );

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('Failed to get test content'),
      });
    });

    it('reads a test whose name omits the .json suffix', async () => {
      await writeTestFile(
        agentsDir,
        TEST_APP_NAME,
        'suffixed.json',
        '{"a": 1}',
      );

      const response = await client.get(
        `/dev/apps/${TEST_APP_NAME}/tests/suffixed`,
      );

      expect(response.body).toEqual({a: 1});
    });

    it('answers 500 when the test path cannot be read', async () => {
      // A directory in place of the file fails with EISDIR, which is not the
      // "no such file" case that answers 404.
      await fs.mkdir(
        path.join(testsDirOf(agentsDir, TEST_APP_NAME), 'dir.json'),
        {recursive: true},
      );

      const response = await client.get(
        `/dev/apps/${TEST_APP_NAME}/tests/dir.json`,
      );

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('Failed to get test content'),
      });
    });
  });

  describe('DELETE /dev/apps/:appName/tests/:testName', () => {
    it('deletes a test whose name omits the .json suffix', async () => {
      const filePath = await writeTestFile(
        agentsDir,
        TEST_APP_NAME,
        'gone.json',
        '{}',
      );

      const response = await client.delete(
        `/dev/apps/${TEST_APP_NAME}/tests/gone`,
      );

      expect(response.status).toBe(200);
      await expect(fs.access(filePath)).rejects.toThrow();
    });

    it('answers 404 for a test that does not exist', async () => {
      const response = await client.delete(
        `/dev/apps/${TEST_APP_NAME}/tests/missing.json`,
      );

      expect(response.status).toBe(404);
      expect(response.body).toEqual({error: 'Test file not found'});
    });

    it('answers 500 when the test path cannot be deleted', async () => {
      await fs.mkdir(
        path.join(testsDirOf(agentsDir, TEST_APP_NAME), 'dir.json'),
        {recursive: true},
      );

      const response = await client.delete(
        `/dev/apps/${TEST_APP_NAME}/tests/dir.json`,
      );

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('Failed to delete test'),
      });
    });
  });

  describe('GET /dev/apps/:appName/graph', () => {
    it('returns the agent graph on a light background by default', async () => {
      const response = await client.get(`/dev/apps/${TEST_APP_NAME}/graph`);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        dotSrc: expect.stringContaining(TEST_APP_NAME),
      });
      expect(response.body).toMatchObject({
        dotSrc: expect.stringContaining('#ffffff'),
      });
    });

    it('returns a dark background when dark_mode is true', async () => {
      const response = await client.get(
        `/dev/apps/${TEST_APP_NAME}/graph?dark_mode=true`,
      );

      expect(response.body).toMatchObject({
        dotSrc: expect.stringContaining('#333537'),
      });
    });

    it('draws the root agent of an App-wrapped app', async () => {
      const response = await client.get(
        `/dev/apps/${TEST_WRAPPED_APP_NAME}/graph`,
      );

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        dotSrc: expect.stringContaining(`digraph "${TEST_WRAPPED_APP_NAME}"`),
      });
    });

    it('answers 404 for an app the loader does not list', async () => {
      const response = await client.get('/dev/apps/unknown_app/graph');

      expect(response.status).toBe(404);
      expect(response.body).toEqual({error: 'App not found: unknown_app'});
    });

    it('answers 500 for a listed app that fails to load', async () => {
      const response = await client.get(
        `/dev/apps/${TEST_BROKEN_APP_NAME}/graph`,
      );

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('Failed to get app graph'),
      });
    });
  });

  describe('/config/telemetry', () => {
    it('reports null when no consent is recorded', async () => {
      const response = await client.get('/config/telemetry');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({telemetry: null});
    });

    it.each([
      ['a non-object config', '[1, 2]'],
      ['a non-boolean value', '{"telemetry": "yes"}'],
      ['a config that is not JSON', '{not json'],
    ])('reports null for %s', async (_name, contents) => {
      await fs.mkdir(path.join(homeDir, '.adk'));
      await fs.writeFile(
        path.join(homeDir, '.adk', 'config.json'),
        contents,
        'utf-8',
      );

      const response = await client.get('/config/telemetry');

      expect(response.body).toEqual({telemetry: null});
    });

    it('keeps the other config keys when recording consent', async () => {
      await fs.mkdir(path.join(homeDir, '.adk'));
      await fs.writeFile(
        path.join(homeDir, '.adk', 'config.json'),
        '{"other": "kept"}',
        'utf-8',
      );

      const response = await client.post(
        '/config/telemetry',
        {telemetry: false},
        {'x-adk-telemetry-request': 'true'},
      );

      expect(response.body).toEqual({telemetry: false});
      await expect(
        fs.readFile(path.join(homeDir, '.adk', 'config.json'), 'utf-8'),
      ).resolves.toBe('{\n  "other": "kept",\n  "telemetry": false\n}\n');
    });

    it('replaces a config file that cannot be parsed', async () => {
      await fs.mkdir(path.join(homeDir, '.adk'));
      await fs.writeFile(
        path.join(homeDir, '.adk', 'config.json'),
        '{not json',
        'utf-8',
      );

      const response = await client.post(
        '/config/telemetry',
        {telemetry: true},
        {'x-adk-telemetry-request': 'true'},
      );

      expect(response.body).toEqual({telemetry: true});
      await expect(
        fs.readFile(path.join(homeDir, '.adk', 'config.json'), 'utf-8'),
      ).resolves.toBe('{\n  "telemetry": true\n}\n');
    });

    it('answers 400 when the header is present but not "true"', async () => {
      const response = await client.post(
        '/config/telemetry',
        {telemetry: true},
        {'x-adk-telemetry-request': 'yes'},
      );

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'Forbidden: missing required security header',
      });
    });

    it('answers 400 when the telemetry field is not a boolean', async () => {
      const response = await client.post(
        '/config/telemetry',
        {telemetry: 'yes'},
        {'x-adk-telemetry-request': 'true'},
      );

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'Field "telemetry" must be a boolean',
      });
    });

    it('answers 500 when the config file cannot be written', async () => {
      // A file where the `.adk` directory belongs makes mkdirSync fail.
      await fs.writeFile(path.join(homeDir, '.adk'), '', 'utf-8');

      const response = await client.post(
        '/config/telemetry',
        {telemetry: true},
        {'x-adk-telemetry-request': 'true'},
      );

      expect(response.status).toBe(500);
      expect(response.body).toMatchObject({
        error: expect.stringContaining('Failed to set telemetry consent'),
      });
    });
  });
});
