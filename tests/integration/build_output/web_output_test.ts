/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';

const repoRoot = process.cwd();

/**
 * Matches an import of the Node `module` builtin, with or without the `node:`
 * protocol, so the check holds whichever specifier the build banner uses.
 */
const MODULE_BUILTIN_IMPORT = /from\s*['"](?:node:)?module['"]/;

/** Lists the emitted `.js` files under `dir`, relative to `dir`. */
async function listEmittedJs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, {recursive: true});
  return entries.filter((entry) => entry.endsWith('.js'));
}

describe.each(['core', 'integrations'])('%s browser build', (pkg: string) => {
  const webDir = path.join(repoRoot, pkg, 'dist', 'web');
  let emittedJs: string[];

  beforeAll(async () => {
    const stats = await fs.stat(webDir).catch(() => undefined);
    if (!stats?.isDirectory()) {
      expect.fail(`${webDir} is missing. Run \`npm run build\` first.`);
    }

    emittedJs = await listEmittedJs(webDir);
    if (emittedJs.length === 0) {
      expect.fail(`${webDir} holds no .js files. Run \`npm run build\` first.`);
    }
  });

  it('emits the entry point the package browser field resolves to', () => {
    expect(emittedJs).toContain('index_web.js');
  });

  it('never imports the Node module builtin', async () => {
    const offenders: string[] = [];
    for (const file of emittedJs) {
      const contents = await fs.readFile(path.join(webDir, file), 'utf8');
      if (MODULE_BUILTIN_IMPORT.test(contents)) {
        offenders.push(file);
      }
    }

    expect(offenders).toEqual([]);
  });
});

describe('core Node ESM build', () => {
  it('keeps the createRequire preamble', async () => {
    const contents = await fs.readFile(
      path.join(repoRoot, 'core', 'dist', 'esm', 'index.js'),
      'utf8',
    );

    expect(contents).toMatch(MODULE_BUILTIN_IMPORT);
  });
});
