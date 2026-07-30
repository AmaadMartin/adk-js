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
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          'argsIgnorePattern': '^_',
          'varsIgnorePattern': '^_',
          'caughtErrorsIgnorePattern': '^_',
        },
      ],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: [
                '@google/adk/*',
                '@google/adk-integrations/*',
                '@google/adk-devtools/*',
              ],
              message:
                "Deep imports into ADK packages do not resolve for consumers: each package's package.json exports map declares only '.'. Import the public symbol from the package root (e.g. '@google/adk'), or use a relative '../src/...' path for a non-exported internal.",
            },
          ],
        },
      ],
    },
  },
]);
