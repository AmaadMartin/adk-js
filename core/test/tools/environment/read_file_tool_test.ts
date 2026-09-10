/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python `main`,
 * `tests/unittests/tools/environment/test_read_file_tool.py`. Test names are
 * kept verbatim so the two suites can be compared by name.
 */

import {
  BaseEnvironment,
  ExecutionResult,
  LocalEnvironment,
  ReadFileTool,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {makeContext} from './environment_test_utils.js';

/** Node reports a missing path as an `Error` carrying `code: 'ENOENT'`. */
function fileNotFound(filePath: string): Error {
  return Object.assign(
    new Error(`ENOENT: no such file or directory, open '${filePath}'`),
    {code: 'ENOENT'},
  );
}

/** Minimal environment double for ReadFileTool tests. */
class StubEnvironment extends BaseEnvironment {
  readonly executeCalls: string[] = [];

  constructor(private readonly files: Record<string, string>) {
    super();
  }

  override get workingDir(): string {
    return '/tmp/adk-test';
  }

  override async execute(command: string): Promise<ExecutionResult> {
    this.executeCalls.push(command);
    throw new Error('ReadFileTool should not invoke execute().');
  }

  override async readFile(filePath: string): Promise<Uint8Array> {
    const contents = this.files[filePath];
    if (contents === undefined) {
      throw fileNotFound(filePath);
    }
    return new TextEncoder().encode(contents);
  }

  override async writeFile(): Promise<void> {
    throw new Error('not implemented');
  }
}

it('test_read_file_with_line_range_uses_direct_file_read', async () => {
  const environment = new StubEnvironment({
    'notes.txt': 'alpha\nbeta\ngamma\ndelta\n',
  });

  const result = await new ReadFileTool(environment).runAsync({
    args: {path: 'notes.txt', start_line: 2, end_line: 3},
    toolContext: makeContext(),
  });

  expect(result).toEqual({
    status: 'ok',
    content: '     2\tbeta\n     3\tgamma\n',
    total_lines: 4,
  });
  expect(environment.executeCalls).toEqual([]);
});

it('test_read_file_with_line_range_treats_shell_payload_as_literal_path', async () => {
  const environment = new StubEnvironment({'safe.txt': 'line1\nline2\n'});
  const payload =
    '\'; python3 -c "from pathlib import Path;' +
    " Path('pwned.txt').write_text('owned')\"; echo '";

  const result = await new ReadFileTool(environment).runAsync({
    args: {path: payload, start_line: 1, end_line: 2},
    toolContext: makeContext(),
  });

  expect(result).toEqual({
    status: 'error',
    error: `File not found: ${payload}`,
  });
  expect(environment.executeCalls).toEqual([]);
});

describe('TestReadFileTool', () => {
  let tmpDir: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_read_file_test_'));
    env = new LocalEnvironment({workingDir: tmpDir});
    await env.initialize();
  });

  afterEach(async () => {
    await env.close();
    await fs.rm(tmpDir, {recursive: true, force: true});
  });

  it('test_read_file_with_line_range_returns_selected_lines', async () => {
    await env.writeFile('sample.txt', 'line1\nline2\nline3\n');

    const result = await new ReadFileTool(env).runAsync({
      args: {path: 'sample.txt', start_line: 2, end_line: 3},
      toolContext: makeContext(),
    });

    expect(result).toEqual({
      status: 'ok',
      content: '     2\tline2\n     3\tline3\n',
      total_lines: 3,
    });
  });

  it('test_read_file_with_line_range_missing_file_returns_error', async () => {
    const result = await new ReadFileTool(env).runAsync({
      args: {path: 'missing.txt', start_line: 2},
      toolContext: makeContext(),
    });

    expect(result).toEqual({
      status: 'error',
      error: 'File not found: missing.txt',
    });
  });

  it('test_read_file_rejects_non_integer_end_line', async () => {
    await env.writeFile('sample.txt', 'line1\nline2\n');
    const marker = path.join(env.workingDir, 'marker.txt');
    const injectedEndLine = `1'; touch ${marker}; echo '`;

    const result = await new ReadFileTool(env).runAsync({
      args: {path: 'sample.txt', end_line: injectedEndLine},
      toolContext: makeContext(),
    });

    expect(result).toEqual({
      status: 'error',
      error: '`end_line` must be an integer if provided.',
    });
    await expect(fs.access(marker)).rejects.toThrow();
  });

  it('test_read_file_rejects_boolean_line_numbers', async () => {
    await env.writeFile('sample.txt', 'line1\nline2\n');
    const tool = new ReadFileTool(env);

    const resultStart = await tool.runAsync({
      args: {path: 'sample.txt', start_line: true},
      toolContext: makeContext(),
    });
    const resultEnd = await tool.runAsync({
      args: {path: 'sample.txt', end_line: false},
      toolContext: makeContext(),
    });

    expect(resultStart).toEqual({
      status: 'error',
      error: '`start_line` must be an integer if provided.',
    });
    expect(resultEnd).toEqual({
      status: 'error',
      error: '`end_line` must be an integer if provided.',
    });
  });
});
