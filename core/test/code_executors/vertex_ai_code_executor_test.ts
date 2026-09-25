/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {InvocationContext} from '../../src/agents/invocation_context.js';
import {CodeExecutionLanguage} from '../../src/code_executors/code_execution_utils.js';
import {
  CodeInterpreterExecuteRequest,
  CodeInterpreterExtension,
  CodeInterpreterResponse,
  VertexAiCodeExecutor,
  VertexAiCodeInterpreterExtension,
  getCodeWithImports,
} from '../../src/code_executors/vertex_ai_code_executor.js';

class FakeExtension implements CodeInterpreterExtension {
  requests: CodeInterpreterExecuteRequest[] = [];

  constructor(private readonly response: CodeInterpreterResponse) {}

  async execute(
    request: CodeInterpreterExecuteRequest,
  ): Promise<CodeInterpreterResponse> {
    this.requests.push(request);
    return this.response;
  }
}

const invocationContext = {} as InvocationContext;

describe('VertexAiCodeExecutor', () => {
  const originalEnv = process.env['CODE_INTERPRETER_EXTENSION_NAME'];

  beforeEach(() => {
    delete process.env['CODE_INTERPRETER_EXTENSION_NAME'];
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEnv === undefined) {
      delete process.env['CODE_INTERPRETER_EXTENSION_NAME'];
    } else {
      process.env['CODE_INTERPRETER_EXTENSION_NAME'] = originalEnv;
    }
  });

  describe('constructor', () => {
    it('uses the given resource name', () => {
      const executor = new VertexAiCodeExecutor({
        resourceName: 'projects/1/locations/us-central1/extensions/2',
      });
      expect(executor.resourceName).toBe(
        'projects/1/locations/us-central1/extensions/2',
      );
    });

    it('falls back to CODE_INTERPRETER_EXTENSION_NAME', () => {
      process.env['CODE_INTERPRETER_EXTENSION_NAME'] =
        'projects/1/locations/europe-west1/extensions/3';
      const executor = new VertexAiCodeExecutor();
      expect(executor.resourceName).toBe(
        'projects/1/locations/europe-west1/extensions/3',
      );
    });

    it('throws when no resource name or extension is available', () => {
      expect(() => new VertexAiCodeExecutor()).toThrow(
        /CODE_INTERPRETER_EXTENSION_NAME/,
      );
    });

    it('accepts an extension client without a resource name', () => {
      const executor = new VertexAiCodeExecutor({
        codeInterpreterExtension: new FakeExtension({}),
      });
      expect(executor.resourceName).toBeUndefined();
    });
  });

  describe('executeCode', () => {
    it('sends the code with imports and the execute operation', async () => {
      const extension = new FakeExtension({execution_result: 'ok'});
      const executor = new VertexAiCodeExecutor({
        codeInterpreterExtension: extension,
      });

      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'print(1)',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(extension.requests).toEqual([
        {
          operationId: 'execute',
          operationParams: {code: getCodeWithImports('print(1)')},
        },
      ]);
    });

    it('sends input files and the execution id as session_id', async () => {
      const extension = new FakeExtension({});
      const executor = new VertexAiCodeExecutor({
        codeInterpreterExtension: extension,
      });

      await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: 'x',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [{name: 'a.csv', content: 'YSxi', mimeType: 'text/csv'}],
          executionId: 'session-1',
        },
      });

      expect(extension.requests[0].operationParams).toEqual({
        code: getCodeWithImports('x'),
        files: [{name: 'a.csv', contents: 'YSxi'}],
        session_id: 'session-1',
      });
    });

    it('maps stdout and stderr, defaulting to empty strings', async () => {
      const executor = new VertexAiCodeExecutor({
        codeInterpreterExtension: new FakeExtension({
          execution_result: 'out',
          execution_error: 'err',
        }),
      });
      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: '',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });
      expect(result).toEqual({stdout: 'out', stderr: 'err', outputFiles: []});

      const emptyExecutor = new VertexAiCodeExecutor({
        codeInterpreterExtension: new FakeExtension({}),
      });
      const emptyResult = await emptyExecutor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: '',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });
      expect(emptyResult).toEqual({stdout: '', stderr: '', outputFiles: []});
    });

    it('names and types output files by extension', async () => {
      const executor = new VertexAiCodeExecutor({
        codeInterpreterExtension: new FakeExtension({
          output_files: [
            {name: 'chart.png', contents: 'p'},
            {name: 'table.csv', contents: 'c'},
            {name: 'notes.json', contents: 't'},
            {name: 'photo.jpeg', contents: 'j'},
          ],
        }),
      });

      const result = await executor.executeCode({
        invocationContext,
        codeExecutionInput: {
          code: '',
          language: CodeExecutionLanguage.PYTHON,
          inputFiles: [],
        },
      });

      expect(result.outputFiles).toEqual([
        {
          name: 'plot_20260102_030405_0.png',
          content: 'p',
          mimeType: 'image/png',
        },
        {
          name: 'data_20260102_030405_1.csv',
          content: 'c',
          mimeType: 'text/csv',
        },
        {
          name: '20260102_030405_2.json',
          content: 't',
          mimeType: 'application/json',
        },
        {
          name: 'plot_20260102_030405_2.jpeg',
          content: 'j',
          mimeType: 'image/jpeg',
        },
      ]);
    });
  });

  describe('getCodeWithImports', () => {
    it('prepends the built-in imports and helpers', () => {
      const code = getCodeWithImports('print("hi")');
      expect(code).toContain('import pandas as pd');
      expect(code).toContain('def explore_df(df: pd.DataFrame) -> None:');
      expect(code.trimEnd().endsWith('print("hi")')).toBe(true);
    });
  });
});

describe('VertexAiCodeInterpreterExtension', () => {
  it('rejects a resource name without a location', async () => {
    const extension = new VertexAiCodeInterpreterExtension('extensions/1');
    await expect(
      extension.execute({operationId: 'execute', operationParams: {}}),
    ).rejects.toThrow(/Invalid code interpreter extension resource name/);
  });
});
