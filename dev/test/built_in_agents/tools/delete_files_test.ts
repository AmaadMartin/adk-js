/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  deleteFiles,
  deleteFilesTool,
} from '../../../src/built_in_agents/tools/delete_files.js';
import {backupPathFor} from '../../../src/built_in_agents/utils/backup.js';
import {createTestContext, useTempDirs} from '../test_helpers.js';

describe('deleteFiles', () => {
  const tempDir = useTempDirs();

  afterEach(() => {
    vi.useRealTimers();
  });

  it('deletes a file and records the size it had', async () => {
    const root = await tempDir();
    const target = path.join(root, 'orphan.ts');
    await fs.writeFile(target, 'export {};');

    const result = await deleteFiles(
      {file_paths: ['orphan.ts']},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(true);
    expect(result.successful_deletions).toBe(1);
    expect(result.total_files).toBe(1);
    expect(result.files[target]).toEqual({
      existed: true,
      backup_created: false,
      backup_path: null,
      error: null,
      file_size: 10,
    });
    await expect(fs.stat(target)).rejects.toThrow(/ENOENT/);
  });

  it('counts a missing file as deleted and explains why', async () => {
    const root = await tempDir();
    const missing = path.join(root, 'gone.ts');

    const result = await deleteFiles(
      {file_paths: ['gone.ts']},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(true);
    expect(result.successful_deletions).toBe(1);
    expect(result.files[missing]).toEqual({
      existed: false,
      backup_created: false,
      backup_path: null,
      error: `File does not exist: ${missing}`,
      file_size: 0,
    });
  });

  it('deletes nothing when confirm_deletion is false', async () => {
    const root = await tempDir();
    const target = path.join(root, 'orphan.ts');
    await fs.writeFile(target, 'export {};');

    const result = await deleteFiles(
      {file_paths: ['orphan.ts'], confirm_deletion: false},
      createTestContext({root_directory: root}),
    );

    expect(result).toEqual({
      success: false,
      files: {},
      successful_deletions: 0,
      total_files: 1,
      errors: ['Deletion not confirmed by user'],
    });
    expect(await fs.readFile(target, 'utf-8')).toBe('export {};');
  });

  it('backs the file up before deleting it', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date(2026, 7, 14, 12, 0, 0));
    const root = await tempDir();
    const target = path.join(root, 'agent.yaml');
    await fs.writeFile(target, 'name: demo');

    const result = await deleteFiles(
      {file_paths: ['agent.yaml'], create_backup: true},
      createTestContext({root_directory: root}),
    );

    const backup = path.join(root, 'agent.backup_20260814_120000.yaml');
    expect(result.files[target].backup_created).toBe(true);
    expect(result.files[target].backup_path).toBe(backup);
    expect(await fs.readFile(backup, 'utf-8')).toBe('name: demo');
    await expect(fs.stat(target)).rejects.toThrow(/ENOENT/);
  });

  it('skips the delete when the backup fails', async () => {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date(2026, 7, 14, 12, 0, 0));
    const root = await tempDir();
    const target = path.join(root, 'agent.yaml');
    await fs.writeFile(target, 'name: demo');
    // A directory sitting on the backup path makes the copy fail.
    await fs.mkdir(backupPathFor(target, new Date()));

    const result = await deleteFiles(
      {file_paths: ['agent.yaml'], create_backup: true},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(false);
    expect(result.successful_deletions).toBe(0);
    expect(result.files[target].error).toMatch(/^Failed to create backup: /);
    expect(await fs.readFile(target, 'utf-8')).toBe('name: demo');
  });

  it('reports a deletion failure per file', async () => {
    const root = await tempDir();
    await fs.mkdir(path.join(root, 'sub'));

    const result = await deleteFiles(
      {file_paths: ['sub']},
      createTestContext({root_directory: root}),
    );

    expect(result.success).toBe(false);
    expect(result.successful_deletions).toBe(0);
    expect(result.files[path.join(root, 'sub')].error).toMatch(
      /^Deletion failed: /,
    );
    expect((await fs.stat(path.join(root, 'sub'))).isDirectory()).toBe(true);
  });

  it('refuses a traversal and leaves the file outside the root alone', async () => {
    const root = await tempDir();
    const outside = await tempDir();
    const victim = path.join(outside, 'victim.txt');
    await fs.writeFile(victim, 'bye');

    const result = await deleteFiles(
      {file_paths: [path.relative(root, victim)], confirm_deletion: true},
      createTestContext({root_directory: root}),
    );

    expect(result).toEqual({
      success: false,
      files: {},
      successful_deletions: 0,
      total_files: 1,
      errors: [expect.stringMatching(/^Delete operation failed: File path /)],
    });
    expect(await fs.readFile(victim, 'utf-8')).toBe('bye');
  });
});

describe('deleteFilesTool', () => {
  const tempDir = useTempDirs();

  it('asks for confirmation instead of deleting on the first call', async () => {
    const root = await tempDir();
    const target = path.join(root, 'orphan.ts');
    await fs.writeFile(target, 'export {};');
    const context = createTestContext({root_directory: root}, 'call-1');

    const result = await deleteFilesTool.runAsync({
      args: {file_paths: ['orphan.ts']},
      toolContext: context,
    });

    expect(result).toEqual({
      error: 'This tool call requires confirmation, please approve or reject.',
    });
    expect(context.actions.requestedToolConfirmations['call-1']).toBeDefined();
    expect(context.actions.skipSummarization).toBe(true);
    expect(await fs.readFile(target, 'utf-8')).toBe('export {};');
  });

  it('deletes once the user confirms', async () => {
    const root = await tempDir();
    const target = path.join(root, 'orphan.ts');
    await fs.writeFile(target, 'export {};');
    const context = createTestContext({root_directory: root});
    context.toolConfirmation = {hint: 'approve the delete', confirmed: true};

    const result = await deleteFilesTool.runAsync({
      args: {file_paths: ['orphan.ts']},
      toolContext: context,
    });

    expect(result).toMatchObject({success: true, successful_deletions: 1});
    await expect(fs.stat(target)).rejects.toThrow(/ENOENT/);
  });

  it('rejects the call when the user declines', async () => {
    const root = await tempDir();
    const target = path.join(root, 'orphan.ts');
    await fs.writeFile(target, 'export {};');
    const context = createTestContext({root_directory: root});
    context.toolConfirmation = {hint: 'approve the delete', confirmed: false};

    const result = await deleteFilesTool.runAsync({
      args: {file_paths: ['orphan.ts']},
      toolContext: context,
    });

    expect(result).toEqual({error: 'This tool call is rejected.'});
    expect(await fs.readFile(target, 'utf-8')).toBe('export {};');
  });
});
