/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Logger} from '@google/adk';
import yaml from 'js-yaml';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {errorMessage} from '../utils/error_utils.js';
import {isRecord} from '../utils/value_utils.js';

/** Name of the per-app plugin configuration file, as adk-python spells it. */
export const PLUGINS_CONFIG_FILE = 'plugins.yaml';

/** Top-level key naming the BigQuery analytics plugin's settings. */
const BIGQUERY_ANALYTICS_KEY = 'bigquery_agent_analytics';

/** Settings the BigQuery agent analytics plugin needs to write a row. */
export interface BigQueryAnalyticsPluginConfig {
  projectId: string;
  datasetId: string;
  datasetLocation: string;
  tableId?: string;
}

/**
 * Reads the BigQuery analytics settings of one app from its `plugins.yaml`.
 *
 * The keys on disk are snake_case because the file is shared with adk-python;
 * the returned object is camelCase, as the rest of adk-js is. An app with no
 * such file, an incomplete block or a file this reader cannot parse returns
 * `undefined`, so the app runs without the plugin.
 *
 * adk-python lets a malformed file propagate and stop the runner from being
 * created. This reader logs and returns `undefined` instead: an unreadable
 * analytics setting should not take an agent off the air.
 */
export function readBigQueryAnalyticsConfig(
  agentsDir: string,
  appName: string,
  logger: Logger,
): BigQueryAnalyticsPluginConfig | undefined {
  const configPath = path.join(agentsDir, appName, PLUGINS_CONFIG_FILE);
  if (!fs.existsSync(configPath)) {
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = yaml.load(fs.readFileSync(configPath, 'utf-8'));
  } catch (error: unknown) {
    logger.error(
      `Failed to read ${configPath}: ${errorMessage(error)}. The app runs ` +
        `without the plugins it configures.`,
    );
    return undefined;
  }

  if (!isRecord(parsed)) {
    return undefined;
  }
  return toBigQueryAnalyticsConfig(parsed[BIGQUERY_ANALYTICS_KEY]);
}

/**
 * Converts the `bigquery_agent_analytics` block into settings the plugin can
 * be built from, or `undefined` when the block does not carry all three
 * required values. `table_id` is optional: the plugin defaults it.
 */
function toBigQueryAnalyticsConfig(
  block: unknown,
): BigQueryAnalyticsPluginConfig | undefined {
  if (!isRecord(block)) {
    return undefined;
  }
  const projectId = readString(block['project_id']);
  const datasetId = readString(block['dataset_id']);
  const datasetLocation = readString(block['dataset_location']);
  if (!projectId || !datasetId || !datasetLocation) {
    return undefined;
  }
  return {
    projectId,
    datasetId,
    datasetLocation,
    tableId: readString(block['table_id']),
  };
}

/** Reads a YAML value that must be a string, ignoring anything else. */
function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
