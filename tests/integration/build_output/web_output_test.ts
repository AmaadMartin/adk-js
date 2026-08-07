/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {beforeAll, describe, expect, it} from 'vitest';

const repoRoot = process.cwd();

const CORE_WEB_DIR = 'core/dist/web';
const INTEGRATIONS_WEB_DIR = 'integrations/dist/web';

/**
 * The emitted browser builds. Neither may call `require`, and neither may
 * declare it: the two halves have to hold together, because a surviving
 * `createRequire` banner would let a down-levelled call resolve and hide the
 * defect.
 */
const WEB_DIRS = [CORE_WEB_DIR, INTEGRATIONS_WEB_DIR];

/**
 * Matches an import of the Node `module` builtin, with or without the `node:`
 * protocol, so the check holds whichever specifier the build banner uses.
 */
const MODULE_BUILTIN_IMPORT = /from\s*['"](?:node:)?module['"]/;

/** The alias the esbuild `createRequire` banner binds `require` to. */
const REQUIRE_BANNER = 'topLevelCreateRequire';

/** esbuild's interop wrapper for a down-levelled `await import(...)`. */
const DOWN_LEVELLED_IMPORT = '__toESM(require(';

/** The module holding the lazy MikroORM driver imports, in every build. */
const OPERATIONS_MODULE = 'sessions/db/operations.js';

/** The MikroORM drivers `core/src/sessions/db/operations.ts` imports lazily. */
const DRIVERS = ['postgresql', 'mysql', 'mariadb', 'sqlite', 'mssql'];

/** Captures the driver name of a native `await import('@mikro-orm/...')`. */
const NATIVE_DRIVER_IMPORT = /await import\("@mikro-orm\/([^"]+)"\)/g;

/**
 * The only emitted browser file allowed to contain `require(`. It assembles the
 * source text of a Node wrapper script, so its occurrences are string literals
 * rather than calls.
 */
const REQUIRE_LITERAL_FILE = 'tools/skill/run_skill_script_tool.js';

/** Resolves a POSIX path relative to the repo root against the filesystem. */
function absolute(relativePath: string): string {
  return path.join(repoRoot, ...relativePath.split('/'));
}

/** Lists the emitted `.js` files under `dir`, as POSIX paths relative to it. */
async function listEmittedJs(dir: string): Promise<string[]> {
  const entries = await fs.readdir(absolute(dir), {recursive: true});
  return entries
    .filter((entry) => entry.endsWith('.js'))
    .map((entry) => entry.split(path.sep).join('/'));
}

/** Reads a built file addressed by its POSIX path relative to the repo root. */
function readBuilt(relativePath: string): Promise<string> {
  return fs.readFile(absolute(relativePath), 'utf8');
}

/** Returns the emitted files under `dir` whose contents match `needle`. */
async function filesContaining(
  dir: string,
  needle: string | RegExp,
): Promise<string[]> {
  const offenders: string[] = [];
  for (const file of await listEmittedJs(dir)) {
    const contents = await readBuilt(`${dir}/${file}`);
    const found =
      typeof needle === 'string'
        ? contents.includes(needle)
        : needle.test(contents);
    if (found) {
      offenders.push(file);
    }
  }
  return offenders;
}

/** Counts the non-overlapping occurrences of `needle` in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

describe.each(WEB_DIRS)('%s', (webDir) => {
  let emittedJs: string[];

  beforeAll(async () => {
    const stats = await fs.stat(absolute(webDir)).catch(() => undefined);
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
    expect(await filesContaining(webDir, MODULE_BUILTIN_IMPORT)).toEqual([]);
  });

  it('declares no require binding', async () => {
    expect(await filesContaining(webDir, REQUIRE_BANNER)).toEqual([]);
  });

  it('emits no down-levelled import', async () => {
    expect(await filesContaining(webDir, DOWN_LEVELLED_IMPORT)).toEqual([]);
  });
});

describe('browser build dynamic import', () => {
  it('imports the MikroORM drivers natively in the browser build', async () => {
    const emitted = await readBuilt(`${CORE_WEB_DIR}/${OPERATIONS_MODULE}`);
    const nativeImports = [...emitted.matchAll(NATIVE_DRIVER_IMPORT)].map(
      (match) => match[1],
    );

    expect(nativeImports).toEqual(DRIVERS);
    expect(countOccurrences(emitted, 'require(')).toBe(0);
  });

  it('leaves require( in the browser build only as a string literal', async () => {
    expect(await filesContaining(CORE_WEB_DIR, 'require(')).toEqual([
      REQUIRE_LITERAL_FILE,
    ]);
    expect(await filesContaining(INTEGRATIONS_WEB_DIR, 'require(')).toEqual([]);
  });
});

describe('core Node builds', () => {
  it('keeps the createRequire preamble', async () => {
    expect(await readBuilt('core/dist/esm/index.js')).toMatch(
      MODULE_BUILTIN_IMPORT,
    );
  });

  // The Node targets declare node10.4, which predates dynamic import, and the
  // createRequire banner exists to make the down-levelled calls resolve. This
  // fails if `supported` is ever set for every platform instead of the browser.
  it.each(['esm', 'cjs'])(
    'keeps the down-levelled imports in core/dist/%s',
    async (dir) => {
      const emitted = await readBuilt(`core/dist/${dir}/${OPERATIONS_MODULE}`);

      expect(countOccurrences(emitted, DOWN_LEVELLED_IMPORT)).toBe(
        DRIVERS.length,
      );
    },
  );
});
