/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * adk-python has no reference test file for this tool:
 * `tests/unittests/tools/environment/` on `main` holds only
 * `test_edit_file_tool.py` and `test_read_file_tool.py`. Every case below is
 * written for adk-js.
 */

import {
  BaseEnvironment,
  Context,
  createSession,
  ExecutionResult,
  InvocationContext,
  LocalEnvironment,
  PluginManager,
  WriteFileTool,
} from '@google/adk';
import {Type} from '@google/genai';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

const DESCRIPTION =
  'Create or overwrite a file in the environment. Use for new files or full ' +
  'rewrites. For small changes to existing files, prefer EditFile.';

/** Records every write, and fails loudly on the calls this tool must not make. */
class StubEnvironment extends BaseEnvironment {
  readonly writeCalls: Array<{
    filePath: string;
    content: string | Uint8Array;
  }> = [];

  constructor(private readonly writeRejection?: unknown) {
    super();
  }

  override get workingDir(): string {
    return '/tmp/adk-test';
  }

  override async execute(): Promise<ExecutionResult> {
    expect.fail('WriteFileTool must not call execute().');
  }

  override async readFile(): Promise<Uint8Array> {
    expect.fail('WriteFileTool must not call readFile().');
  }

  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.writeCalls.push({filePath, content});
    if (this.writeRejection !== undefined) {
      throw this.writeRejection;
    }
  }
}

/** A real `Context`; the tool ignores it, but `runAsync` requires one. */
function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
  });
}

describe('WriteFileTool', () => {
  it('exposes the reference name and description', () => {
    const tool = new WriteFileTool(new StubEnvironment());

    expect(tool.name).toBe('WriteFile');
    expect(tool.description).toBe(DESCRIPTION);
  });

  it('declares a path and a content argument', () => {
    const tool = new WriteFileTool(new StubEnvironment());

    expect(tool._getDeclaration()).toEqual({
      name: 'WriteFile',
      description: DESCRIPTION,
      parameters: {
        type: Type.OBJECT,
        properties: {
          path: {
            type: Type.STRING,
            description: 'Path to the file within the environment.',
          },
          content: {
            type: Type.STRING,
            description: 'The full file content to write.',
          },
        },
        required: ['path', 'content'],
      },
    });
  });

  it('writes the content through the environment', async () => {
    const environment = new StubEnvironment();
    const tool = new WriteFileTool(environment);

    const result = await tool.runAsync({
      args: {path: 'notes.txt', content: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'ok', message: 'Wrote notes.txt'});
    expect(environment.writeCalls).toEqual([
      {filePath: 'notes.txt', content: 'hello'},
    ]);
  });

  it('rejects a missing path without writing', async () => {
    const environment = new StubEnvironment();
    const tool = new WriteFileTool(environment);

    const result = await tool.runAsync({
      args: {content: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'error', error: '`path` is required.'});
    expect(environment.writeCalls).toEqual([]);
  });

  it('rejects an empty path without writing', async () => {
    const environment = new StubEnvironment();
    const tool = new WriteFileTool(environment);

    const result = await tool.runAsync({
      args: {path: '', content: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'error', error: '`path` is required.'});
    expect(environment.writeCalls).toEqual([]);
  });

  it('rejects a non-string path without writing', async () => {
    const environment = new StubEnvironment();
    const tool = new WriteFileTool(environment);

    const result = await tool.runAsync({
      args: {path: 42, content: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'error', error: '`path` is required.'});
    expect(environment.writeCalls).toEqual([]);
  });

  it('defaults a missing content to an empty file', async () => {
    const environment = new StubEnvironment();
    const tool = new WriteFileTool(environment);

    const result = await tool.runAsync({
      args: {path: 'empty.txt'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'ok', message: 'Wrote empty.txt'});
    expect(environment.writeCalls).toEqual([
      {filePath: 'empty.txt', content: ''},
    ]);
  });

  it('rejects a non-string content without writing', async () => {
    const environment = new StubEnvironment();
    const tool = new WriteFileTool(environment);

    const result = await tool.runAsync({
      args: {path: 'notes.txt', content: 42},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: 'error',
      error: '`content` must be a string.',
    });
    expect(environment.writeCalls).toEqual([]);
  });

  it('reports a rejected write as an error instead of throwing', async () => {
    const tool = new WriteFileTool(
      new StubEnvironment(new Error('permission denied')),
    );

    const result = await tool.runAsync({
      args: {path: 'notes.txt', content: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'error', error: 'permission denied'});
  });

  it('reports a rejection that is not an Error', async () => {
    const tool = new WriteFileTool(new StubEnvironment('disk full'));

    const result = await tool.runAsync({
      args: {path: 'notes.txt', content: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'error', error: 'disk full'});
  });
});

describe('WriteFileTool with a LocalEnvironment', () => {
  let workingDir: string;
  let environment: LocalEnvironment;
  let tool: WriteFileTool;

  beforeEach(async () => {
    workingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk_write_file_'));
    environment = new LocalEnvironment({workingDir});
    await environment.initialize();
    tool = new WriteFileTool(environment);
  });

  afterEach(async () => {
    await environment.close();
    await fs.rm(workingDir, {recursive: true, force: true});
  });

  it('creates the parent directories of a nested path', async () => {
    const result = await tool.runAsync({
      args: {path: 'a/b/c.txt', content: 'nested'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({status: 'ok', message: 'Wrote a/b/c.txt'});
    await expect(
      fs.readFile(path.join(workingDir, 'a/b/c.txt'), 'utf8'),
    ).resolves.toBe('nested');
  });

  it('truncates the file rather than appending on a second write', async () => {
    const toolContext = createToolContext();
    await tool.runAsync({
      args: {path: 'notes.txt', content: 'first write'},
      toolContext,
    });

    const result = await tool.runAsync({
      args: {path: 'notes.txt', content: 'second'},
      toolContext,
    });

    expect(result).toEqual({status: 'ok', message: 'Wrote notes.txt'});
    await expect(
      fs.readFile(path.join(workingDir, 'notes.txt'), 'utf8'),
    ).resolves.toBe('second');
  });

  it('writes CRLF line endings byte for byte', async () => {
    await tool.runAsync({
      args: {path: 'crlf.txt', content: 'one\r\ntwo\r\n'},
      toolContext: createToolContext(),
    });

    const written = await fs.readFile(path.join(workingDir, 'crlf.txt'));
    expect([...written]).toEqual([...Buffer.from('one\r\ntwo\r\n')]);
  });

  it('reports a path that escapes the working directory as an error', async () => {
    const result = await tool.runAsync({
      args: {path: '../escape.txt', content: 'nope'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: 'error',
      error: 'Path escapes working directory: ../escape.txt',
    });
    await expect(
      fs.access(path.join(workingDir, '..', 'escape.txt')),
    ).rejects.toThrow();
  });

  it('reports an uninitialised environment as an error', async () => {
    const result = await new WriteFileTool(new LocalEnvironment()).runAsync({
      args: {path: 'notes.txt', content: 'hello'},
      toolContext: createToolContext(),
    });

    expect(result).toEqual({
      status: 'error',
      error: 'Environment is not initialized. Call initialize() first.',
    });
  });
});
