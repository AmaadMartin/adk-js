/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import {defineConfig} from 'vitest/config';

/**
 * Hook budget (ms) for the `integration` project: install-heavy `beforeAll`
 * hooks run `npm install` (and sometimes `npm run build`) per fixture, which
 * exceeds Vitest's 10s default on a slow or loaded machine.
 */
const INTEGRATION_HOOK_TIMEOUT_MS = 120000;

/**
 * Test budget (ms) for the `integration` project: matches the largest per-file
 * timeout in the repo. Per-file `it()`/hook timeouts still override both.
 */
const INTEGRATION_TEST_TIMEOUT_MS = 60000;

/**
 * Compiled-agent bundles to keep out of Vite's SSR transform in the
 * `integration` project. `AgentLoader` (`dev/src/utils/agent_loader.ts`)
 * esbuilds every discovered agent into a throwaway minified bundle under
 * `<tmpdir>/adk_agent_loader-<random>/`, then imports it. Vitest inlines that
 * import because the path sits outside the project root and holds no
 * `node_modules` segment, so it pushes ~6 MB of generated JavaScript per
 * agent through the transform pipeline. Externalizing hands the bundle to
 * Node's own loader instead, which is the path the ADK CLI takes outside
 * Vitest. `[\\/]` matches the Windows separator too. Rename the
 * `createTempDir('adk_agent_loader')` prefix in `agent_loader.ts` and this
 * pattern stops matching: the suite gets slow again, it does not fail.
 */
const AGENT_LOADER_BUNDLE_PATTERN = /[\\/]adk_agent_loader/;

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
          server: {deps: {external: [AGENT_LOADER_BUNDLE_PATTERN]}},
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
