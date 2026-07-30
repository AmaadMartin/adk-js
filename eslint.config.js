/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import js from '@eslint/js';
import importPlugin from 'eslint-plugin-import';
import {defineConfig} from 'eslint/config';
import globals from 'globals';
import tseslint from 'typescript-eslint';

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
  {
    // Forbids a published `src/` tree from importing a package its own
    // workspace does not declare ("phantom" dependencies, which resolve today
    // only because npm hoists every workspace's deps into the root
    // `node_modules` and so are missing from a consumer's install).
    //
    // With no `packageDir`, the rule checks each file against the closest
    // parent `package.json`, i.e. the owning workspace's manifest -- which is
    // what keeps `dev/src` from reaching `core`'s dependencies. Do not add a
    // `packageDir` listing several workspaces: that unions their manifests into
    // one allowed set and silently removes the isolation.
    //
    // `devDependencies: false` is the point of the rule; `includeTypes: true`
    // extends it to `import type`, since a devDependency reached by a published
    // `.d.ts` breaks consumers the same way. Every other option keeps its
    // permissive default, notably `peerDependencies`, because `core/src`
    // legitimately imports the `@mikro-orm/*` drivers it declares as peers.
    files: ['core/src/**/*.ts', 'dev/src/**/*.ts', 'integrations/src/**/*.ts'],
    plugins: {import: importPlugin},
    rules: {
      'import/no-extraneous-dependencies': [
        'error',
        {devDependencies: false, includeTypes: true},
      ],
    },
  },
]);
