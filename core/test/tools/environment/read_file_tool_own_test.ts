/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Cases beyond the ported adk-python suite: argument validation, line-ending
 * handling, decoding, truncation and the declaration.
 */

import {BaseEnvironment, ExecutionResult, ReadFileTool} from '@google/adk';
import {Type} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

import {createToolContext} from './environment_test_utils.js';

/** File the tests read unless a case installs its own bytes. */
const PATH = 'file.txt';

/** Environment that returns fixed bytes, or throws a fixed failure. */
class BytesEnvironment extends BaseEnvironment {
  private bytes: Uint8Array = new Uint8Array();
  private failure: unknown;

  override get workingDir(): string {
    return '/does-not-matter';
  }

  setBytes(bytes: Uint8Array): void {
    this.bytes = bytes;
    this.failure = undefined;
  }

  setText(text: string): void {
    this.setBytes(new TextEncoder().encode(text));
  }

  setFailure(failure: unknown): void {
    this.failure = failure;
  }

  override async execute(): Promise<ExecutionResult> {
    throw new Error('ReadFileTool must not execute commands.');
  }

  override async readFile(): Promise<Uint8Array> {
    if (this.failure !== undefined) {
      throw this.failure;
    }
    return this.bytes;
  }

  override async writeFile(): Promise<void> {
    throw new Error('BytesEnvironment does not support writeFile().');
  }
}

describe('ReadFileTool', () => {
  let environment: BytesEnvironment;

  beforeEach(() => {
    environment = new BytesEnvironment();
  });

  function read(
    args: Record<string, unknown>,
    maxOutputChars?: number,
  ): Promise<unknown> {
    const tool =
      maxOutputChars === undefined
        ? new ReadFileTool(environment)
        : new ReadFileTool(environment, {maxOutputChars});
    return tool.runAsync({args, toolContext: createToolContext()});
  }

  describe('argument validation', () => {
    it('rejects a missing path', async () => {
      expect(await read({})).toEqual({
        status: 'error',
        error: '`path` is required.',
      });
    });

    it('rejects an empty path', async () => {
      expect(await read({path: ''})).toEqual({
        status: 'error',
        error: '`path` is required.',
      });
    });

    it('rejects a non-string path', async () => {
      expect(await read({path: 7})).toEqual({
        status: 'error',
        error: '`path` is required.',
      });
    });

    it('rejects a fractional start_line', async () => {
      environment.setText('a\n');
      expect(await read({path: PATH, start_line: 1.5})).toEqual({
        status: 'error',
        error: '`start_line` must be an integer if provided.',
      });
    });

    it('rejects a numeric string end_line', async () => {
      environment.setText('a\n');
      expect(await read({path: PATH, end_line: '2'})).toEqual({
        status: 'error',
        error: '`end_line` must be an integer if provided.',
      });
    });

    it('checks start_line before end_line', async () => {
      environment.setText('a\n');
      expect(await read({path: PATH, start_line: 'x', end_line: 'y'})).toEqual({
        status: 'error',
        error: '`start_line` must be an integer if provided.',
      });
    });

    it('treats a null line number as absent', async () => {
      environment.setText('a\nb\n');
      expect(
        await read({path: PATH, start_line: null, end_line: null}),
      ).toEqual({status: 'ok', content: '     1\ta\n     2\tb\n'});
    });

    it('treats a zero line number as unset', async () => {
      environment.setText('a\nb\n');
      expect(await read({path: PATH, start_line: 0, end_line: 0})).toEqual({
        status: 'ok',
        content: '     1\ta\n     2\tb\n',
      });
    });

    it('clamps a negative start_line to the first line', async () => {
      environment.setText('a\nb\n');
      expect(await read({path: PATH, start_line: -4})).toEqual({
        status: 'ok',
        content: '     1\ta\n     2\tb\n',
      });
    });

    it('clamps an end_line past the last line', async () => {
      environment.setText('a\nb\n');
      expect(await read({path: PATH, end_line: 99})).toEqual({
        status: 'ok',
        content: '     1\ta\n     2\tb\n',
      });
    });
  });

  describe('range errors', () => {
    it('reports a start_line past the end of the file', async () => {
      environment.setText('a\nb\n');
      expect(await read({path: PATH, start_line: 5})).toEqual({
        status: 'error',
        error: '`start_line` 5 exceeds file length (2 lines).',
        total_lines: 2,
      });
    });

    it('reports an empty file as zero lines', async () => {
      environment.setText('');
      expect(await read({path: PATH})).toEqual({
        status: 'error',
        error: '`start_line` 1 exceeds file length (0 lines).',
        total_lines: 0,
      });
    });

    it('reports a start_line after end_line', async () => {
      environment.setText('a\nb\nc\n');
      expect(await read({path: PATH, start_line: 3, end_line: 2})).toEqual({
        status: 'error',
        error: '`start_line` (3) is after `end_line` (2).',
        total_lines: 3,
      });
    });
  });

  describe('total_lines', () => {
    it('is omitted for a full read', async () => {
      environment.setText('a\nb\n');
      expect(await read({path: PATH})).toEqual({
        status: 'ok',
        content: '     1\ta\n     2\tb\n',
      });
    });

    it('is present when the read starts past line 1', async () => {
      environment.setText('a\nb\n');
      expect(await read({path: PATH, start_line: 2})).toEqual({
        status: 'ok',
        content: '     2\tb\n',
        total_lines: 2,
      });
    });

    it('is present when the read stops before the last line', async () => {
      environment.setText('a\nb\n');
      expect(await read({path: PATH, end_line: 1})).toEqual({
        status: 'ok',
        content: '     1\ta\n',
        total_lines: 2,
      });
    });
  });

  describe('line splitting', () => {
    it('keeps the last line when the file has no trailing newline', async () => {
      environment.setText('a\nb');
      expect(await read({path: PATH})).toEqual({
        status: 'ok',
        content: '     1\ta\n     2\tb',
      });
    });

    it('keeps CRLF terminators', async () => {
      environment.setText('a\r\nb\r\n');
      expect(await read({path: PATH})).toEqual({
        status: 'ok',
        content: '     1\ta\r\n     2\tb\r\n',
      });
    });

    it('splits on a bare CR', async () => {
      environment.setText('a\rb\r');
      expect(await read({path: PATH})).toEqual({
        status: 'ok',
        content: '     1\ta\r     2\tb\r',
      });
    });

    it('does not split on a vertical tab or form feed', async () => {
      environment.setText('a\v b\f c\n');
      expect(await read({path: PATH})).toEqual({
        status: 'ok',
        content: '     1\ta\v b\f c\n',
      });
    });

    it('counts a blank line', async () => {
      environment.setText('a\n\nb\n');
      expect(await read({path: PATH, start_line: 2, end_line: 2})).toEqual({
        status: 'ok',
        content: '     2\t\n',
        total_lines: 3,
      });
    });
  });

  describe('decoding', () => {
    it('replaces invalid UTF-8 rather than throwing', async () => {
      environment.setBytes(new Uint8Array([0x61, 0xff, 0x0a]));
      expect(await read({path: PATH})).toEqual({
        status: 'ok',
        content: '     1\ta\ufffd\n',
      });
    });

    it('keeps a leading byte order mark', async () => {
      environment.setBytes(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
      expect(await read({path: PATH})).toEqual({
        status: 'ok',
        content: '     1\t\ufeffa',
      });
    });
  });

  describe('line numbers', () => {
    it('right-aligns the number in a six-character column', async () => {
      environment.setText('a\n');
      expect(await read({path: PATH})).toEqual({
        status: 'ok',
        content: '     1\ta\n',
      });
    });

    it('does not truncate a number wider than the column', async () => {
      environment.setText('x\n'.repeat(1_000_000));
      const result = await read({path: PATH, start_line: 1_000_000});

      expect(result).toEqual({
        status: 'ok',
        content: '1000000\tx\n',
        total_lines: 1_000_000,
      });
    });
  });

  describe('truncation', () => {
    it('caps content over the limit and reports the original length', async () => {
      environment.setText('abcdefghij\n');
      // Eight characters of the numbered line: '     1\tab'.slice(0, 8).
      expect(await read({path: PATH}, 8)).toEqual({
        status: 'ok',
        content: '     1\ta\n... (truncated, 18 total chars)',
      });
    });

    it('honours an explicit maxOutputChars of zero', async () => {
      environment.setText('a\n');
      expect(await read({path: PATH}, 0)).toEqual({
        status: 'ok',
        content: '\n... (truncated, 9 total chars)',
      });
    });
  });

  describe('read failures', () => {
    it('reports a missing file from an ENOENT code', async () => {
      environment.setFailure(
        Object.assign(new Error('ENOENT: no such file'), {code: 'ENOENT'}),
      );
      expect(await read({path: 'gone.txt'})).toEqual({
        status: 'error',
        error: 'File not found: gone.txt',
      });
    });

    it('reports any other failure through formatError', async () => {
      environment.setFailure(new Error('disk on fire'));
      expect(await read({path: PATH})).toEqual({
        status: 'error',
        error: 'disk on fire',
      });
    });

    it('reports an uninitialized environment as a generic error', async () => {
      environment.setFailure(
        Object.assign(new Error('permission denied'), {code: 'EACCES'}),
      );
      expect(await read({path: PATH})).toEqual({
        status: 'error',
        error: 'permission denied',
      });
    });
  });

  describe('declaration', () => {
    it('requires path and offers two optional integer line numbers', () => {
      const declaration = new ReadFileTool(environment)._getDeclaration();

      expect(declaration.name).toBe('ReadFile');
      expect(declaration.description).toBe(
        'Read the contents of a file in the environment. ' +
          'Returns the file content with line numbers.',
      );
      expect(declaration.parameters?.required).toEqual(['path']);
      expect(declaration.parameters?.properties?.['path']?.type).toBe(
        Type.STRING,
      );
      expect(declaration.parameters?.properties?.['start_line']?.type).toBe(
        Type.INTEGER,
      );
      expect(declaration.parameters?.properties?.['end_line']?.type).toBe(
        Type.INTEGER,
      );
    });
  });
});
