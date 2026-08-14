/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

import {
  cleanupUnusedFiles,
  cleanupUnusedFilesTool,
} from '../../../src/built_in_agents/tools/cleanup_unused_files.js';
import {createTestContext, useTempDirs, writeTree} from '../test_helpers.js';

/** Sorted project-relative spellings of the reported unused files. */
function unusedIn(root: string, unusedFiles: string[]): string[] {
  return unusedFiles.map((file) => path.relative(root, file)).sort();
}

describe('cleanupUnusedFiles', () => {
  const tempDir = useTempDirs();

  it('reports the Python files that nothing uses', async () => {
    const root = await tempDir();
    await writeTree(root, ['used.py', 'orphan.py', 'pkg/nested_orphan.py']);

    const result = await cleanupUnusedFiles(
      {used_files: ['used.py']},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(unusedIn(root, result.unused_files)).toEqual([
      'orphan.py',
      path.join('pkg', 'nested_orphan.py'),
    ]);
    expect(result.deleted_files).toEqual([]);
    expect(result.backup_files).toEqual([]);
    expect(result.total_freed_space).toBe(0);
  });

  it('applies the default exclusions', async () => {
    const root = await tempDir();
    await writeTree(root, [
      'orphan.py',
      '__init__.py',
      'widget_test.py',
      'test_widget.py',
      'notes.txt',
    ]);

    const result = await cleanupUnusedFiles(
      {used_files: []},
      createTestContext({root_directory: root}),
    );

    expect(unusedIn(root, result.unused_files)).toEqual(['orphan.py']);
  });

  it('honors custom file and exclude patterns', async () => {
    const root = await tempDir();
    await writeTree(root, ['a.yaml', 'b.yaml', 'keep.py', '__init__.py']);

    const result = await cleanupUnusedFiles(
      {
        used_files: ['a.yaml'],
        file_patterns: ['*.yaml'],
        exclude_patterns: [],
      },
      createTestContext({root_directory: root}),
    );

    expect(unusedIn(root, result.unused_files)).toEqual(['b.yaml']);
  });

  it('leaves a pattern that already starts with a globstar alone', async () => {
    const root = await tempDir();
    await writeTree(root, ['pkg/a.yaml', 'b.yaml']);

    const result = await cleanupUnusedFiles(
      {used_files: [], file_patterns: ['**/*.yaml'], exclude_patterns: []},
      createTestContext({root_directory: root}),
    );

    expect(unusedIn(root, result.unused_files)).toEqual([
      'b.yaml',
      path.join('pkg', 'a.yaml'),
    ]);
  });

  it('matches a used file spelled a different way', async () => {
    const root = await tempDir();
    await writeTree(root, ['pkg/tool.py']);

    const result = await cleanupUnusedFiles(
      {used_files: ['./pkg/../pkg/tool.py']},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(true);
    expect(result.unused_files).toEqual([]);
  });

  it('scans hidden files, which pathlib also matches', async () => {
    const root = await tempDir();
    await writeTree(root, ['.hidden/orphan.py']);

    const result = await cleanupUnusedFiles(
      {used_files: []},
      createTestContext({root_directory: root}),
    );

    expect(unusedIn(root, result.unused_files)).toEqual([
      path.join('.hidden', 'orphan.py'),
    ]);
  });

  it('does not report a directory named like a source file', async () => {
    const root = await tempDir();
    await writeTree(root, ['looks_like.py/inner.txt']);

    const result = await cleanupUnusedFiles(
      {used_files: []},
      createTestContext({root_directory: root}),
    );

    expect(result.unused_files).toEqual([]);
  });

  it('reports a missing root directory', async () => {
    const root = await tempDir();
    const missing = path.join(root, 'does_not_exist');

    const result = await cleanupUnusedFiles(
      {used_files: []},
      createTestContext({root_directory: missing}),
    );

    expect(result).toEqual({
      success: false,
      unused_files: [],
      deleted_files: [],
      backup_files: [],
      errors: [`Root directory does not exist: ${missing}`],
      total_freed_space: 0,
    });
  });

  it('fails closed when a used file escapes the root', async () => {
    const root = await tempDir();
    await writeTree(root, ['orphan.py']);

    const result = await cleanupUnusedFiles(
      {used_files: ['../outside.py']},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(false);
    expect(result.unused_files).toEqual([]);
    expect(result.errors).toEqual([
      expect.stringMatching(/^Cleanup scan failed: File path /),
    ]);
  });
});

describe('cleanupUnusedFilesTool', () => {
  const tempDir = useTempDirs();

  it('scans through the tool wrapper', async () => {
    const root = await tempDir();
    await writeTree(root, ['orphan.py']);

    const result = await cleanupUnusedFilesTool.runAsync({
      args: {used_files: []},
      toolContext: createTestContext({root_directory: root}),
    });

    expect(result).toMatchObject({
      success: true,
      unused_files: [path.join(root, 'orphan.py')],
    });
  });
});
