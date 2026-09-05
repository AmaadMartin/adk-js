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

/** Export the default factory looks for on `@google/adk`. */
const BIGQUERY_PLUGIN_EXPORT = 'BigQueryAgentAnalyticsPlugin';

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

/** Parsed `plugins.yaml`. Unknown keys are ignored, as in adk-python. */
export interface PluginsYaml {
  bigquery_agent_analytics?: BigQueryAgentAnalyticsYaml;
}

/** Options handed to {@link BigQueryAnalyticsPluginFactory}. */
export interface BigQueryAnalyticsPluginOptions {
  projectId: string;
  datasetId: string;
  /** Omitted when `table_id` is unset, so the plugin's own default applies. */
  tableId?: string;
  location: string;
}

/**
 * Builds the BigQuery analytics plugin for one app. Returns undefined when the
 * plugin cannot be built, in which case the app runs without it.
 */
export type BigQueryAnalyticsPluginFactory = (
  options: BigQueryAnalyticsPluginOptions,
) => Promise<BasePlugin | undefined>;

type BigQueryPluginConstructor = new (
  options: BigQueryAnalyticsPluginOptions,
) => BasePlugin;

/** Narrows to a plain object, so an array or null does not pass as one. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Keeps a non-empty string and discards every other YAML scalar. */
function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Narrows a dynamically imported export to a plugin constructor. A dynamic
 * import yields `unknown`, and callability is the only property that can be
 * checked before the constructor runs.
 */
function isPluginConstructor(
  value: unknown,
): value is BigQueryPluginConstructor {
  return typeof value === 'function';
}

/**
 * Reads `<agentsDir>/<appName>/plugins.yaml`.
 *
 * Returns undefined when the file is absent, and also when it cannot be parsed
 * — adk-python lets `yaml.safe_load` raise there, which fails the whole runner;
 * this server logs a warning and runs the app without its plugins instead.
 */
export async function readPluginsYaml(
  agentsDir: string,
  appName: string,
  logger: Logger,
): Promise<PluginsYaml | undefined> {
  const yamlPath = path.join(agentsDir, appName, PLUGINS_YAML_FILENAME);
  if (!(await isFileExists(yamlPath))) {
    return undefined;
  }

  try {
    const parsed: unknown = yaml.load(await fs.readFile(yamlPath, 'utf-8'));
    const block = isRecord(parsed) ? parsed[BIGQUERY_ANALYTICS_KEY] : undefined;
    if (!isRecord(block)) {
      return {};
    }
    return {
      bigquery_agent_analytics: {
        project_id: optionalString(block['project_id']),
        dataset_id: optionalString(block['dataset_id']),
        table_id: optionalString(block['table_id']),
        dataset_location: optionalString(block['dataset_location']),
      },
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
 * Resolves {@link BIGQUERY_PLUGIN_EXPORT} from `@google/adk` at call time,
 * mirroring adk-python's deferred import. A build of `@google/adk` that does
 * not export it logs a warning and attaches no plugin, so the server starts.
 */
export function createBigQueryAnalyticsPlugin(
  logger: Logger,
): BigQueryAnalyticsPluginFactory {
  return async (options: BigQueryAnalyticsPluginOptions) => {
    const adk: object = await import('@google/adk');
    const pluginClass =
      BIGQUERY_PLUGIN_EXPORT in adk ? adk[BIGQUERY_PLUGIN_EXPORT] : undefined;
    if (!isPluginConstructor(pluginClass)) {
      logger.warn(
        `Not attaching the BigQuery agent analytics plugin: the installed ` +
          `@google/adk does not export ${BIGQUERY_PLUGIN_EXPORT}.`,
      );
      return undefined;
    }
    return new pluginClass(options);
  };
}

/**
 * Builds the app's BigQuery analytics plugin from its `plugins.yaml`, or
 * returns undefined when the file is absent, incomplete or unreadable.
 */
export async function loadBigQueryAnalyticsPlugin(
  agentsDir: string,
  appName: string,
  factory: BigQueryAnalyticsPluginFactory,
  logger: Logger,
): Promise<BasePlugin | undefined> {
  const pluginsYaml = await readPluginsYaml(agentsDir, appName, logger);
  const block = pluginsYaml?.bigquery_agent_analytics;
  if (!block) {
    return undefined;
  }

  const options = toBigQueryAnalyticsOptions(block, logger);
  if (!options) {
    return undefined;
  }
  return factory(options);
}
