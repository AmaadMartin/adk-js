/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BasePlugin, Logger} from '@google/adk';
import * as yaml from 'js-yaml';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {isFileExists} from '../utils/file_utils.js';

/** Name of the per-app plugin configuration file, as in adk-python. */
const PLUGINS_YAML_FILENAME = 'plugins.yaml';

/** Top-level key holding the BigQuery agent analytics block. */
const BIGQUERY_ANALYTICS_KEY = 'bigquery_agent_analytics';

/** Block keys that must all be set before the plugin is attached. */
const REQUIRED_BIGQUERY_KEYS = [
  'project_id',
  'dataset_id',
  'dataset_location',
] as const;

/**
 * The `bigquery_agent_analytics` block of an app's `plugins.yaml`. Keys stay
 * snake_case because the file format is shared with adk-python.
 */
export interface BigQueryAgentAnalyticsYaml {
  project_id?: string;
  dataset_id?: string;
  table_id?: string;
  dataset_location?: string;
}

/** Constructor options of `BigQueryAgentAnalyticsPlugin`. */
export interface BigQueryAnalyticsPluginOptions {
  projectId: string;
  datasetId: string;
  /** Omitted when `table_id` is unset, so the plugin's own default applies. */
  tableId?: string;
  location: string;
}

/**
 * `@google/adk` plus the analytics plugin, which a build of `@google/adk`
 * predating that plugin does not export. Declared optional so this module keeps
 * serving the app against such a build rather than failing to compile against
 * it.
 */
type AdkAnalyticsExports = typeof import('@google/adk') & {
  BigQueryAgentAnalyticsPlugin?: new (
    options: BigQueryAnalyticsPluginOptions,
  ) => BasePlugin;
};

/** Narrows to a plain object, so an array or null does not pass as one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps a non-empty string and discards every other YAML scalar. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Reads the `bigquery_agent_analytics` block of
 * `<agentsDir>/<appName>/plugins.yaml`.
 *
 * Returns undefined when the file is absent, declares no such block, or cannot
 * be parsed. adk-python lets `yaml.safe_load` raise on the last of those, which
 * fails the whole runner; this server logs a warning and runs the app without
 * the plugin instead.
 */
export async function readBigQueryAnalyticsYaml(
  agentsDir: string,
  appName: string,
  logger: Logger,
): Promise<BigQueryAgentAnalyticsYaml | undefined> {
  const yamlPath = path.join(agentsDir, appName, PLUGINS_YAML_FILENAME);
  if (!(await isFileExists(yamlPath))) {
    return undefined;
  }

  try {
    const parsed: unknown = yaml.load(await fs.readFile(yamlPath, 'utf-8'));
    const block = isRecord(parsed) ? parsed[BIGQUERY_ANALYTICS_KEY] : undefined;
    if (!isRecord(block)) {
      return undefined;
    }
    return {
      project_id: optionalString(block['project_id']),
      dataset_id: optionalString(block['dataset_id']),
      table_id: optionalString(block['table_id']),
      dataset_location: optionalString(block['dataset_location']),
    };
  } catch (e: unknown) {
    logger.warn(`Ignoring ${yamlPath}:`, e);
    return undefined;
  }
}

/**
 * Converts a `bigquery_agent_analytics` block to plugin options, or returns
 * undefined when the block does not set every required key. adk-python skips
 * the plugin silently in that case; the debug line names the missing keys.
 */
export function toBigQueryAnalyticsOptions(
  block: BigQueryAgentAnalyticsYaml,
  logger: Logger,
): BigQueryAnalyticsPluginOptions | undefined {
  const {
    project_id: projectId,
    dataset_id: datasetId,
    dataset_location: location,
  } = block;
  if (!projectId || !datasetId || !location) {
    const missing = REQUIRED_BIGQUERY_KEYS.filter((key) => !block[key]);
    logger.debug(
      `Not attaching the BigQuery agent analytics plugin: ` +
        `${PLUGINS_YAML_FILENAME} does not set ${missing.join(', ')}.`,
    );
    return undefined;
  }
  return {projectId, datasetId, tableId: block.table_id, location};
}

/**
 * Builds the app's BigQuery analytics plugin from its `plugins.yaml`, or
 * returns undefined when the file is absent, incomplete or unreadable.
 *
 * `@google/adk` is imported here rather than at the top of the module, so a
 * server that serves no app declaring the plugin never loads it. That mirrors
 * adk-python's deferred import.
 */
export async function loadBigQueryAnalyticsPlugin(
  agentsDir: string,
  appName: string,
  logger: Logger,
): Promise<BasePlugin | undefined> {
  const block = await readBigQueryAnalyticsYaml(agentsDir, appName, logger);
  if (!block) {
    return undefined;
  }

  const options = toBigQueryAnalyticsOptions(block, logger);
  if (!options) {
    return undefined;
  }

  const adk: AdkAnalyticsExports = await import('@google/adk');
  if (!adk.BigQueryAgentAnalyticsPlugin) {
    logger.warn(
      `Not attaching the BigQuery agent analytics plugin: the installed ` +
        `@google/adk does not export BigQueryAgentAnalyticsPlugin.`,
    );
    return undefined;
  }
  return new adk.BigQueryAgentAnalyticsPlugin(options);
}
