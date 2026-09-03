/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import {defineConfig} from 'vitest/config';

/**
 * Hook budget (ms) for every `beforeAll` in the `integration` project. The
 * hooks spawn an ADK server child process or compile a fixture, which exceeds
 * Vitest's 10s default on a slow or loaded machine. `tests/integration/
 * global_setup.ts` installs the fixture dependencies before the pool starts
 * and removes them after it stops, so no hook pays for an `npm install` or for
 * the recursive `node_modules` teardown that follows one.
 *
 * This is a hang guard, not an expected runtime: the slowest hook is a fixture
 * `npm run build`, measured at 3.6s on ubuntu. Nothing measures the server
 * starts on the slowest CI runner, so the budget stays where it was until
 * somebody does. Keep it above the 60s server start watchdog in
 * `tests/integration/test_api_server.ts`, so a server that boots but never
 * announces itself fails with that watchdog's message rather than a bare
 * `Hook timed out`.
 *
 * This value is the single source for an install or teardown hook. Such a hook
 * must not pass its own timeout argument, which shadows this floor rather than
 * raising it. Any other per-file hook argument also replaces this value rather
 * than raising it, so a hook that states one must record the measurement
 * behind it. Trade-off: a stuck hook takes this long to surface.
 */
const INTEGRATION_HOOK_TIMEOUT_MS = 120000;

/**
 * Test budget (ms) for the `integration` project: a test body spawns
 * `npm run start` and reads the child's stdout to EOF with no internal
 * timeout, so this budget is its only bound. A per-test `it()` argument
 * replaces this value rather than raising it, so a file that states one must
 * record the measurement behind it. A hook argument does not reach this value;
 * the hook budget above governs hooks.
 */
const INTEGRATION_TEST_TIMEOUT_MS = 60000;

/**
 * Compiled-agent bundles to keep out of Vite's SSR transform. `AgentLoader`
 * (`dev/src/utils/agent_loader.ts`) esbuilds each agent into a
 * `<tmpdir>/adk_agent_loader-<random>/` bundle, outside the root with no
 * `node_modules` segment, so Vitest inlines and transforms ~6 MB per agent.
 * Rename that `createTempDir` prefix and the suite silently goes slow again.
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
      // The unit projects load `./tests/unit_setup.ts`, which deletes the
      // environment variables ADK reads so a test result does not depend on the
      // developer's shell. `unstubEnvs` fires in `onBeforeTryTask`, before each
      // test and before its `beforeEach`, so a stub installed in a `beforeEach`
      // still applies. `restoreMocks` stays unset: under Vitest 3.2.6 it resets
      // the implementation of every `vi.fn()` declared in a `vi.mock` factory.
      {
        test: {
          name: 'unit:core',
          environment: 'node',
          setupFiles: ['./tests/test_setup.ts', './tests/unit_setup.ts'],
          unstubEnvs: true,
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
          setupFiles: ['./tests/test_setup.ts', './tests/unit_setup.ts'],
          unstubEnvs: true,
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
          setupFiles: ['./tests/test_setup.ts', './tests/unit_setup.ts'],
          unstubEnvs: true,
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
          setupFiles: ['./tests/test_setup.ts'],
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
          globalSetup: ['./tests/integration/global_setup.ts'],
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'node',
          setupFiles: ['./tests/test_setup.ts'],
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
          setupFiles: ['./tests/test_setup.ts'],
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
      // Those values are from the npm run test:coverage command run on 2026-07-30
      // and are used to ensure that the test coverage does not decrease.
      // Once the test coverage increases, these values should be updated (manually).
      thresholds: {
        statements: 90,
        branches: 88,
        functions: 90,
        lines: 90,
      },
    },
  },
});
