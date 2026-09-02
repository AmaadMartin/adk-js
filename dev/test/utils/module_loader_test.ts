/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {importUserModule} from '../../src/utils/module_loader.js';

/** The directories the loader compiled into, in the order it created them. */
const workDirs = vi.hoisted(() => [] as string[]);

// Only the record of the directory is added; the real one is still created.
vi.mock('../../src/utils/file_utils.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/file_utils.js')>();
  return {
    ...actual,
    async createTempDir(prefix: string) {
      const dir = await actual.createTempDir(prefix);
      workDirs.push(dir);
      return dir;
    },
  };
});

async function exists(dir: string): Promise<boolean> {
  return fs
    .stat(dir)
    .then(() => true)
    .catch(() => false);
}

describe('importUserModule', () => {
  let moduleDir: string;

  beforeEach(async () => {
    workDirs.length = 0;
    moduleDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-modules-'));
  });

  afterEach(async () => {
    await fs.rm(moduleDir, {recursive: true, force: true});
  });

  const writeModule = async (name: string, source: string) => {
    const filePath = path.join(moduleDir, name);
    await fs.writeFile(filePath, source, 'utf-8');
    return filePath;
  };

  it('imports a JavaScript module as it is', async () => {
    const filePath = await writeModule(
      'plain.mjs',
      'export const answer = 42;\n',
    );

    const exports = await importUserModule(filePath);

    expect(exports['answer']).toBe(42);
    expect(workDirs).toEqual([]);
  });

  it('compiles a TypeScript module before importing it', async () => {
    const filePath = await writeModule(
      'typed.ts',
      'const answer: number = 42;\nexport const value = `n=${answer}`;\n',
    );

    const exports = await importUserModule(filePath);

    expect(exports['value']).toBe('n=42');
  });

  it('removes the directory it compiled into', async () => {
    const filePath = await writeModule(
      'cleaned.ts',
      'export const value: string = "done";\n',
    );

    await importUserModule(filePath);

    expect(workDirs).toHaveLength(1);
    expect(await exists(workDirs[0])).toBe(false);
  });

  it('removes the directory it compiled into when the compilation fails', async () => {
    const filePath = await writeModule('broken.ts', 'export const = ;\n');

    await expect(importUserModule(filePath)).rejects.toThrow(Error);

    expect(workDirs).toHaveLength(1);
    expect(await exists(workDirs[0])).toBe(false);
  });

  it('rejects with an Error when the file does not exist', async () => {
    await expect(
      importUserModule(path.join(moduleDir, 'missing.mjs')),
    ).rejects.toThrow(Error);
  });
});
