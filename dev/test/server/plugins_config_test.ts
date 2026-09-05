/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it} from 'vitest';

import {
  PLUGINS_CONFIG_FILE,
  readBigQueryAnalyticsConfig,
} from '../../src/server/plugins_config.js';
import {CapturingLogger} from './capturing_logger.js';

const APP_NAME = 'my_agent';

const COMPLETE_CONFIG = `
bigquery_agent_analytics:
  project_id: my-project
  dataset_id: my_dataset
  dataset_location: us-central1
  table_id: my_table
`;

describe('readBigQueryAnalyticsConfig', () => {
  let agentsDir: string;
  let logger: CapturingLogger;

  beforeEach(() => {
    agentsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-agents-'));
    fs.mkdirSync(path.join(agentsDir, APP_NAME));
    logger = new CapturingLogger();
  });

  afterEach(() => {
    fs.rmSync(agentsDir, {recursive: true, force: true});
  });

  function writeConfig(contents: string): void {
    fs.writeFileSync(
      path.join(agentsDir, APP_NAME, PLUGINS_CONFIG_FILE),
      contents,
    );
  }

  function read() {
    return readBigQueryAnalyticsConfig(agentsDir, APP_NAME, logger);
  }

  it('reads a complete config, converting the snake_case keys', () => {
    writeConfig(COMPLETE_CONFIG);

    expect(read()).toEqual({
      projectId: 'my-project',
      datasetId: 'my_dataset',
      datasetLocation: 'us-central1',
      tableId: 'my_table',
    });
  });

  it('accepts a config with no table_id, which the plugin defaults', () => {
    writeConfig(`
bigquery_agent_analytics:
  project_id: my-project
  dataset_id: my_dataset
  dataset_location: us-central1
`);

    expect(read()).toEqual({
      projectId: 'my-project',
      datasetId: 'my_dataset',
      datasetLocation: 'us-central1',
      tableId: undefined,
    });
  });

  it('rejects a config with no project_id', () => {
    writeConfig(`
bigquery_agent_analytics:
  dataset_id: my_dataset
  dataset_location: us-central1
`);

    expect(read()).toBeUndefined();
  });

  it('rejects a config with no dataset_id', () => {
    writeConfig(`
bigquery_agent_analytics:
  project_id: my-project
  dataset_location: us-central1
`);

    expect(read()).toBeUndefined();
  });

  it('rejects a config with no dataset_location', () => {
    writeConfig(`
bigquery_agent_analytics:
  project_id: my-project
  dataset_id: my_dataset
`);

    expect(read()).toBeUndefined();
  });

  it('rejects a value that is not a string', () => {
    writeConfig(`
bigquery_agent_analytics:
  project_id: 42
  dataset_id: my_dataset
  dataset_location: us-central1
`);

    expect(read()).toBeUndefined();
  });

  it('rejects a file that parses to a list rather than a mapping', () => {
    writeConfig('- bigquery_agent_analytics\n');

    expect(read()).toBeUndefined();
  });

  it('rejects a file with no bigquery_agent_analytics block', () => {
    writeConfig('other_plugin:\n  enabled: true\n');

    expect(read()).toBeUndefined();
  });

  it('reports malformed YAML instead of throwing', () => {
    writeConfig('bigquery_agent_analytics: [unclosed\n');

    expect(read()).toBeUndefined();
    expect(logger.errors.join('\n')).toContain(PLUGINS_CONFIG_FILE);
  });

  it('returns nothing when the app has no plugins.yaml', () => {
    expect(read()).toBeUndefined();
    expect(logger.errors).toEqual([]);
  });
});
