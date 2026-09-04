/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemorySessionService} from '@google/adk';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';
import {importModuleFile} from '../../src/utils/module_utils.js';

/**
 * Records the URL the module is running from.
 *
 * The test runner can import TypeScript on its own, so a fixture that only
 * proves "the code ran" would pass whether or not esbuild transpiled it. The
 * URL names the file that actually executed, which does distinguish them.
 */
const RECORD_OWN_URL = (recordPath: string) =>
  `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(recordPath)}, import.meta.url);
`;

describe('importModuleFile', () => {
  let dir: string;
  let recordPath: string;

  const write = (name: string, contents: string): string => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, contents);
    return target;
  };

  const transpiledFiles = (): string[] =>
    fs.readdirSync(dir).filter((name) => name.endsWith('.mjs'));

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-module-utils-'));
    recordPath = path.join(dir, 'ran-from.txt');
  });

  afterEach(() => {
    fs.rmSync(dir, {recursive: true, force: true});
  });

  it('imports a JavaScript module without transpiling it', async () => {
    const filePath = write('plain.js', RECORD_OWN_URL(recordPath));

    await importModuleFile(filePath);

    expect(fs.readFileSync(recordPath, 'utf-8')).toMatch(/plain\.js$/);
    expect(transpiledFiles()).toEqual([]);
  });

  it('returns the exports of the module it imported', async () => {
    const filePath = write('exporting.js', 'export const answer = 42;\n');

    const module = await importModuleFile(filePath);

    expect(module).toMatchObject({answer: 42});
  });

  it('runs a TypeScript module from a transpiled JavaScript file', async () => {
    const filePath = write(
      'typed.ts',
      `${RECORD_OWN_URL(recordPath)}
enum Loaded {
  Yes = 'yes',
}
export const loaded: Loaded = Loaded.Yes;
`,
    );

    const module = await importModuleFile(filePath);

    expect(fs.readFileSync(recordPath, 'utf-8')).toMatch(/\.mjs$/);
    expect(module).toMatchObject({loaded: 'yes'});
  });

  it('resolves a sibling that TypeScript imports under its .js name', async () => {
    write('sibling.ts', 'export const greeting: string = "hello";\n');
    const filePath = write(
      'importer.ts',
      `import {greeting} from './sibling.js';
export const echoed: string = greeting;
`,
    );

    const module = await importModuleFile(filePath);

    expect(module).toMatchObject({echoed: 'hello'});
  });

  it('leaves an imported package for the runtime to resolve', async () => {
    const filePath = write(
      'packaged.ts',
      `import {InMemorySessionService} from '@google/adk';
export const service: object = new InMemorySessionService();
`,
    );

    const module = await importModuleFile(filePath);

    expect(module).toMatchObject({
      service: expect.any(InMemorySessionService),
    });
  });

  it('removes the transpiled file once the import is done', async () => {
    const filePath = write('typed.ts', 'export const x: number = 1;\n');

    await importModuleFile(filePath);

    expect(transpiledFiles()).toEqual([]);
  });

  it('removes the transpiled file when the module throws', async () => {
    const filePath = write(
      'throwing.ts',
      'const reason: string = "boom";\nthrow new Error(reason);\n',
    );

    await expect(importModuleFile(filePath)).rejects.toThrowError('boom');
    expect(transpiledFiles()).toEqual([]);
  });

  it('reports a TypeScript module that does not compile', async () => {
    const filePath = write('broken.ts', 'const broken: = ;\n');

    await expect(importModuleFile(filePath)).rejects.toThrowError();
    expect(transpiledFiles()).toEqual([]);
  });
});
