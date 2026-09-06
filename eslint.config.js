/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import js from '@eslint/js';
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
      // `js/recommended` re-enables the base rules that `tseslint.configs
      // .recommended` turned off above, so each one is turned off again here
      // and replaced by its TypeScript-aware version. The base `no-redeclare`
      // reports every function overload signature as a redeclaration.
      'no-redeclare': 'off',
      '@typescript-eslint/no-redeclare': 'error',
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
]);
