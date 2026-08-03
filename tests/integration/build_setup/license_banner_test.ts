/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the Apache-2.0 header as the first bytes of every artifact the build
 * scripts emit. The scripts resolve `./src` and `./dist` against the process
 * cwd, so running one from a scratch directory exercises the real, unmodified
 * script without touching the repo's own `dist` trees.
 */

import {execFile} from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const execFileAsync = promisify(execFile);
const dirname = process.cwd();

/**
 * Budget (ms) for the `beforeAll` hook. esbuild itself finishes in tens of
 * milliseconds; the variable cost is spawning a Node process on a loaded CI
 * runner, which the `windows-latest` leg makes the worst case.
 */
const HOOK_TIMEOUT = 60000;

/**
 * Whitespace-tolerant so a later reformat of the banner literal does not have
 * to be mirrored here. Anchored, because the point of the assertion is that
 * the header comes *first*.
 */
const LICENSE_HEADER =
  /^\/\*\*\s*\n\s*\* @license\s*\n\s*\* Copyright \d{4} Google LLC\s*\n\s*\* SPDX-License-Identifier: Apache-2\.0\s*\n\s*\*\//;

const SOURCE_FILE = `/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
export const hello = 1;
`;

describe('License banner', () => {
  describe.each([
    ['core', 'core/build.js'],
    ['integrations', 'integrations/build.js'],
  ])('%s', (_workspace: string, buildScript: string) => {
    let tempDir: string;

    beforeAll(async () => {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-license-banner-'));
      await fs.mkdir(path.join(tempDir, 'src'));
      await fs.writeFile(path.join(tempDir, 'src', 'index.ts'), SOURCE_FILE);
      await fs.writeFile(
        path.join(tempDir, 'src', 'index_web.ts'),
        SOURCE_FILE,
      );

      await execFileAsync('node', [path.join(dirname, buildScript)], {
        cwd: tempDir,
      });
    }, HOOK_TIMEOUT);

    afterAll(async () => {
      await fs.rm(tempDir, {recursive: true, force: true});
    });

    it.each(['esm/index.js', 'web/index_web.js', 'cjs/index.js'])(
      'starts dist/%s with the license header',
      async (artifact: string) => {
        const contents = await fs.readFile(
          path.join(tempDir, 'dist', artifact),
          'utf8',
        );

        expect(contents).toMatch(LICENSE_HEADER);
      },
    );

    it.each(['esm/index.js', 'web/index_web.js'])(
      'keeps the createRequire shim in dist/%s',
      async (artifact: string) => {
        const contents = await fs.readFile(
          path.join(tempDir, 'dist', artifact),
          'utf8',
        );

        expect(contents).toContain('topLevelCreateRequire');
      },
    );
  });
});
