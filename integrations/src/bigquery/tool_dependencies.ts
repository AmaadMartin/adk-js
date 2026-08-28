/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQueryOptions} from '@google-cloud/bigquery';

import {ResolvedBigQueryToolConfig} from './config.js';

/** What the toolset hands every BigQuery tool it builds. */
export interface BigQueryToolDependencies {
  /**
   * The auth client every tool call uses. When it is undefined the BigQuery
   * client resolves Application Default Credentials.
   */
  credentials?: BigQueryOptions['authClient'];
  /** The settings the toolset was built with, with the defaults applied. */
  settings: ResolvedBigQueryToolConfig;
  /**
   * Prepended to each tool name the model sees. BigQuery still receives the
   * plain tool name in the user agent, which adk-python pins.
   */
  prefix?: string;
}

/** The name the model calls a tool by, with the toolset prefix applied. */
export function toolName(deps: BigQueryToolDependencies, name: string): string {
  return deps.prefix ? `${deps.prefix}_${name}` : name;
}
