/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the `createRequire` banner on the *published* artifacts rather than on
 * the build script that emits it, so the assertion still holds if the banner
 * moves, is rewritten, or stops being emitted at all.
 *
 * Requires `npm run build` to have run first -- the same precondition the rest
 * of the `integration` project already has, since the build_setup fixtures
 * resolve `@google/adk` and `@google/adk-devtools` through their `dist`
 * directories. CI runs `npm run build` before the test step.
 */

import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const dirname = process.cwd();

const EXPECTED_BANNER_FIRST_LINE =
  "import {createRequire as topLevelCreateRequire} from 'node:module';";

describe.each(['core', 'integrations'])('%s ESM build banner', (pkg) => {
  it.each(['esm', 'web'])(
    'prefixes the createRequire import with node: in dist/%s',
    async (target) => {
      const source = await readFile(
        join(dirname, pkg, 'dist', target, 'index.js'),
        'utf8',
      );

      expect(source.split('\n')[0]).toBe(EXPECTED_BANNER_FIRST_LINE);
    },
  );

  it('does not inject the createRequire banner into the cjs target', async () => {
    const source = await readFile(
      join(dirname, pkg, 'dist', 'cjs', 'index.js'),
      'utf8',
    );

    expect(source).not.toContain('topLevelCreateRequire');
  });
});
