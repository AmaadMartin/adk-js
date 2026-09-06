/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionInput,
  CodeExecutionLanguage,
  CodeInterpreterExecuteParams,
  CodeInterpreterExecuteResponse,
  CodeInterpreterExtensionClient,
  createSession,
  ExecuteCodeParams,
  File,
  InvocationContext,
  PluginManager,
  VertexAiCodeExecutor,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const RESOURCE_NAME =
  'projects/test-project/locations/europe-west4/extensions/456';
const CREATED_RESOURCE_NAME =
  'projects/test-project/locations/us-central1/extensions/789';

/**
 * Records every call so a test can assert on the request the executor built,
 * without reaching into the executor's private state.
 */
class FakeExtensionClient implements CodeInterpreterExtensionClient {
  readonly importCalls: Array<{projectId: string; location: string}> = [];
  readonly executeCalls: Array<{
    resourceName: string;
    params: CodeInterpreterExecuteParams;
  }> = [];
  response: CodeInterpreterExecuteResponse = {};
  executeError?: Error;
  importDelayMs = 0;

  async importFromHub(projectId: string, location: string): Promise<string> {
    this.importCalls.push({projectId, location});
    if (this.importDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.importDelayMs));
    }
    return CREATED_RESOURCE_NAME;
  }

  async execute(
    resourceName: string,
    params: CodeInterpreterExecuteParams,
  ): Promise<CodeInterpreterExecuteResponse> {
    this.executeCalls.push({resourceName, params});
    if (this.executeError) {
      throw this.executeError;
    }
    return this.response;
  }
}

function buildInput(
  overrides: Partial<CodeExecutionInput> = {},
): CodeExecutionInput {
  return {
    code: 'print("hello")',
    language: CodeExecutionLanguage.PYTHON,
    inputFiles: [],
    ...overrides,
  };
}

function buildParams(input: CodeExecutionInput): ExecuteCodeParams {
  return {
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    }),
    codeExecutionInput: input,
  };
}

describe('VertexAiCodeExecutor', () => {
  let client: FakeExtensionClient;

  beforeEach(() => {
    client = new FakeExtensionClient();
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', undefined);
    vi.stubEnv('CODE_INTERPRETER_EXTENSION_NAME', undefined);
  });

  describe('extension resolution', () => {
    it('uses the resource name from the options', async () => {
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      await executor.executeCode(buildParams(buildInput()));

      expect(client.importCalls).toEqual([]);
      expect(client.executeCalls[0].resourceName).toBe(RESOURCE_NAME);
    });

    it('falls back to CODE_INTERPRETER_EXTENSION_NAME', async () => {
      vi.stubEnv('CODE_INTERPRETER_EXTENSION_NAME', RESOURCE_NAME);
      const executor = new VertexAiCodeExecutor({client});

      await executor.executeCode(buildParams(buildInput()));

      expect(client.importCalls).toEqual([]);
      expect(client.executeCalls[0].resourceName).toBe(RESOURCE_NAME);
    });

    it('prefers the option over CODE_INTERPRETER_EXTENSION_NAME', async () => {
      vi.stubEnv(
        'CODE_INTERPRETER_EXTENSION_NAME',
        'projects/other/locations/us-west1/extensions/1',
      );
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      await executor.executeCode(buildParams(buildInput()));

      expect(client.executeCalls[0].resourceName).toBe(RESOURCE_NAME);
    });

    it('creates an extension and runs on it when none is configured', async () => {
      const executor = new VertexAiCodeExecutor({client});

      await executor.executeCode(buildParams(buildInput()));

      expect(client.importCalls).toEqual([
        {projectId: 'test-project', location: 'us-central1'},
      ]);
      expect(client.executeCalls[0].resourceName).toBe(CREATED_RESOURCE_NAME);
    });

    it('publishes a created extension in CODE_INTERPRETER_EXTENSION_NAME', async () => {
      const executor = new VertexAiCodeExecutor({client});

      await executor.executeCode(buildParams(buildInput()));

      expect(process.env.CODE_INTERPRETER_EXTENSION_NAME).toBe(
        CREATED_RESOURCE_NAME,
      );
    });

    it('exposes a created extension as resourceName', async () => {
      const executor = new VertexAiCodeExecutor({client});

      await executor.executeCode(buildParams(buildInput()));

      expect(executor.resourceName).toBe(CREATED_RESOURCE_NAME);
    });

    it('creates one extension across sequential executions', async () => {
      const executor = new VertexAiCodeExecutor({client});

      await executor.executeCode(buildParams(buildInput()));
      await executor.executeCode(buildParams(buildInput()));

      expect(client.importCalls).toHaveLength(1);
      expect(client.executeCalls).toHaveLength(2);
    });

    it('creates one extension across concurrent executions', async () => {
      client.importDelayMs = 5;
      const executor = new VertexAiCodeExecutor({client});

      await Promise.all([
        executor.executeCode(buildParams(buildInput())),
        executor.executeCode(buildParams(buildInput())),
      ]);

      expect(client.importCalls).toHaveLength(1);
      expect(client.executeCalls).toHaveLength(2);
    });

    it('takes the location from the options when nothing is configured', async () => {
      const executor = new VertexAiCodeExecutor({
        location: 'asia-northeast1',
        client,
      });

      await executor.executeCode(buildParams(buildInput()));

      expect(client.importCalls[0].location).toBe('asia-northeast1');
    });

    it('takes the location from GOOGLE_CLOUD_LOCATION', async () => {
      vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west1');
      const executor = new VertexAiCodeExecutor({client});

      await executor.executeCode(buildParams(buildInput()));

      expect(client.importCalls[0].location).toBe('europe-west1');
    });

    it('takes the project id from the options', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
      const executor = new VertexAiCodeExecutor({
        projectId: 'option-project',
        client,
      });

      await executor.executeCode(buildParams(buildInput()));

      expect(client.importCalls[0].projectId).toBe('option-project');
    });

    it('rejects a construction with neither a resource name nor a project', () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);

      expect(() => new VertexAiCodeExecutor({client})).toThrow(
        'Project ID is required.',
      );
    });

    it('builds a REST client when none is injected', () => {
      const executor = new VertexAiCodeExecutor({resourceName: RESOURCE_NAME});

      expect(executor.resourceName).toBe(RESOURCE_NAME);
    });

    it('rejects a malformed resource name in the constructor', () => {
      expect(
        () =>
          new VertexAiCodeExecutor({resourceName: 'extensions/456', client}),
      ).toThrow(
        'Invalid code interpreter extension resource name: extensions/456',
      );
    });
  });

  describe('base class settings', () => {
    it('keeps the base class defaults when no setting is passed', () => {
      const executor = new VertexAiCodeExecutor({client});

      expect(executor.stateful).toBe(false);
      expect(executor.optimizeDataFile).toBe(false);
    });

    it('honours stateful and optimizeDataFile', () => {
      const executor = new VertexAiCodeExecutor({
        stateful: true,
        optimizeDataFile: true,
        client,
      });

      expect(executor.stateful).toBe(true);
      expect(executor.optimizeDataFile).toBe(true);
    });
  });

  describe('request construction', () => {
    it('prepends the import preamble to the code', async () => {
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      await executor.executeCode(
        buildParams(buildInput({code: 'print("hello")'})),
      );

      const {code} = client.executeCalls[0].params;
      expect(code).toContain('import pandas as pd');
      expect(code).toContain('def explore_df(df: pd.DataFrame) -> None:');
      expect(code.endsWith('\n\nprint("hello")\n')).toBe(true);
    });

    it('forwards input files without re-encoding their content', async () => {
      const inputFile: File = {
        name: 'data.csv',
        content: 'YSxiCjEsMg==',
        mimeType: 'text/csv',
      };
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      await executor.executeCode(
        buildParams(buildInput({inputFiles: [inputFile]})),
      );

      expect(client.executeCalls[0].params.files).toEqual([
        {name: 'data.csv', contents: 'YSxiCjEsMg=='},
      ]);
    });

    it('omits files when there is no input file', async () => {
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      await executor.executeCode(buildParams(buildInput({inputFiles: []})));

      expect(client.executeCalls[0].params).not.toHaveProperty('files');
    });

    it('forwards the execution id as the session id', async () => {
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      await executor.executeCode(
        buildParams(buildInput({executionId: 'session-1'})),
      );

      expect(client.executeCalls[0].params.sessionId).toBe('session-1');
    });

    it('omits the session id when there is no execution id', async () => {
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      await executor.executeCode(buildParams(buildInput()));

      expect(client.executeCalls[0].params).not.toHaveProperty('sessionId');
    });
  });

  describe('response mapping', () => {
    it('maps the execution result and error to stdout and stderr', async () => {
      client.response = {
        execution_result: 'hello\n',
        execution_error: 'a warning',
      };
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      const result = await executor.executeCode(buildParams(buildInput()));

      expect(result.stdout).toBe('hello\n');
      expect(result.stderr).toBe('a warning');
    });

    it('returns empty strings and no files for an empty response', async () => {
      client.response = {};
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      const result = await executor.executeCode(buildParams(buildInput()));

      expect(result).toEqual({stdout: '', stderr: '', outputFiles: []});
    });

    it.each([
      ['plot.png', 'image/png'],
      ['plot.jpeg', 'image/jpeg'],
      ['table.csv', 'text/csv'],
      ['report.pdf', 'application/pdf'],
      ['blob.xyz', 'application/octet-stream'],
      ['noextension', 'application/octet-stream'],
      ['plot.JPG', 'image/jpeg'],
      ['jpg', 'image/jpg'],
    ])('maps %s to %s', async (name, mimeType) => {
      client.response = {output_files: [{name, contents: 'AAA='}]};
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      const result = await executor.executeCode(buildParams(buildInput()));

      expect(result.outputFiles).toEqual([{name, content: 'AAA=', mimeType}]);
    });

    it('maps a .jpg to image/jpg, as adk-python does', async () => {
      client.response = {output_files: [{name: 'plot.jpg', contents: 'AAA='}]};
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      const result = await executor.executeCode(buildParams(buildInput()));

      expect(result.outputFiles[0].mimeType).toBe('image/jpg');
    });

    it('preserves the order and the content of the output files', async () => {
      client.response = {
        output_files: [
          {name: 'first.png', contents: 'AAA='},
          {name: 'second.csv', contents: 'BBB='},
        ],
      };
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      const result = await executor.executeCode(buildParams(buildInput()));

      expect(result.outputFiles).toEqual([
        {name: 'first.png', content: 'AAA=', mimeType: 'image/png'},
        {name: 'second.csv', content: 'BBB=', mimeType: 'text/csv'},
      ]);
    });
  });

  describe('failure paths', () => {
    it('propagates a client failure', async () => {
      client.executeError = new Error('API request failed with status 403: no');
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      await expect(
        executor.executeCode(buildParams(buildInput())),
      ).rejects.toThrow('API request failed with status 403: no');
    });

    it('rejects an execution that has to create an extension without a project', async () => {
      vi.stubEnv('GOOGLE_CLOUD_PROJECT', undefined);
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });
      executor.resourceName = undefined;

      await expect(
        executor.executeCode(buildParams(buildInput())),
      ).rejects.toThrow('Project ID is required.');
      expect(client.importCalls).toEqual([]);
    });

    it('reports an unsupported language without calling the client', async () => {
      const executor = new VertexAiCodeExecutor({
        resourceName: RESOURCE_NAME,
        client,
      });

      const result = await executor.executeCode(
        buildParams(buildInput({language: CodeExecutionLanguage.JAVASCRIPT})),
      );

      expect(result.stdout).toBe('');
      expect(result.outputFiles).toEqual([]);
      expect(result.stderr).toContain('python only');
      expect(result.stderr).toContain('javascript');
      expect(client.executeCalls).toEqual([]);
    });
  });
});
