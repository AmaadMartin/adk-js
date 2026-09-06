/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  loadBigQueryAnalyticsPlugin,
  readBigQueryAnalyticsYaml,
  toBigQueryAnalyticsOptions,
} from '../../src/server/plugins_config.js';
import {CapturingLogger} from './capturing_logger.js';

// This branch's `@google/adk` does export the plugin, so the case that covers
// an installation without it has to take the export away.
vi.mock('@google/adk', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@google/adk')>();
  return {...actual, BigQueryAgentAnalyticsPlugin: undefined};
});

/**
 * Budget (ms) for a test whose first `await import('@google/adk')` evaluates
 * the whole package. Well above the ~5s it costs on a developer machine,
 * because CI adds v8 coverage instrumentation on slower runners.
 */
const PACKAGE_IMPORT_TIMEOUT_MS = 120_000;

const APP_NAME = 'bq_app';

const COMPLETE_PLUGINS_YAML = `bigquery_agent_analytics:
  project_id: test-project
  dataset_id: test-dataset
  table_id: test-table
  dataset_location: US
`;

describe('plugins.yaml configuration', () => {
  let agentsDir: string;
  let logger: CapturingLogger;

  beforeEach(async () => {
    agentsDir = await fs.mkdtemp(path.join(os.tmpdir(), 'adk-plugins-yaml-'));
    await fs.mkdir(path.join(agentsDir, APP_NAME));
    logger = new CapturingLogger();
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

  describe('readBigQueryAnalyticsYaml', () => {
    it('returns undefined when the app has no plugins.yaml', async () => {
      expect(
        await readBigQueryAnalyticsYaml(agentsDir, APP_NAME, logger),
      ).toBeUndefined();
      expect(logger.warnMessages).toEqual([]);
    });

    it('reads every key of the bigquery_agent_analytics block', async () => {
      await writePluginsYaml(COMPLETE_PLUGINS_YAML);

      expect(
        await readBigQueryAnalyticsYaml(agentsDir, APP_NAME, logger),
      ).toEqual({
        project_id: 'test-project',
        dataset_id: 'test-dataset',
        table_id: 'test-table',
        dataset_location: 'US',
      });
    });

    it('drops a non-string value in the block', async () => {
      await writePluginsYaml(
        'bigquery_agent_analytics:\n  project_id: 42\n  dataset_id: ""\n',
      );

      expect(
        await readBigQueryAnalyticsYaml(agentsDir, APP_NAME, logger),
      ).toEqual({
        project_id: undefined,
        dataset_id: undefined,
        table_id: undefined,
        dataset_location: undefined,
      });
    });

    it('ignores keys other than bigquery_agent_analytics', async () => {
      await writePluginsYaml('some_other_plugin:\n  enabled: true\n');

      expect(
        await readBigQueryAnalyticsYaml(agentsDir, APP_NAME, logger),
      ).toBeUndefined();
    });

    it('treats a block that is not a mapping as absent', async () => {
      await writePluginsYaml('bigquery_agent_analytics: [1, 2]\n');

      expect(
        await readBigQueryAnalyticsYaml(agentsDir, APP_NAME, logger),
      ).toBeUndefined();
    });

    it('treats a file that is not a mapping as absent', async () => {
      await writePluginsYaml('- just\n- a\n- list\n');

      expect(
        await readBigQueryAnalyticsYaml(agentsDir, APP_NAME, logger),
      ).toBeUndefined();
    });

    it('warns and returns undefined when the YAML does not parse', async () => {
      await writePluginsYaml('bigquery_agent_analytics: [unterminated\n');

      expect(
        await readBigQueryAnalyticsYaml(agentsDir, APP_NAME, logger),
      ).toBeUndefined();
      expect(logger.warnMessages).toHaveLength(1);
      expect(logger.warnMessages[0]).toContain('plugins.yaml');
    });
  });

  describe('toBigQueryAnalyticsOptions', () => {
    it('converts a complete block to camelCase options', () => {
      expect(
        toBigQueryAnalyticsOptions(
          {
            project_id: 'test-project',
            dataset_id: 'test-dataset',
            table_id: 'test-table',
            dataset_location: 'US',
          },
          logger,
        ),
      ).toEqual({
        projectId: 'test-project',
        datasetId: 'test-dataset',
        tableId: 'test-table',
        location: 'US',
      });
    });

    it('leaves tableId unset so the plugin default applies', () => {
      expect(
        toBigQueryAnalyticsOptions(
          {
            project_id: 'test-project',
            dataset_id: 'test-dataset',
            dataset_location: 'US',
          },
          logger,
        ),
      ).toEqual({
        projectId: 'test-project',
        datasetId: 'test-dataset',
        tableId: undefined,
        location: 'US',
      });
      expect(logger.debugMessages).toEqual([]);
    });

    it('rejects a block that does not set dataset_id', () => {
      expect(
        toBigQueryAnalyticsOptions(
          {project_id: 'test-project', dataset_location: 'US'},
          logger,
        ),
      ).toBeUndefined();
      expect(logger.debugMessages[0]).toContain('dataset_id');
    });

    it('rejects a block that does not set dataset_location', () => {
      expect(
        toBigQueryAnalyticsOptions(
          {project_id: 'test-project', dataset_id: 'test-dataset'},
          logger,
        ),
      ).toBeUndefined();
      expect(logger.debugMessages[0]).toContain('dataset_location');
    });

    it('names every missing key at once', () => {
      expect(toBigQueryAnalyticsOptions({}, logger)).toBeUndefined();
      expect(logger.debugMessages[0]).toContain(
        'project_id, dataset_id, dataset_location',
      );
    });
  });

  describe('loadBigQueryAnalyticsPlugin', () => {
    it(
      'warns and builds nothing when @google/adk omits the export',
      async () => {
        await writePluginsYaml(COMPLETE_PLUGINS_YAML);

        const plugin = await loadBigQueryAnalyticsPlugin(
          agentsDir,
          APP_NAME,
          logger,
        );

        expect(plugin).toBeUndefined();
        expect(logger.warnMessages).toHaveLength(1);
        expect(logger.warnMessages[0]).toContain(
          'BigQueryAgentAnalyticsPlugin',
        );
      },
      PACKAGE_IMPORT_TIMEOUT_MS,
    );

    it('does not reach the import when plugins.yaml is absent', async () => {
      expect(
        await loadBigQueryAnalyticsPlugin(agentsDir, APP_NAME, logger),
      ).toBeUndefined();
      expect(logger.warnMessages).toEqual([]);
    });

    it('does not reach the import when the block is incomplete', async () => {
      await writePluginsYaml(
        'bigquery_agent_analytics:\n  project_id: test-project\n',
      );

      expect(
        await loadBigQueryAnalyticsPlugin(agentsDir, APP_NAME, logger),
      ).toBeUndefined();
      expect(logger.warnMessages).toEqual([]);
      expect(logger.debugMessages[0]).toContain('dataset_id');
    });
  });
});
