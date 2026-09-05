/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BaseEnvironment, EditFileTool, ExecutionResult} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {makeContext} from './environment_test_utils.js';

/** Environment double holding one in-memory file. */
class MemoryEnvironment extends BaseEnvironment {
  constructor(
    private contents: string | undefined,
    private readonly readFailure?: Error,
  ) {
    super();
  }

  get file(): string | undefined {
    return this.contents;
  }

  override get workingDir(): string {
    return '/workspace';
  }

  override async execute(): Promise<ExecutionResult> {
    throw new Error('not implemented');
  }

  override async readFile(): Promise<Uint8Array> {
    if (this.readFailure) {
      throw this.readFailure;
    }
    if (this.contents === undefined) {
      throw Object.assign(new Error('ENOENT: no such file'), {code: 'ENOENT'});
    }
    return new TextEncoder().encode(this.contents);
  }

  override async writeFile(
    filePath: string,
    content: string | Uint8Array,
  ): Promise<void> {
    this.contents =
      typeof content === 'string' ? content : new TextDecoder().decode(content);
  }
}

async function edit(
  environment: MemoryEnvironment,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return (await new EditFileTool(environment).runAsync({
    args: {path: 'f.txt', ...args},
    toolContext: makeContext(),
  })) as Record<string, unknown>;
}

describe('EditFileTool', () => {
  it('rejects a missing path', async () => {
    const environment = new MemoryEnvironment('a');
    expect(await edit(environment, {path: undefined})).toEqual({
      status: 'error',
      error: '`path` is required.',
    });
  });

  it('rejects an empty old_string', async () => {
    const environment = new MemoryEnvironment('a');
    expect(await edit(environment, {old_string: '', new_string: 'b'})).toEqual({
      status: 'error',
      error:
        '`old_string` cannot be empty. To create a new file, use the WriteFile tool.',
    });
  });

  it('reports a missing file', async () => {
    const environment = new MemoryEnvironment(undefined);
    expect(await edit(environment, {old_string: 'a', new_string: 'b'})).toEqual(
      {status: 'error', error: 'File not found: f.txt'},
    );
  });

  it('reports an old_string that is absent from the file', async () => {
    const environment = new MemoryEnvironment('hello');
    expect(
      await edit(environment, {old_string: 'world', new_string: 'b'}),
    ).toEqual({
      status: 'error',
      error:
        '`old_string` not found in file. Read the file first to verify contents.',
    });
  });

  it('propagates a read failure that is not a missing file', async () => {
    const environment = new MemoryEnvironment('a', new Error('disk on fire'));
    await expect(
      edit(environment, {old_string: 'a', new_string: 'b'}),
    ).rejects.toThrow('disk on fire');
  });

  it('writes `$&` and `$1` in new_string literally', async () => {
    const environment = new MemoryEnvironment('before TARGET after');

    const result = await edit(environment, {
      old_string: 'TARGET',
      new_string: '[$& and $1 and $`]',
    });

    expect(result).toEqual({status: 'ok', message: 'Edited f.txt'});
    expect(environment.file).toBe('before [$& and $1 and $`] after');
  });

  it('escapes regex metacharacters in old_string', async () => {
    const environment = new MemoryEnvironment('x a.b(c)$d y');

    const result = await edit(environment, {
      old_string: 'a.b(c)$d',
      new_string: 'REPLACED',
    });

    expect(result).toEqual({status: 'ok', message: 'Edited f.txt'});
    expect(environment.file).toBe('x REPLACED y');
  });

  it('does not treat a metacharacter pattern as a wildcard match', async () => {
    const environment = new MemoryEnvironment('xayb');
    expect(
      await edit(environment, {old_string: 'a.b', new_string: 'Z'}),
    ).toEqual({
      status: 'error',
      error:
        '`old_string` not found in file. Read the file first to verify contents.',
    });
    expect(environment.file).toBe('xayb');
  });

  it('matches a bare CR line ending in the file', async () => {
    const environment = new MemoryEnvironment('a\rb\nc');
    expect(
      await edit(environment, {old_string: 'a\rb', new_string: 'Z'}),
    ).toEqual({status: 'ok', message: 'Edited f.txt'});
    expect(environment.file).toBe('Z\nc');
  });

  it('defaults new_string to the empty string, deleting the match', async () => {
    const environment = new MemoryEnvironment('keep DROP keep');
    expect(await edit(environment, {old_string: ' DROP'})).toEqual({
      status: 'ok',
      message: 'Edited f.txt',
    });
    expect(environment.file).toBe('keep keep');
  });

  it('declares all three arguments as required', () => {
    const declaration = new EditFileTool(
      new MemoryEnvironment('a'),
    )._getDeclaration();
    expect(declaration.name).toBe('EditFile');
    expect(declaration.parameters?.required).toEqual([
      'path',
      'old_string',
      'new_string',
    ]);
  });
});
