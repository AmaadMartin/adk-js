/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseEnvironment,
  ExecutionResult,
  LocalEnvironment,
  WriteFileTool,
} from '@google/adk';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {makeContext} from './environment_test_utils.js';

/** Environment double whose `writeFile` always rejects. */
class UnwritableEnvironment extends BaseEnvironment {
  override get workingDir(): string {
    return '/workspace';
  }

  override async execute(): Promise<ExecutionResult> {
    throw new Error('not implemented');
  }

  override async readFile(): Promise<Uint8Array> {
    throw new Error('not implemented');
  }

  override async writeFile(): Promise<void> {
    throw new Error('read-only filesystem');
  }
}

describe('WriteFileTool', () => {
  let tmpDir: string;
  let env: LocalEnvironment;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_write_file_test_'));
    env = new LocalEnvironment({workingDir: tmpDir});
    await env.initialize();
  });

  afterEach(async () => {
    await env.close();
    await fs.rm(tmpDir, {recursive: true, force: true});
  });

  it('rejects a missing path', async () => {
    const result = await new WriteFileTool(env).runAsync({
      args: {content: 'hi'},
      toolContext: makeContext(),
    });
    expect(result).toEqual({status: 'error', error: '`path` is required.'});
  });

  it('writes the content to the environment', async () => {
    const result = await new WriteFileTool(env).runAsync({
      args: {path: 'nested/out.txt', content: 'hello\n'},
      toolContext: makeContext(),
    });

    expect(result).toEqual({status: 'ok', message: 'Wrote nested/out.txt'});
    expect(
      await fs.readFile(path.join(tmpDir, 'nested/out.txt'), 'utf-8'),
    ).toBe('hello\n');
  });

  it('writes an empty file when content is omitted', async () => {
    const result = await new WriteFileTool(env).runAsync({
      args: {path: 'empty.txt'},
      toolContext: makeContext(),
    });

    expect(result).toEqual({status: 'ok', message: 'Wrote empty.txt'});
    expect(await fs.readFile(path.join(tmpDir, 'empty.txt'), 'utf-8')).toBe('');
  });

  it('reports a rejected writeFile call', async () => {
    const result = await new WriteFileTool(
      new UnwritableEnvironment(),
    ).runAsync({
      args: {path: 'f.txt', content: 'x'},
      toolContext: makeContext(),
    });
    expect(result).toEqual({
      status: 'error',
      error: 'read-only filesystem',
    });
  });

  it('reports a path that escapes the working directory', async () => {
    const result = await new WriteFileTool(env).runAsync({
      args: {path: '../escape.txt', content: 'x'},
      toolContext: makeContext(),
    });
    expect(result).toEqual({
      status: 'error',
      error: 'Path escapes working directory: ../escape.txt',
    });
  });

  it('declares both arguments as required', () => {
    const declaration = new WriteFileTool(env)._getDeclaration();
    expect(declaration.name).toBe('WriteFile');
    expect(declaration.parameters?.required).toEqual(['path', 'content']);
  });
});
