/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import {defineConfig} from 'vitest/config';

// A per-hook or per-test timeout argument replaces the budgets below rather
// than adding to them, so add one only to raise a specific operation - never to
// restate or lower one.

/**
 * Hook budget (ms) for the `integration` project: install-heavy `beforeAll`
 * hooks run `npm install` (and sometimes `npm run build`) per fixture, and the
 * matching `afterAll` hooks recursively remove the resulting `node_modules`.
 * That exceeds Vitest's 10s default on a slow or loaded machine.
 *
 * The twelve `build_setup` hook runs take ~16s combined warm on ubuntu-latest,
 * but a cold, network-bound install has been measured at ~70s, so 120s covers
 * the worst case. Trade-off: a genuinely stuck hook takes this long to surface.
 */
const INTEGRATION_HOOK_TIMEOUT_MS = 120000;

/**
 * Test budget (ms) for the `integration` project, sized for the
 * subprocess-spawning suites under `tests/integration`. Must stay above
 * `UnsafeLocalCodeExecutor`'s default `timeoutSeconds` (30) so the executor's
 * own timeout error surfaces before Vitest's.
 */
const INTEGRATION_TEST_TIMEOUT_MS = 60000;

export default defineConfig({
  test: {
    poolOptions: {
      forks: {
        execArgv: ['--max-old-space-size=8192'],
      },
      threads: {
        execArgv: ['--max-old-space-size=8192'],
      },
    },
    projects: [
      {
        test: {
          name: 'unit:core',
          environment: 'node',
          alias: {
            '@google/adk': path.resolve(__dirname, './core/src'),
            '@google/adk-integrations': path.resolve(
              __dirname,
              './integrations/src',
            ),
          },
          include: ['core/test/**/*_test.ts'],
        },
      },
      {
        test: {
          name: 'unit:dev',
          environment: 'node',
          alias: {
            '@google/adk': path.resolve(__dirname, './core/src'),
            '@google/adk-integrations': path.resolve(
              __dirname,
              './integrations/src',
            ),
          },
          include: ['dev/test/**/*_test.ts'],
        },
      },
      {
        test: {
          name: 'unit:integrations',
          environment: 'node',
          alias: {
            '@google/adk': path.resolve(__dirname, './core/src'),
            '@google/adk-integrations': path.resolve(
              __dirname,
              './integrations/src',
            ),
          },
          include: ['integrations/test/**/*_test.ts'],
        },
      },
      {
        test: {
          name: 'integration',
          environment: 'node',
          hookTimeout: INTEGRATION_HOOK_TIMEOUT_MS,
          testTimeout: INTEGRATION_TEST_TIMEOUT_MS,
          alias: {
            '@google/adk': path.resolve(__dirname, './core/src'),
            '@google/adk-integrations': path.resolve(
              __dirname,
              './integrations/src',
            ),
          },
          include: ['tests/integration/**/*_test.ts'],
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'node',
          alias: {
            '@google/adk': path.resolve(__dirname, './core/src'),
            '@google/adk-integrations': path.resolve(
              __dirname,
              './integrations/src',
            ),
          },
          include: ['tests/e2e/**/*_test.ts'],
        },
      },
      {
        test: {
          name: 'cross-language',
          environment: 'node',
          alias: {
            '@google/adk': path.resolve(__dirname, './core/src'),
            '@google/adk-integrations': path.resolve(
              __dirname,
              './integrations/src',
            ),
          },
          include: ['tests/cross_language/**/*_test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json'],
      include: [
        'core/src/**/*.ts',
        'dev/src/**/*.ts',
        'integrations/src/**/*.ts',
      ],
      // Those values are from the npm run test:coverage command run on 2026-02-06
      // and are used to ensure that the test coverage does not decrease.
      // Once the test coverage increases, these values should be updated (manually).
      thresholds: {
        statements: 86,
        branches: 87,
        functions: 88,
        lines: 86,
      },
    },
    globalSetup: ['./tests/global_setup.ts'],
  },
});
