/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {describe, expect, it} from 'vitest';

import {
  backupPathFor,
  createBackup,
} from '../../../src/built_in_agents/utils/backup.js';
import {useTempDirs} from '../test_helpers.js';

const FROZEN_DATE = new Date(2026, 7, 14, 12, 0, 0);

describe('backupPathFor', () => {
  it.each([
    ['agent.yaml', 'agent.backup_20260814_120000.yaml'],
    ['notes', 'notes.backup_20260814_120000'],
    ['a.tar.gz', 'a.tar.backup_20260814_120000.gz'],
    // `path.extname('.env')` is empty, so a dotfile keeps its whole name.
    ['.env', '.env.backup_20260814_120000'],
  ])('puts the timestamp before the extension of %j', (name, expected) => {
    expect(backupPathFor(path.join('/project', name), FROZEN_DATE)).toBe(
      path.join('/project', expected),
    );
  });

  it('pads every field of the timestamp to a fixed width', () => {
    expect(backupPathFor('a.txt', new Date(2026, 0, 2, 3, 4, 5))).toBe(
      'a.backup_20260102_030405.txt',
    );
  });
});

describe('createBackup', () => {
  const tempDir = useTempDirs();

  it('copies the content to a timestamped sibling', async () => {
    const root = await tempDir();
    const source = path.join(root, 'agent.yaml');
    await fs.writeFile(source, 'name: demo');

    const backupPath = await createBackup(source);

    expect(path.basename(backupPath)).toMatch(
      /^agent\.backup_\d{8}_\d{6}\.yaml$/,
    );
    expect(await fs.readFile(backupPath, 'utf-8')).toBe('name: demo');
  });

  it('preserves the modification time of the source', async () => {
    const root = await tempDir();
    const source = path.join(root, 'agent.yaml');
    await fs.writeFile(source, 'name: demo');
    const past = new Date(2020, 0, 1, 0, 0, 0);
    await fs.utimes(source, past, past);

    const backupPath = await createBackup(source);

    expect((await fs.stat(backupPath)).mtime.getTime()).toBe(past.getTime());
  });

  it('rejects when the source cannot be copied', async () => {
    const root = await tempDir();

    await expect(createBackup(path.join(root, 'missing.yaml'))).rejects.toThrow(
      /ENOENT/,
    );
  });
});
