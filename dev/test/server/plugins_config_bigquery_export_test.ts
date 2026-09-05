/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers `loadBigQueryAnalyticsPlugin` against a build of `@google/adk` that
 * DOES export `BigQueryAgentAnalyticsPlugin`. `vi.mock` is hoisted and
 * file-scoped, so this case cannot share a file with the one that asserts the
 * missing-export warning.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {loadBigQueryAnalyticsPlugin} from '../../src/server/plugins_config.js';
import {CapturingLogger} from './capturing_logger.js';

/** Options each construction of the exported plugin was given. */
const constructedWith = vi.hoisted(() => [] as unknown[]);

vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  class FakeBigQueryAgentAnalyticsPlugin extends actual.BasePlugin {
    constructor(options: unknown) {
      super('bigquery_agent_analytics');
      constructedWith.push(options);
    }
  }
  return {
    ...actual,
    BigQueryAgentAnalyticsPlugin: FakeBigQueryAgentAnalyticsPlugin,
  };
});

/**
 * Budget (ms) for a test whose first `await import('@google/adk')` evaluates
 * the whole package. Well above the ~5s it costs on a developer machine,
 * because CI adds v8 coverage instrumentation on slower runners.
 */
const PACKAGE_IMPORT_TIMEOUT_MS = 120_000;

const APP_NAME = 'bq_app';

describe('loadBigQueryAnalyticsPlugin', () => {
  let agentsDir: string;
  let logger: CapturingLogger;

  beforeEach(async () => {
    agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-bq-export-'));
    await fs.mkdir(path.join(agentsDir, APP_NAME));
    logger = new CapturingLogger();
    constructedWith.length = 0;
  });

  afterEach(async () => {
    await fs.rm(agentsDir, {recursive: true, force: true});
  });

  async function writePluginsYaml(contents: string): Promise<void> {
    await fs.writeFile(
      path.join(agentsDir, APP_NAME, 'plugins.yaml'),
      contents,
    );
  }

  it(
    'constructs the exported plugin from the keys in plugins.yaml',
    async () => {
      await writePluginsYaml(`bigquery_agent_analytics:
  project_id: test-project
  dataset_id: test-dataset
  table_id: test-table
  dataset_location: US
`);

      const plugin = await loadBigQueryAnalyticsPlugin(
        agentsDir,
        APP_NAME,
        logger,
      );

      expect(plugin?.name).toBe('bigquery_agent_analytics');
      expect(constructedWith).toEqual([
        {
          projectId: 'test-project',
          datasetId: 'test-dataset',
          tableId: 'test-table',
          location: 'US',
        },
      ]);
      expect(logger.warnMessages).toEqual([]);
    },
    PACKAGE_IMPORT_TIMEOUT_MS,
  );

  it(
    'leaves tableId unset when plugins.yaml omits table_id',
    async () => {
      await writePluginsYaml(`bigquery_agent_analytics:
  project_id: test-project
  dataset_id: test-dataset
  dataset_location: EU
`);

      await loadBigQueryAnalyticsPlugin(agentsDir, APP_NAME, logger);

      expect(constructedWith).toEqual([
        {
          projectId: 'test-project',
          datasetId: 'test-dataset',
          tableId: undefined,
          location: 'EU',
        },
      ]);
    },
    PACKAGE_IMPORT_TIMEOUT_MS,
  );
});
