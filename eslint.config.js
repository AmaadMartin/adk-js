/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import js from '@eslint/js';
import n from 'eslint-plugin-n';
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
    plugins: {js, n},
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
      'n/prefer-node-protocol': 'error',
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
  {
    files: ['core/test/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          'patterns': [
            {
              'group': ['@google/adk', '@google/adk/**'],
              'message':
                "core/test must import ADK symbols from the source tree via a relative path (e.g. '../../src/index.js'). The package specifier resolves through the workspace symlink to the built declarations in core/dist/types, so TypeScript sees two distinct declarations of every class, while vitest aliases it to core/src -- the type checker and the runtime disagree.",
            },
          ],
        },
      ],
    },
  },
]);
