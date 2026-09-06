/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins the module specifier in the `createRequire` banner that the build
 * scripts inject into every emitted ESM and web artifact. The specifier lives
 * inside a template literal in a build script, so it is plain text to ESLint
 * rather than an `ImportDeclaration`, and no lint rule can guard it; a bare
 * `'module'` here would be shadowable by a userland package of that name in a
 * consumer's dependency tree, breaking the artifact before any ADK code runs.
 */

import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {describe, expect, it} from 'vitest';

const dirname = process.cwd();

const BANNER_IMPORT =
  "import {createRequire as topLevelCreateRequire} from 'node:module';";
const BARE_SPECIFIER = "from 'module'";

describe('Build banner', () => {
  describe.each([
    ['core', 'core/build.js'],
    ['integrations', 'integrations/build.js'],
  ])('%s', (_workspace: string, buildScript: string) => {
    it('imports the module builtin with the node: protocol', async () => {
      const contents = await readFile(join(dirname, buildScript), 'utf8');

      expect(contents).toContain(BANNER_IMPORT);
      expect(contents).not.toContain(BARE_SPECIFIER);
    });
  });
});
