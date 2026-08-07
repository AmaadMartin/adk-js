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
    // `api-reference/` is typedoc output from `npm run docs:generate`; it is
    // not gitignored and it contains typedoc's own bundled `assets/main.js`.
    ignores: ['**/dist/**', 'dev/src/browser/**', 'api-reference/**'],
  },
  tseslint.configs.recommended,
  {
    files: ['**/*.{js,cjs,mjs,ts}'],
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
    // A `.cjs` file is CommonJS by definition, so `require()` is correct there.
    // `tseslint.configs.recommended` carries no `files` filter and sets
    // `sourceType: 'module'` for every file, which this restores.
    files: ['**/*.cjs'],
    languageOptions: {sourceType: 'commonjs'},
    rules: {'@typescript-eslint/no-require-imports': 'off'},
  },
]);
