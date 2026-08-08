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
    },
  },
  {
    files: ['**/test/**/*.ts', '**/tests/**/*.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        {
          selector:
            "CallExpression[callee.object.name='vi'][callee.property.name=/^(mock|hoisted)$/] " +
            'CallExpression[callee.property.name=/^mock(Implementation|ResolvedValue|ReturnValue|RejectedValue)$/]' +
            "[callee.object.callee.object.name='vi'][callee.object.callee.property.name='fn']",
          message:
            'Inside a vi.mock() or vi.hoisted() factory, pass the implementation to vi.fn() ' +
            'directly (vi.fn(impl), vi.fn(async () => value)). vi.restoreAllMocks() discards ' +
            'an implementation attached with .mockImplementation()/.mockResolvedValue()/' +
            '.mockReturnValue()/.mockRejectedValue(), so the module fake becomes an ' +
            'undefined-returning stub for every test after the first.',
        },
      ],
    },
  },
]);
