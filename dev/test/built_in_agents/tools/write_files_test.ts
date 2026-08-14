/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  writeFiles,
  writeFilesTool,
} from '../../../src/built_in_agents/tools/write_files.js';
import {backupPathFor} from '../../../src/built_in_agents/utils/backup.js';
import {createTestContext, useTempDirs} from '../test_helpers.js';

describe('writeFiles', () => {
  const tempDir = useTempDirs();

  afterEach(() => {
    vi.useRealTimers();
  });

  it('creates missing parent directories and reports the written size', async () => {
    const root = await tempDir();

    const result = await writeFiles(
      {files: {'tools/search.ts': '// search'}},
      createTestContext({root_directory: root}),
    );

    const target = path.join(root, 'tools', 'search.ts');
    expect(result.success).toBe(true);
    expect(result.successful_writes).toBe(1);
    expect(result.total_files).toBe(1);
    expect(result.files[target]).toEqual({
      file_size: 9,
      existed_before: false,
      backup_created: false,
      backup_path: null,
      error: null,
    });
    expect(await fs.readFile(target, 'utf-8')).toBe('// search');
  });

  it('records existed_before when it overwrites a file', async () => {
    const root = await tempDir();
    const target = path.join(root, 'agent.yaml');
    await fs.writeFile(target, 'name: old');

    const result = await writeFiles(
      {files: {'agent.yaml': 'name: new'}},
      createTestContext({root_directory: root}),
    );

    expect(result.files[target].existed_before).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toBe('name: new');
  });

  it('fails a single file when create_directories is false', async () => {
    const root = await tempDir();

    const result = await writeFiles(
      {files: {'missing/a.txt': 'x', 'ok.txt': 'y'}, create_directories: false},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(false);
    expect(result.successful_writes).toBe(1);
    expect(result.files[path.join(root, 'missing', 'a.txt')].error).toMatch(
      /^Write failed: /,
    );
    expect(await fs.readFile(path.join(root, 'ok.txt'), 'utf-8')).toBe('y');
  });

  it.each([
    ['agent.yaml', 'agent.backup_20260814_120000.yaml'],
    ['notes', 'notes.backup_20260814_120000'],
    ['a.tar.gz', 'a.tar.backup_20260814_120000.gz'],
  ])('backs %j up as %j before overwriting it', async (name, backupName) => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date(2026, 7, 14, 12, 0, 0));
    const root = await tempDir();
    const target = path.join(root, name);
    await fs.writeFile(target, 'original');

    const result = await writeFiles(
      {files: {[name]: 'replacement'}, create_backup: true},
      createTestContext({root_directory: root}),
    );

    expect(result.files[target].backup_created).toBe(true);
    expect(result.files[target].backup_path).toBe(path.join(root, backupName));
    expect(await fs.readFile(path.join(root, backupName), 'utf-8')).toBe(
      'original',
    );
    expect(await fs.readFile(target, 'utf-8')).toBe('replacement');
  });

  it('writes no backup when create_backup is false', async () => {
    const root = await tempDir();
    await fs.writeFile(path.join(root, 'agent.yaml'), 'original');

    const result = await writeFiles(
      {files: {'agent.yaml': 'replacement'}},
      createTestContext({root_directory: root}),
    );

    expect(result.files[path.join(root, 'agent.yaml')].backup_created).toBe(
      false,
    );
    expect(await fs.readdir(root)).toEqual(['agent.yaml']);
  });

  it('skips the write when the backup fails', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date(2026, 7, 14, 12, 0, 0));
    const root = await tempDir();
    const target = path.join(root, 'agent.yaml');
    await fs.writeFile(target, 'original');
    // A directory sitting on the backup path makes the copy fail.
    await fs.mkdir(backupPathFor(target, new Date()));

    const result = await writeFiles(
      {files: {'agent.yaml': 'replacement'}, create_backup: true},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(false);
    expect(result.successful_writes).toBe(0);
    expect(result.files[target].backup_created).toBe(false);
    expect(result.files[target].error).toMatch(/^Failed to create backup: /);
    expect(await fs.readFile(target, 'utf-8')).toBe('original');
  });

  it('refuses a relative traversal and writes nothing outside the root', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const target = path.join(outside, 'pwned.txt');

    const result = await writeFiles(
      {files: {[path.relative(root, target)]: 'PWNED'}},
      createTestContext({root_directory: root}),
    );

    expect(result).toEqual({
      success: false,
      files: {},
      successful_writes: 0,
      total_files: 1,
      errors: [expect.stringMatching(/^Write operation failed: File path /)],
    });
    await expect(fs.stat(target)).rejects.toThrow(/ENOENT/);
  });

  it('refuses an absolute path outside the root', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const target = path.join(outside, 'abs.txt');

    const result = await writeFiles(
      {files: {[target]: 'PWNED'}},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(false);
    await expect(fs.stat(target)).rejects.toThrow(/ENOENT/);
  });

  it('creates no package marker next to a written Python file', async () => {
    const root = await tempDir();

    const result = await writeFiles(
      {files: {'tools/search.py': '# search'}},
      createTestContext({root_directory: root}),
    );

    expect(
      Object.keys(result.files[path.join(root, 'tools', 'search.py')])
        // The reference reports `package_inits_created`; this port does not.
        .sort(),
    ).toEqual([
      'backup_created',
      'backup_path',
      'error',
      'existed_before',
      'file_size',
    ]);
    expect(await fs.readdir(root)).toEqual(['tools']);
    expect(await fs.readdir(path.join(root, 'tools'))).toEqual(['search.py']);
  });
});

describe('writeFilesTool', () => {
  const tempDir = useTempDirs();

  it('writes through the tool wrapper', async () => {
    const root = await tempDir();

    const result = await writeFilesTool.runAsync({
      args: {files: {'a.txt': 'alpha'}},
      toolContext: createTestContext({root_directory: root}),
    });

    expect(result).toMatchObject({success: true, successful_writes: 1});
    expect(await fs.readFile(path.join(root, 'a.txt'), 'utf-8')).toBe('alpha');
  });
});
