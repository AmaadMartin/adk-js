/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

import {
  readFiles,
  readFilesTool,
} from '../../../src/built_in_agents/tools/read_files.js';
import {createTestContext, useTempDirs} from '../test_helpers.js';

describe('readFiles', () => {
  const tempDir = useTempDirs();

  it('reads several files with their content and size', async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, 'a.txt'), 'alpha');
    await fs.mkdir(path.join(root, 'sub'));
    await fs.writeFile(path.join(root, 'sub', 'b.txt'), 'bravo!');

    const result = await readFiles(
      {file_paths: ['a.txt', 'sub/b.txt']},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(true);
    expect(result.successful_reads).toBe(2);
    expect(result.total_files).toBe(2);
    expect(result.errors).toEqual([]);
    expect(result.files[path.join(root, 'a.txt')]).toEqual({
      content: 'alpha',
      file_size: 5,
      exists: true,
      error: null,
    });
    expect(result.files[path.join(root, 'sub', 'b.txt')].file_size).toBe(6);
  });

  it('reports a missing file without failing the batch', async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, 'a.txt'), 'alpha');
    const missing = path.join(root, 'gone.txt');

    const result = await readFiles(
      {file_paths: ['a.txt', 'gone.txt']},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(true);
    expect(result.successful_reads).toBe(1);
    expect(result.total_files).toBe(2);
    expect(result.files[missing]).toEqual({
      content: '',
      file_size: 0,
      exists: false,
      error: `File does not exist: ${missing}`,
    });
  });

  it('reports a directory as an unreadable file', async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, 'sub'));

    const result = await readFiles(
      {file_paths: ['sub']},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(false);
    expect(result.successful_reads).toBe(0);
    const info = result.files[path.join(root, 'sub')];
    expect(info.exists).toBe(true);
    expect(info.error).toMatch(
      new RegExp(`^Failed to read ${path.join(root, 'sub')}: `),
    );
  });

  it('reports invalid UTF-8 instead of substituting replacement characters', async () => {
    const root = await tempDir();
    const target = path.join(root, 'binary.bin');
    await fs.writeFile(target, Buffer.from([0xff, 0xfe, 0xff]));

    const result = await readFiles(
      {file_paths: ['binary.bin']},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(false);
    expect(result.files[target].content).toBe('');
    expect(result.files[target].error).toMatch(
      new RegExp(`^Failed to read ${target}: `),
    );
  });

  it('refuses a traversal and leaks nothing from outside the root', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const secret = path.join(outside, 'secret.txt');
    await fs.writeFile(secret, 'TOKEN=abc');

    const result = await readFiles(
      {file_paths: [path.relative(root, secret)]},
      createTestContext({root_directory: root}),
    );

    expect(result).toEqual({
      success: false,
      files: {},
      successful_reads: 0,
      total_files: 1,
      errors: [expect.stringMatching(/^Read operation failed: File path /)],
    });
    expect(JSON.stringify(result)).not.toContain('TOKEN=abc');
  });

  it('reads from the working directory when there is no context', async () => {
    const result = await readFiles({file_paths: ['package.json']});

    expect(result.success).toBe(true);
    expect(result.files[path.join(process.cwd(), 'package.json')].exists).toBe(
      true,
    );
  });
});

describe('readFilesTool', () => {
  const tempDir = useTempDirs();

  it('declares the name and arguments the model calls it with', () => {
    const declaration = readFilesTool._getDeclaration();

    expect(readFilesTool.name).toBe('read_files');
    expect(Object.keys(declaration.parameters?.properties ?? {})).toEqual([
      'file_paths',
    ]);
  });

  it('runs the read through the tool wrapper', async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, 'a.txt'), 'alpha');

    const result = await readFilesTool.runAsync({
      args: {file_paths: ['a.txt']},
      toolContext: createTestContext({root_directory: root}),
    });

    expect(result).toMatchObject({success: true, successful_reads: 1});
  });
});
