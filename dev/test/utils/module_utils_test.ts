/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Real files, real esbuild, real dynamic import: nothing here is mocked,
// because compiling and importing is the whole of what the module does.

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {createTempDir} from '../../src/utils/file_utils.js';
import {importModuleFile} from '../../src/utils/module_utils.js';

describe('importModuleFile', () => {
  let dir = '';

  beforeEach(async () => {
    dir = await createTempDir('adk_module_utils_test');
  });

  afterEach(async () => {
    await fs.rm(dir, {recursive: true, force: true});
  });

  async function write(name: string, contents: string): Promise<string> {
    const filePath = path.join(dir, name);
    await fs.writeFile(filePath, contents, {encoding: 'utf-8'});
    return filePath;
  }

  it('imports a JavaScript file without compiling it', async () => {
    const filePath = await write('plain.js', 'export const value = "js";\n');

    expect(await importModuleFile(filePath)).toMatchObject({value: 'js'});
  });

  it('imports an .mjs file', async () => {
    const filePath = await write('plain.mjs', 'export const value = "mjs";\n');

    expect(await importModuleFile(filePath)).toMatchObject({value: 'mjs'});
  });

  it('compiles and imports a TypeScript file', async () => {
    const filePath = await write(
      'typed.ts',
      `export interface Shape {
         value: string;
       }
       export const shape: Shape = {value: 'ts'};
      `,
    );

    expect(await importModuleFile(filePath)).toMatchObject({
      shape: {value: 'ts'},
    });
  });

  it('compiles a .cts file to CommonJS', async () => {
    const filePath = await write(
      'legacy.cts',
      `const value: string = 'cts';
       module.exports = {value};
      `,
    );

    const exported = await importModuleFile(filePath);

    expect(exported['default']).toMatchObject({value: 'cts'});
  });

  it('runs a JavaScript file once however often it is imported', async () => {
    const marker = path.join(dir, 'runs.txt');
    const filePath = await write(
      'counting.js',
      `import * as fs from 'node:fs';
       fs.appendFileSync(${JSON.stringify(marker)}, 'x');
      `,
    );

    await importModuleFile(filePath);
    await importModuleFile(filePath);

    expect(await fs.readFile(marker, 'utf-8')).toBe('x');
  });

  it('propagates the failure of a file that throws', async () => {
    const filePath = await write('boom.ts', 'throw new Error("boom");\n');

    await expect(importModuleFile(filePath)).rejects.toThrow('boom');
  });

  it('removes its output directory even when the import throws', async () => {
    const before = await fs.readdir(os.tmpdir());
    const filePath = await write('boom.ts', 'throw new Error("boom");\n');

    await expect(importModuleFile(filePath)).rejects.toThrow('boom');

    const after = await fs.readdir(os.tmpdir());
    const leaked = after.filter(
      (entry) =>
        entry.startsWith('adk_module_utils-') && !before.includes(entry),
    );
    expect(leaked).toEqual([]);
  });

  it('reports a file that does not exist', async () => {
    await expect(
      importModuleFile(path.join(dir, 'absent.ts')),
    ).rejects.toThrow();
  });
});
