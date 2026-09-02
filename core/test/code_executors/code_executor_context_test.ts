/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  File,
  FileContentEncoding,
} from '../../src/code_executors/code_execution_utils.js';
import {CodeExecutorContext} from '../../src/code_executors/code_executor_context.js';
import {State} from '../../src/sessions/state.js';

const CONTEXT_KEY = '_code_execution_context';
const INPUT_FILE_KEY = '_code_executor_input_files';
const ERROR_COUNT_KEY = '_code_executor_error_counts';
const RESULTS_KEY = '_code_execution_results';

const inputFile1: File = {
  name: 'f1.txt',
  content: 'aGVsbG8=',
  mimeType: 'text/plain',
};
const inputFile2: File = {
  name: 'f2.txt',
  content: 'd29ybGQ=',
  mimeType: 'text/plain',
};

function makeContext(initial: Record<string, unknown> = {}): {
  state: State;
  ctx: CodeExecutorContext;
} {
  const state = new State(initial);
  return {state, ctx: new CodeExecutorContext(state)};
}

function storedFiles(state: State): File[] {
  const files = state.get<File[]>(INPUT_FILE_KEY);
  if (!files) {
    return expect.fail(`session state holds no ${INPUT_FILE_KEY}`);
  }
  return files;
}

function firstResult(
  state: State,
  invocationId: string,
): Record<string, unknown> {
  const results =
    state.get<Record<string, Array<Record<string, unknown>>>>(RESULTS_KEY);
  if (!results) {
    return expect.fail(`session state holds no ${RESULTS_KEY}`);
  }
  return results[invocationId][0];
}

describe('CodeExecutorContext', () => {
  describe('getStateDelta', () => {
    it('returns an empty context delta when state has no context key', () => {
      const {ctx} = makeContext();
      const delta = ctx.getStateDelta();
      expect(delta).toEqual({_code_execution_context: {}});
    });

    it('returns a deep clone so mutations do not affect the stored context', () => {
      const {ctx} = makeContext();
      ctx.setExecutionId('abc');
      const delta = ctx.getStateDelta() as Record<
        string,
        Record<string, unknown>
      >;
      delta['_code_execution_context']['execution_session_id'] = 'mutated';
      expect(ctx.getExecutionId()).toBe('abc');
    });
  });

  describe('getExecutionId / setExecutionId', () => {
    it('returns undefined when execution ID has not been set', () => {
      const {ctx} = makeContext();
      expect(ctx.getExecutionId()).toBeUndefined();
    });

    it('returns the execution ID after setting it', () => {
      const {ctx} = makeContext();
      ctx.setExecutionId('session-123');
      expect(ctx.getExecutionId()).toBe('session-123');
    });

    it('overwrites an existing execution ID', () => {
      const {ctx} = makeContext();
      ctx.setExecutionId('first');
      ctx.setExecutionId('second');
      expect(ctx.getExecutionId()).toBe('second');
    });
  });

  describe('getProcessedFileNames / addProcessedFileNames', () => {
    it('returns an empty array when no file names have been added', () => {
      const {ctx} = makeContext();
      expect(ctx.getProcessedFileNames()).toEqual([]);
    });

    it('returns added file names', () => {
      const {ctx} = makeContext();
      ctx.addProcessedFileNames(['a.csv', 'b.csv']);
      expect(ctx.getProcessedFileNames()).toEqual(['a.csv', 'b.csv']);
    });

    it('appends on a second call', () => {
      const {ctx} = makeContext();
      ctx.addProcessedFileNames(['a.csv']);
      ctx.addProcessedFileNames(['b.csv']);
      expect(ctx.getProcessedFileNames()).toEqual(['a.csv', 'b.csv']);
    });
  });

  describe('getInputFiles / addInputFiles / clearInputFiles', () => {
    const file1: File = {
      name: 'f1.txt',
      content: 'aGVsbG8=',
      contentEncoding: undefined,
      mimeType: 'text/plain',
    };
    const file2: File = {
      name: 'f2.txt',
      content: 'd29ybGQ=',
      contentEncoding: undefined,
      mimeType: 'text/plain',
    };

    it('returns an empty array when no input files have been added', () => {
      const {ctx} = makeContext();
      expect(ctx.getInputFiles()).toEqual([]);
    });

    it('returns added input files', () => {
      const {ctx} = makeContext();
      ctx.addInputFiles([file1]);
      expect(ctx.getInputFiles()).toEqual([file1]);
    });

    it('appends on a second addInputFiles call', () => {
      const {ctx} = makeContext();
      ctx.addInputFiles([file1]);
      ctx.addInputFiles([file2]);
      expect(ctx.getInputFiles()).toHaveLength(2);
      expect(ctx.getInputFiles()[1]).toEqual(file2);
    });

    it('clearInputFiles empties the input files list', () => {
      const {ctx} = makeContext();
      ctx.addInputFiles([file1]);
      ctx.clearInputFiles();
      expect(ctx.getInputFiles()).toEqual([]);
    });

    it('clearInputFiles also resets processed file names', () => {
      const {ctx} = makeContext();
      ctx.addProcessedFileNames(['a.csv']);
      ctx.addInputFiles([file1]);
      ctx.clearInputFiles();
      expect(ctx.getProcessedFileNames()).toEqual([]);
    });

    it('clearInputFiles is a no-op when no files were added', () => {
      const {ctx} = makeContext();
      expect(() => ctx.clearInputFiles()).not.toThrow();
    });
  });

  describe('getErrorCount / incrementErrorCount / resetErrorCount', () => {
    it('returns 0 when error count has not been set', () => {
      const {ctx} = makeContext();
      expect(ctx.getErrorCount('inv-1')).toBe(0);
    });

    it('increments the error count from 0 to 1', () => {
      const {ctx} = makeContext();
      ctx.incrementErrorCount('inv-1');
      expect(ctx.getErrorCount('inv-1')).toBe(1);
    });

    it('increments the error count on successive calls', () => {
      const {ctx} = makeContext();
      ctx.incrementErrorCount('inv-1');
      ctx.incrementErrorCount('inv-1');
      ctx.incrementErrorCount('inv-1');
      expect(ctx.getErrorCount('inv-1')).toBe(3);
    });

    it('tracks error counts per invocation ID independently', () => {
      const {ctx} = makeContext();
      ctx.incrementErrorCount('inv-1');
      ctx.incrementErrorCount('inv-2');
      ctx.incrementErrorCount('inv-2');
      expect(ctx.getErrorCount('inv-1')).toBe(1);
      expect(ctx.getErrorCount('inv-2')).toBe(2);
    });

    it('resetErrorCount brings the count back to 0', () => {
      const {ctx} = makeContext();
      ctx.incrementErrorCount('inv-1');
      ctx.incrementErrorCount('inv-1');
      ctx.resetErrorCount('inv-1');
      expect(ctx.getErrorCount('inv-1')).toBe(0);
    });

    it('resetErrorCount is a no-op when no counts have been recorded', () => {
      const {ctx} = makeContext();
      expect(() => ctx.resetErrorCount('inv-1')).not.toThrow();
      expect(ctx.getErrorCount('inv-1')).toBe(0);
    });

    it('resetErrorCount does not affect other invocation counts', () => {
      const {ctx} = makeContext();
      ctx.incrementErrorCount('inv-1');
      ctx.incrementErrorCount('inv-2');
      ctx.resetErrorCount('inv-1');
      expect(ctx.getErrorCount('inv-2')).toBe(1);
    });
  });

  describe('updateCodeExecutionResult', () => {
    it('stores a code execution result', () => {
      const {ctx, state} = makeContext();
      ctx.updateCodeExecutionResult({
        invocationId: 'inv-1',
        code: 'print("hi")',
        resultStdout: 'hi',
        resultStderr: '',
      });
      const results = state.get('_code_execution_results') as Record<
        string,
        unknown[]
      >;
      expect(results['inv-1']).toHaveLength(1);
      expect((results['inv-1'][0] as Record<string, unknown>)['code']).toBe(
        'print("hi")',
      );
    });

    it('appends a second result for the same invocation ID', () => {
      const {ctx, state} = makeContext();
      ctx.updateCodeExecutionResult({
        invocationId: 'inv-1',
        code: 'x = 1',
        resultStdout: '',
        resultStderr: '',
      });
      ctx.updateCodeExecutionResult({
        invocationId: 'inv-1',
        code: 'print(x)',
        resultStdout: '1',
        resultStderr: '',
      });
      const results = state.get('_code_execution_results') as Record<
        string,
        unknown[]
      >;
      expect(results['inv-1']).toHaveLength(2);
    });
  });

  describe('getCodeExecutionContext', () => {
    it('returns an empty object when no context has been set', () => {
      const {ctx} = makeContext();
      expect(ctx.getCodeExecutionContext()).toEqual({});
    });

    it('reflects mutations when state is pre-initialized with the context key', () => {
      // When the session state already has the context object, setExecutionId
      // mutates the same object reference so getCodeExecutionContext sees it.
      const contextObj: Record<string, unknown> = {};
      const state = new State({'_code_execution_context': contextObj});
      const ctx = new CodeExecutorContext(state);
      ctx.setExecutionId('s-42');
      const result = ctx.getCodeExecutionContext() as Record<string, unknown>;
      expect(result['execution_session_id']).toBe('s-42');
    });
  });

  describe('constructor write-back', () => {
    it('stores an empty context when the key is absent', () => {
      const {state} = makeContext();
      expect(state.get(CONTEXT_KEY)).toEqual({});
    });

    it('records the context key in the delta', () => {
      const delta: Record<string, unknown> = {};
      const state = new State({}, delta);
      new CodeExecutorContext(state);
      expect(CONTEXT_KEY in delta).toBe(true);
    });

    it('holds the stored object, so setExecutionId is visible through state', () => {
      const {ctx, state} = makeContext();
      ctx.setExecutionId('s-1');
      expect(state.get(CONTEXT_KEY)).toEqual({execution_session_id: 's-1'});
    });

    it('adopts a pre-existing context instead of replacing it', () => {
      const {ctx} = makeContext({
        [CONTEXT_KEY]: {execution_session_id: 'session123'},
      });
      expect(ctx.getExecutionId()).toBe('session123');
      expect(ctx.getStateDelta()).toEqual({
        [CONTEXT_KEY]: {execution_session_id: 'session123'},
      });
    });
  });

  describe('delta recording for pre-existing keys', () => {
    function seededState(): {state: State; delta: Record<string, unknown>} {
      const delta: Record<string, unknown> = {};
      const state = new State(
        {
          [CONTEXT_KEY]: {},
          [INPUT_FILE_KEY]: [
            {name: 'a.txt', content: 'YQ==', mimeType: 'text/plain'},
          ],
          [ERROR_COUNT_KEY]: {inv: 2},
          [RESULTS_KEY]: {inv: []},
        },
        delta,
      );
      return {state, delta};
    }

    it('records every mutating write on keys that already exist', () => {
      const {state, delta} = seededState();
      const ctx = new CodeExecutorContext(state);

      ctx.addInputFiles([inputFile2]);
      ctx.incrementErrorCount('inv');
      ctx.updateCodeExecutionResult({
        invocationId: 'inv',
        code: 'x = 1',
        resultStdout: '',
        resultStderr: '',
      });

      expect(delta[INPUT_FILE_KEY]).toHaveLength(2);
      expect(delta[ERROR_COUNT_KEY]).toEqual({inv: 3});
      expect(
        (delta[RESULTS_KEY] as Record<string, unknown[]>)['inv'],
      ).toHaveLength(1);
    });

    it('records the error counts when an invocation is reset', () => {
      const {state, delta} = seededState();
      const ctx = new CodeExecutorContext(state);

      ctx.resetErrorCount('inv');

      expect(delta[ERROR_COUNT_KEY]).toEqual({});
      expect(ctx.getErrorCount('inv')).toBe(0);
    });

    it('records the error counts when the invocation is unknown', () => {
      const {state, delta} = seededState();
      const ctx = new CodeExecutorContext(state);

      expect(() => ctx.resetErrorCount('unknown')).not.toThrow();
      expect(delta[ERROR_COUNT_KEY]).toEqual({inv: 2});
    });

    it('leaves the error counts key absent when it was never set', () => {
      const {ctx, state} = makeContext();

      ctx.resetErrorCount('inv');

      expect(state.has(ERROR_COUNT_KEY)).toBe(false);
    });

    it('records the emptied input files on a seeded state', () => {
      const {state, delta} = seededState();
      const ctx = new CodeExecutorContext(state);

      ctx.clearInputFiles();

      expect(delta[INPUT_FILE_KEY]).toEqual([]);
    });

    it('leaves the input files key absent when it was never set', () => {
      const {ctx, state} = makeContext();

      ctx.clearInputFiles();

      expect(state.has(INPUT_FILE_KEY)).toBe(false);
    });
  });

  describe('code execution result timestamp', () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it('is the current time in whole seconds', () => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2025-01-01T00:00:00Z'));
      const {ctx, state} = makeContext();

      ctx.updateCodeExecutionResult({
        invocationId: 'inv-1',
        code: 'x = 1',
        resultStdout: '',
        resultStderr: '',
      });

      expect(firstResult(state, 'inv-1')['timestamp']).toBe(1735689600);
    });

    it('is an integer far below the millisecond magnitude', () => {
      const {ctx, state} = makeContext();

      ctx.updateCodeExecutionResult({
        invocationId: 'inv-1',
        code: 'x = 1',
        resultStdout: '',
        resultStderr: '',
      });

      const timestamp = firstResult(state, 'inv-1')['timestamp'] as number;
      expect(Number.isInteger(timestamp)).toBe(true);
      expect(timestamp).toBeLessThan(Date.now() / 100);
    });
  });

  describe('input file reconstruction', () => {
    it('rebuilds the stored records as File objects', () => {
      const {ctx} = makeContext({
        [INPUT_FILE_KEY]: [
          {name: 'input1.txt', content: 'YQ==', mimeType: 'text/plain'},
        ],
      });

      expect(ctx.getInputFiles()).toEqual([
        {name: 'input1.txt', content: 'YQ==', mimeType: 'text/plain'},
      ]);
    });

    it('defaults a record without a mime type to text/plain', () => {
      const {ctx} = makeContext({
        [INPUT_FILE_KEY]: [{name: 'input1.txt', content: 'YQ=='}],
      });

      expect(ctx.getInputFiles()[0].mimeType).toBe('text/plain');
    });

    it('round-trips the content encoding', () => {
      const {ctx} = makeContext();
      const encoded: File = {
        name: 'raw.txt',
        content: 'hello',
        contentEncoding: FileContentEncoding.UTF8,
        mimeType: 'text/plain',
      };

      ctx.addInputFiles([encoded]);

      expect(ctx.getInputFiles()[0].contentEncoding).toBe(
        FileContentEncoding.UTF8,
      );
    });

    it('returns a copy of the array, not the stored one', () => {
      const {ctx} = makeContext();
      ctx.addInputFiles([inputFile1]);

      ctx.getInputFiles().push(inputFile2);

      expect(ctx.getInputFiles()).toHaveLength(1);
    });

    it('returns copies of the records, not the stored ones', () => {
      const {ctx} = makeContext();
      ctx.addInputFiles([inputFile1]);

      ctx.getInputFiles()[0].name = 'mutated.txt';

      expect(ctx.getInputFiles()[0].name).toBe('f1.txt');
    });

    it('stores a copy of the file it was given', () => {
      const {ctx, state} = makeContext();
      const mutable: File = {...inputFile1};

      ctx.addInputFiles([mutable]);
      mutable.name = 'mutated.txt';

      expect(storedFiles(state)[0].name).toBe('f1.txt');
    });

    it('does not duplicate a file when the caller also accumulates it', () => {
      const {ctx, state} = makeContext({
        [INPUT_FILE_KEY]: [
          {name: 'f1.txt', content: 'aGVsbG8=', mimeType: 'text/plain'},
        ],
      });

      const all = ctx.getInputFiles();
      ctx.addInputFiles([inputFile2]);
      all.push(inputFile2);

      expect(storedFiles(state)).toHaveLength(2);
      expect(all).toHaveLength(2);
    });
  });
});
