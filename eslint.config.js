/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import js from '@eslint/js';
import {defineConfig} from 'eslint/config';
import globals from 'globals';
import {builtinModules} from 'node:module';
import tseslint from 'typescript-eslint';

/**
 * Bare Node built-in specifiers (`fs`, `path`, `fs/promises`) are banned so
 * a same-named npm package cannot shadow the built-in. The list is derived
 * from Node's own list, so new built-ins are covered without editing this
 * file.
 */
const bareNodeBuiltins = builtinModules
  .filter((name) => !name.startsWith('node:'))
  .map((name) => ({name, message: `Use "node:${name}" instead of "${name}".`}));

export default defineConfig([
  {
    ignores: ['**/dist/**'],
  },
  tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    plugins: {js},
    extends: ['js/recommended'],
    linterOptions: {
      reportUnusedDisableDirectives: 'error',
    },
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
      // esbuild erases a type-only import from the emitted JavaScript, but it
      // still records the statement in `metafile.inputs` as a static edge that
      // is byte-identical to a real runtime dependency. Only a top-level
      // `import type` drops the edge; `import {type Foo}` does not. So require
      // "separate-type-imports" and keep the reported import graph honest.
      '@typescript-eslint/consistent-type-imports': [
        'error',
        {
          'fixStyle': 'separate-type-imports',
          // Leave `import()` type annotations alone. A type-position
          // `import()` contributes nothing to `metafile.inputs`, so banning it
          // buys no build-graph accuracy, and every site in the repo is the
          // idiomatic `importOriginal<typeof import("...")>()` of a `vi.mock`
          // factory.
          'disallowTypeAnnotations': false,
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
  {
    // Scoped to src until the remaining bare specifiers in test and tooling
    // files are prefixed; widen to '**/*.ts' once that lands.
    files: ['core/src/**/*.ts', 'dev/src/**/*.ts', 'integrations/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {paths: bareNodeBuiltins}],
    },
  },
]);
