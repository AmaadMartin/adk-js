/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {readFileSync} from 'node:fs';
import path from 'path';
import {defineConfig} from 'vitest/config';

const {workspaces} = JSON.parse(
  readFileSync(path.resolve(__dirname, 'package.json'), 'utf8'),
) as {workspaces: string[]};

/**
 * Coverage denominator, derived from the npm `workspaces` declaration so that a
 * newly declared workspace cannot silently escape coverage measurement the way
 * a hand-maintained list allows.
 */
const coverageInclude = workspaces.map(
  (workspace) => `${workspace}/src/**/*.ts`,
);

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
      include: coverageInclude,
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
