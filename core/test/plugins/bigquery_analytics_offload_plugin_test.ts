/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {Context} from '../../src/agents/context.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import type {LlmRequest} from '../../src/models/llm_request.js';
import {BigQueryAgentAnalyticsPlugin} from '../../src/plugins/bigquery_agent_analytics_plugin.js';
import type {BigQueryLoggerConfig} from '../../src/plugins/bigquery_analytics_config.js';
import type {AnalyticsRow} from '../../src/plugins/bigquery_analytics_schema.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';

const {BigQueryMock, StorageMock, inserted, saved} = vi.hoisted(() => {
  const inserted: AnalyticsRow[] = [];
  const saved: string[] = [];

  class FakeTable {
    async exists(): Promise<[boolean]> {
      return [true];
    }

    async getMetadata(): Promise<[unknown]> {
      return [{schema: {fields: []}, labels: {adk_schema_version: '2'}}];
    }

    async setMetadata(metadata: unknown): Promise<[unknown]> {
      return [metadata];
    }

    async insert(rows: Array<{json: AnalyticsRow}>): Promise<void> {
      for (const row of rows) {
        inserted.push(row.json);
      }
    }
  }

  class FakeDataset {
    async exists(): Promise<[boolean]> {
      return [true];
    }

    table(): FakeTable {
      return new FakeTable();
    }
  }

  class BigQueryMock {
    dataset(): FakeDataset {
      return new FakeDataset();
    }

    async query(): Promise<[unknown[]]> {
      return [[]];
    }
  }

  class StorageMock {
    bucket() {
      return {
        file: (path: string) => ({
          save: async () => {
            saved.push(path);
          },
        }),
      };
    }
  }

  return {BigQueryMock, StorageMock, inserted, saved};
});

vi.mock('@google-cloud/bigquery', () => ({BigQuery: BigQueryMock}));
vi.mock('@google-cloud/storage', () => ({Storage: StorageMock}));

/** Text that exceeds the 32 KiB inline byte limit by one character. */
const OVERSIZED_TEXT = 'A'.repeat(32 * 1024 + 1);

function makePlugin(
  config: BigQueryLoggerConfig,
): BigQueryAgentAnalyticsPlugin {
  return new BigQueryAgentAnalyticsPlugin({
    projectId: 'test-project',
    datasetId: 'agent_analytics',
    config,
  });
}

function makeInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'agent', model: 'gemini-2.0-flash'}),
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'user-1',
    }),
    pluginManager: new PluginManager([]),
  });
}

function makeLlmRequest(overrides: Partial<LlmRequest>): LlmRequest {
  return {
    model: 'gemini-2.0-flash',
    contents: [],
    liveConnectConfig: {},
    toolsDict: {},
    ...overrides,
  };
}

describe('BigQueryAgentAnalyticsPlugin content offload', () => {
  beforeEach(() => {
    inserted.length = 0;
    saved.length = 0;
  });

  it('names the object after the span the event belongs to', async () => {
    const plugin = makePlugin({gcsBucketName: 'b'});
    const invocationContext = makeInvocationContext();
    const callbackContext = new Context({invocationContext});

    await plugin.beforeModelCallback({
      callbackContext,
      llmRequest: makeLlmRequest({
        contents: [{parts: [{text: OVERSIZED_TEXT}]}],
      }),
    });
    await plugin.flush();

    expect(saved).toHaveLength(1);
    expect(saved[0]).toContain(
      `/${inserted[0].trace_id}/${inserted[0].span_id}_`,
    );
  });

  it('still writes a row for an event that has no open span', async () => {
    const plugin = makePlugin({gcsBucketName: 'b'});

    // `afterModelCallback` opens no span of its own, so the row carries a null
    // `span_id` and the plugin builds no offload destination for it. The
    // response payload is a summary object rather than a `Content`, so it
    // yields no content parts either; the assertion below pins the row, not
    // the skipped destination.
    await plugin.afterModelCallback({
      callbackContext: new Context({
        invocationContext: makeInvocationContext(),
      }),
      llmResponse: {
        content: {role: 'model', parts: [{text: OVERSIZED_TEXT}]},
      },
    });
    await plugin.flush();

    expect(inserted[0].span_id).toBeNull();
    expect(inserted[0].content_parts).toEqual([]);
    expect(saved).toEqual([]);
  });

  it('offloads nothing when no bucket is configured', async () => {
    const plugin = makePlugin({});

    await plugin.onUserMessageCallback({
      invocationContext: makeInvocationContext(),
      userMessage: {role: 'user', parts: [{text: OVERSIZED_TEXT}]},
    });
    await plugin.flush();

    expect(saved).toEqual([]);
    expect(inserted[0].content_parts[0].storage_mode).toBe('INLINE');
  });
});
