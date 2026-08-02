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
    // declares: npm hoists every workspace into the root `node_modules`, so an
    // undeclared import resolves here but breaks a standalone consumer.
    // `packageDir` is omitted so each file is checked against its own
    // workspace's manifest; listing directories would union them.
    files: ['core/src/**/*.ts', 'dev/src/**/*.ts', 'integrations/src/**/*.ts'],
    plugins: {import: importPlugin},
    rules: {
      'import/no-extraneous-dependencies': ['error', {devDependencies: false}],
    },
  },
]);
