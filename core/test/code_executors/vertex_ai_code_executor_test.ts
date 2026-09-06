/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  CodeExecutionLanguage,
  CodeInterpreterExecuteResponse,
  CodeInterpreterExtension,
  InvocationContext,
  VertexAiCodeExecutor,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

// The reference does not read the invocation context; a minimal cast suffices.
const invocationContext = {} as unknown as InvocationContext;

interface MockExtension {
  execute: ReturnType<typeof vi.fn>;
}

function createMockExtension(
  response: CodeInterpreterExecuteResponse = {},
): MockExtension {
  return {execute: vi.fn().mockResolvedValue(response)};
}

function run(
  executor: VertexAiCodeExecutor,
  code = 'print(1 + 1)',
  extra: Partial<{
    inputFiles: {name: string; content: string; mimeType: string}[];
    executionId: string;
  }> = {},
) {
  return executor.executeCode({
    invocationContext,
    codeExecutionInput: {
      code,
      language: CodeExecutionLanguage.PYTHON,
      inputFiles: extra.inputFiles ?? [],
      executionId: extra.executionId,
    },
  });
}

describe('VertexAiCodeExecutor', () => {
  let mockExtension: MockExtension;
  let executor: VertexAiCodeExecutor;

  beforeEach(() => {
    mockExtension = createMockExtension({
      execution_result: 'out',
      execution_error: 'err',
      output_files: [],
    });
    executor = new VertexAiCodeExecutor({
      codeInterpreterExtension:
        mockExtension as unknown as CodeInterpreterExtension,
    });
  });

  it('can be constructed with an injected handle without executing', () => {
    expect(executor).toBeDefined();
    expect(mockExtension.execute).not.toHaveBeenCalled();
  });

  it('maps execution_result/execution_error to stdout/stderr', async () => {
    const result = await run(executor);
    expect(result.stdout).toBe('out');
    expect(result.stderr).toBe('err');
    expect(result.outputFiles).toEqual([]);
  });

  it('defaults stdout/stderr/outputFiles when response fields are absent', async () => {
    executor = new VertexAiCodeExecutor({
      codeInterpreterExtension: createMockExtension(
        {},
      ) as unknown as CodeInterpreterExtension,
    });
    const result = await run(executor);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.outputFiles).toEqual([]);
  });

  it('prepends the imports preamble to the user code', async () => {
    await run(executor, 'print("hello")');

    expect(mockExtension.execute).toHaveBeenCalledTimes(1);
    const request = mockExtension.execute.mock.calls[0][0];
    expect(request.operationId).toBe('execute');

    const sentCode = request.operationParams.code as string;
    expect(sentCode).toContain('import pandas as pd');
    expect(sentCode).toContain('def explore_df');
    // The preamble precedes and the user code terminates the payload.
    expect(sentCode.endsWith('print("hello")\n')).toBe(true);
    expect(sentCode.indexOf('import pandas as pd')).toBeLessThan(
      sentCode.indexOf('print("hello")'),
    );
  });

  it('forwards input files as {name, contents} operation params', async () => {
    await run(executor, 'print(1)', {
      inputFiles: [{name: 'data.csv', content: '<b64>', mimeType: 'text/csv'}],
    });

    const request = mockExtension.execute.mock.calls[0][0];
    expect(request.operationParams.files).toEqual([
      {name: 'data.csv', contents: '<b64>'},
    ]);
  });

  it('omits the files param when there are no input files', async () => {
    await run(executor);
    const request = mockExtension.execute.mock.calls[0][0];
    expect(request.operationParams.files).toBeUndefined();
  });

  it('maps executionId to the session_id operation param', async () => {
    await run(executor, 'print(1)', {executionId: 'sess-1'});
    const request = mockExtension.execute.mock.calls[0][0];
    expect(request.operationParams.session_id).toBe('sess-1');
  });

  it('omits session_id when executionId is not provided', async () => {
    await run(executor);
    const request = mockExtension.execute.mock.calls[0][0];
    expect(request.operationParams.session_id).toBeUndefined();
  });

  describe('output file MIME assignment', () => {
    async function mimeFor(name: string): Promise<string> {
      executor = new VertexAiCodeExecutor({
        codeInterpreterExtension: createMockExtension({
          output_files: [{name, contents: 'data'}],
        }) as unknown as CodeInterpreterExtension,
      });
      const result = await run(executor);
      return result.outputFiles[0].mimeType;
    }

    it('assigns image/png for .png', async () => {
      expect(await mimeFor('plot.png')).toBe('image/png');
    });

    it('assigns image/jpg (not image/jpeg) for .jpg', async () => {
      const mimeType = await mimeFor('plot.jpg');
      expect(mimeType).toBe('image/jpg');
      expect(mimeType).not.toBe('image/jpeg');
    });

    it('assigns image/jpeg for .jpeg', async () => {
      expect(await mimeFor('plot.jpeg')).toBe('image/jpeg');
    });

    it('assigns text/csv for .csv', async () => {
      expect(await mimeFor('data.csv')).toBe('text/csv');
    });

    it('falls back to guessMimeType for a known non-image/non-csv extension', async () => {
      expect(await mimeFor('report.pdf')).toBe('application/pdf');
      expect(await mimeFor('data.json')).toBe('application/json');
    });

    it('falls back to application/octet-stream for an unknown extension', async () => {
      expect(await mimeFor('mystery.xyz')).toBe('application/octet-stream');
    });
  });

  it('maps output file name/contents and preserves order', async () => {
    executor = new VertexAiCodeExecutor({
      codeInterpreterExtension: createMockExtension({
        output_files: [
          {name: 'first.png', contents: 'aaa'},
          {name: 'second.csv', contents: 'bbb'},
        ],
      }) as unknown as CodeInterpreterExtension,
    });

    const result = await run(executor);
    expect(result.outputFiles).toEqual([
      {name: 'first.png', content: 'aaa', mimeType: 'image/png'},
      {name: 'second.csv', content: 'bbb', mimeType: 'text/csv'},
    ]);
  });

  describe('missing extension handle (no injected handle)', () => {
    it('throws a clear error when nothing is provided', async () => {
      const bare = new VertexAiCodeExecutor();
      await expect(run(bare)).rejects.toThrow(
        'VertexAiCodeExecutor could not load a Code Interpreter Extension',
      );
    });

    it('includes the resourceName in the error when one is set', async () => {
      const withResource = new VertexAiCodeExecutor({
        resourceName: 'projects/123/locations/us-central1/extensions/456',
      });
      await expect(run(withResource)).rejects.toThrow(
        'resourceName: projects/123/locations/us-central1/extensions/456',
      );
      expect(withResource.resourceName).toBe(
        'projects/123/locations/us-central1/extensions/456',
      );
    });
  });
});
