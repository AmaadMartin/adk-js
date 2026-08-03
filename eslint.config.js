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
    // CommonJS sources, where `require()` is correct: `.cjs` by extension, plus
    // the `.js` fixtures whose nearest package.json declares
    // `"type": "commonjs"` or omits `"type"` altogether.
    // `tseslint.configs.recommended` carries no `files` filter and sets
    // `sourceType: 'module'` for every file, which this restores.
    files: [
      '**/*.cjs',
      'tests/integration/build_setup/js_commonjs/**/*.js',
      'tests/integration/app_loader/app_js/**/*.js',
    ],
    languageOptions: {sourceType: 'commonjs'},
    rules: {'@typescript-eslint/no-require-imports': 'off'},
  },
]);
