/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import {defineConfig} from 'eslint/config';
import globals from 'globals';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import tseslint from 'typescript-eslint';

const repoRoot = path.dirname(fileURLToPath(import.meta.url));

/**
 * Forbids a workspace's `src/` tree from importing any package that the
 * workspace does not declare as a runtime dependency ("phantom" dependencies,
 * which only resolve today because npm hoists sibling workspaces' deps into the
 * root `node_modules`).
 *
 * `packageDir` is the repo root plus the owning workspace, so the allowed set is
 * the union of both manifests. Listing every workspace in a single block would
 * union all of them together and let `dev/src` import `core`'s dependencies, so
 * each workspace gets its own block.
 *
 * `devDependencies: false` is the point of the rule: a devDependency is absent
 * from a consumer's install, so importing one from `src/` ships a broken
 * package. `includeTypes: true` extends that to `import type`, because a
 * devDependency referenced by a published `.d.ts` breaks consumers the same way.
 * Every other option is left at its permissive default; notably
 * `peerDependencies` stays `true` because `core/src` legitimately imports the
 * `@mikro-orm/*` drivers it declares as peers.
 */
function noPhantomDeps(workspace) {
  return {
    files: [`${workspace}/src/**/*.ts`],
    plugins: {import: importPlugin},
    rules: {
      'import/no-extraneous-dependencies': [
        'error',
        {
          devDependencies: false,
          includeTypes: true,
          packageDir: [repoRoot, path.join(repoRoot, workspace)],
        },
      ],
    },
  };
}

export default defineConfig([
  {
    ignores: ['**/dist/**', 'dev/src/browser/**'],
  },
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {js},
    extends: ['js/recommended'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.vitest,
      },
    },
    rules: {
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  noPhantomDeps('core'),
  noPhantomDeps('dev'),
  noPhantomDeps('integrations'),
]);
