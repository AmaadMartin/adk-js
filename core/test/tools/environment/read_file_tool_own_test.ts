/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseEnvironment,
  ExecutionResult,
  ReadFileTool,
  ReadFileToolOptions,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {makeContext} from './environment_test_utils.js';

/** Environment double returning one fixed file, or a fixed read failure. */
class BytesEnvironment extends BaseEnvironment {
  constructor(
    private readonly data: Uint8Array,
    private readonly failure?: Error,
  ) {
    super();
  }

  override get workingDir(): string {
    return '/workspace';
  }

  override async execute(): Promise<ExecutionResult> {
    throw new Error('not implemented');
  }

  override async readFile(): Promise<Uint8Array> {
    if (this.failure) {
      throw this.failure;
    }
    return this.data;
  }

  override async writeFile(): Promise<void> {
    throw new Error('not implemented');
  }
}

async function runTool(
  environment: BytesEnvironment,
  args: Record<string, unknown>,
  options?: ReadFileToolOptions,
): Promise<Record<string, unknown>> {
  const tool = new ReadFileTool(environment, options);
  return (await tool.runAsync({
    args: {path: 'f.txt', ...args},
    toolContext: makeContext(),
  })) as Record<string, unknown>;
}

async function read(
  data: Uint8Array,
  args: Record<string, unknown> = {},
  options?: ReadFileToolOptions,
): Promise<Record<string, unknown>> {
  return runTool(new BytesEnvironment(data), args, options);
}

function bytesOf(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('ReadFileTool', () => {
  it('rejects a missing path', async () => {
    expect(await read(bytesOf('a\n'), {path: undefined})).toEqual({
      status: 'error',
      error: '`path` is required.',
    });
  });

  it('reports a start_line past the end of the file', async () => {
    expect(await read(bytesOf('a\nb\n'), {start_line: 5})).toEqual({
      status: 'error',
      error: '`start_line` 5 exceeds file length (2 lines).',
      total_lines: 2,
    });
  });

  it('reports a start_line after the end_line', async () => {
    expect(
      await read(bytesOf('a\nb\nc\n'), {start_line: 3, end_line: 2}),
    ).toEqual({
      status: 'error',
      error: '`start_line` (3) is after `end_line` (2).',
      total_lines: 3,
    });
  });

  it('omits total_lines on a full read', async () => {
    expect(await read(bytesOf('a\nb\n'))).toEqual({
      status: 'ok',
      content: '     1\ta\n     2\tb\n',
    });
  });

  it('includes total_lines on a partial read', async () => {
    expect(await read(bytesOf('a\nb\nc\n'), {end_line: 2})).toEqual({
      status: 'ok',
      content: '     1\ta\n     2\tb\n',
      total_lines: 3,
    });
  });

  it('keeps the last line of a file with no trailing newline', async () => {
    expect(await read(bytesOf('a\nb'))).toEqual({
      status: 'ok',
      content: '     1\ta\n     2\tb',
    });
  });

  it('splits a file with CRLF line endings', async () => {
    expect(await read(bytesOf('a\r\nb\r\n'))).toEqual({
      status: 'ok',
      content: '     1\ta\r\n     2\tb\r\n',
    });
  });

  it('splits a file with bare CR line endings', async () => {
    expect(await read(bytesOf('a\rb\r'))).toEqual({
      status: 'ok',
      content: '     1\ta\r     2\tb\r',
    });
  });

  it('reports an empty file as having no lines', async () => {
    expect(await read(bytesOf(''))).toEqual({
      status: 'error',
      error: '`start_line` 1 exceeds file length (0 lines).',
      total_lines: 0,
    });
  });

  it('treats a null line number as absent', async () => {
    expect(
      await read(bytesOf('a\nb\n'), {start_line: null, end_line: null}),
    ).toEqual({status: 'ok', content: '     1\ta\n     2\tb\n'});
  });

  it('treats a zero line number as unset, as Python does', async () => {
    expect(await read(bytesOf('a\nb\n'), {start_line: 0, end_line: 0})).toEqual(
      {status: 'ok', content: '     1\ta\n     2\tb\n'},
    );
  });

  it('replaces invalid UTF-8 bytes rather than throwing', async () => {
    const result = await read(new Uint8Array([0xff, 0xfe, 0x0a]));
    expect(result['status']).toBe('ok');
    expect(result['content']).toBe('     1\t\uFFFD\uFFFD\n');
  });

  it('keeps a leading byte-order mark', async () => {
    const result = await read(new Uint8Array([0xef, 0xbb, 0xbf, 0x61]));
    expect(result['content']).toBe('     1\t\uFEFFa');
  });

  it('surfaces a read failure that is not a missing file', async () => {
    const environment = new BytesEnvironment(
      bytesOf(''),
      new Error('disk on fire'),
    );
    expect(await runTool(environment, {})).toEqual({
      status: 'error',
      error: 'disk on fire',
    });
  });

  it('honours an explicit maxOutputChars of 0', async () => {
    expect(await read(bytesOf('abc'), {}, {maxOutputChars: 0})).toEqual({
      status: 'ok',
      content: '\n... (truncated, 10 total chars)',
    });
  });

  it('declares path as required and the line numbers as optional integers', () => {
    const declaration = new ReadFileTool(
      new BytesEnvironment(bytesOf('')),
    )._getDeclaration();
    expect(declaration.name).toBe('ReadFile');
    expect(declaration.parameters?.required).toEqual(['path']);
    expect(declaration.parameters?.properties?.['start_line'].type).toBe(
      'INTEGER',
    );
    expect(declaration.parameters?.properties?.['end_line'].type).toBe(
      'INTEGER',
    );
  });

  it('pads line numbers wider than the column', async () => {
    const lines = Array.from({length: 3}, (_, i) => `l${i}`).join('\n');
    const result = await read(bytesOf(lines), {start_line: 2});
    expect(result['content']).toBe('     2\tl1\n     3\tl2');
  });
});
