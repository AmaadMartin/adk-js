/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers the default factory against a build of `@google/adk` that DOES export
 * `BigQueryAgentAnalyticsPlugin`. `vi.mock` is hoisted and file-scoped, so this
 * case cannot share a file with the one that asserts the missing-export
 * warning.
 */

import {describe, expect, it, vi} from 'vitest';

import {createBigQueryAnalyticsPlugin} from '../../src/server/plugins_config.js';
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

describe('createBigQueryAnalyticsPlugin', () => {
  it('constructs the plugin @google/adk exports', async () => {
    const logger = new CapturingLogger();
    const options = {
      projectId: 'test-project',
      datasetId: 'test-dataset',
      tableId: 'test-table',
      location: 'US',
    };

    const plugin = await createBigQueryAnalyticsPlugin(logger)(options);

    expect(plugin?.name).toBe('bigquery_agent_analytics');
    expect(constructedWith).toEqual([options]);
    expect(logger.warnMessages).toEqual([]);
  });
});
