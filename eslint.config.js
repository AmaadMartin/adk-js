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
          'argsIgnorePattern': '^_',
          'varsIgnorePattern': '^_',
          'caughtErrorsIgnorePattern': '^_',
        },
      ],
    },
  },
  {
    // A published `src/` tree may only import packages its own workspace
    // declares. These "phantom" dependencies resolve here only because npm
    // hoists every workspace into the root `node_modules`; they are absent from
    // a consumer's install. With no `packageDir` each file is checked against
    // its nearest manifest, i.e. its own workspace's -- adding a `packageDir`
    // that lists several workspaces would union them and silently drop that
    // isolation. `includeTypes` extends the check to `import type`, which
    // reaches consumers through the published `.d.ts`.
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
