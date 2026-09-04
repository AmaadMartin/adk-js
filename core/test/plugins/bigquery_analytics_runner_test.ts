/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {LlmAgent} from '../../src/agents/llm_agent.js';
import {Event} from '../../src/events/event.js';
import {BigQueryAgentAnalyticsPlugin} from '../../src/plugins/bigquery_agent_analytics_plugin.js';
import {AnalyticsRow} from '../../src/plugins/bigquery_analytics_schema.js';
import {Runner} from '../../src/runner/runner.js';
import {InMemorySessionService} from '../../src/sessions/in_memory_session_service.js';
import {FunctionTool} from '../../src/tools/function_tool.js';
import {ScriptedLlm} from '../workflow/test_helpers.js';

const {BigQueryMock, inserted} = vi.hoisted(() => {
  const inserted: AnalyticsRow[] = [];

  class FakeTable {
    async exists(): Promise<[boolean]> {
      return [true];
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
  }

  return {BigQueryMock, inserted};
});

vi.mock('@google-cloud/bigquery', () => ({BigQuery: BigQueryMock}));

const APP_NAME = 'analytics_runner_app';
const USER_ID = 'u1';

/** A tool the scripted model calls once, so the run produces tool rows. */
const lookupTool = new FunctionTool({
  name: 'lookup',
  description: 'looks a city up',
  parameters: z.object({city: z.string()}),
  execute: async () => ({temperature: 21}),
});

/**
 * Drives one full turn through the real {@link Runner} and returns the rows the
 * plugin wrote. The model calls `lookup`, then answers, which is the shortest
 * script that reaches every lifecycle callback the plugin listens to.
 */
async function runOneTurn(): Promise<AnalyticsRow[]> {
  const analytics = new BigQueryAgentAnalyticsPlugin({
    projectId: 'test-project',
    datasetId: 'agent_analytics',
  });
  const agent = new LlmAgent({
    name: 'weather_agent',
    model: new ScriptedLlm([
      {functionCall: {id: 'fc-1', name: 'lookup', args: {city: 'SFO'}}},
      'It is 21 degrees in SFO.',
    ]),
    tools: [lookupTool],
  });
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
  const runner = new Runner({
    appName: APP_NAME,
    agent,
    sessionService,
    plugins: [analytics],
  });

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'weather in SFO?'}]},
  })) {
    events.push(event);
  }
  await analytics.shutdown();
  expect(events.length).toBeGreaterThan(0);
  return [...inserted];
}

beforeEach(() => {
  inserted.length = 0;
});

describe('BigQueryAgentAnalyticsPlugin driven by the real Runner', () => {
  it('writes the full ordered row sequence for one tool-calling turn', async () => {
    const rows = await runOneTurn();
    expect(rows.map((row) => row.event_type)).toEqual([
      'USER_MESSAGE_RECEIVED',
      'INVOCATION_STARTING',
      'LLM_REQUEST',
      'LLM_RESPONSE',
      'TOOL_STARTING',
      'TOOL_COMPLETED',
      'LLM_REQUEST',
      'LLM_RESPONSE',
      'AGENT_RESPONSE',
      'INVOCATION_COMPLETED',
    ]);
  });

  it('writes no agent row, because adk-js never fires the agent hooks', async () => {
    const rows = await runOneTurn();
    expect(
      rows.filter((row) => row.event_type.startsWith('AGENT_STARTING')),
    ).toEqual([]);
    expect(
      rows.filter((row) => row.event_type.startsWith('AGENT_COMPLETED')),
    ).toEqual([]);
  });

  it('shares one trace id across every row of the invocation', async () => {
    const rows = await runOneTurn();
    expect(new Set(rows.map((row) => row.trace_id)).size).toBe(1);
  });

  it('closes the span tree, so every parent id names a span it also wrote', async () => {
    const rows = await runOneTurn();
    const spanIds = new Set(rows.map((row) => row.span_id));
    const parents = rows
      .map((row) => row.parent_span_id)
      .filter((id): id is string => id !== undefined && id !== null);
    expect(parents.length).toBeGreaterThan(0);
    expect(parents.filter((id) => !spanIds.has(id))).toEqual([]);
  });

  it('carries the session and the invocation the Runner assigned', async () => {
    const rows = await runOneTurn();
    const invocationIds = new Set(rows.map((row) => row.invocation_id));
    expect(invocationIds.size).toBe(1);
    for (const row of rows) {
      expect(row.user_id).toBe(USER_ID);
      expect(row.session_id).toBeTruthy();
    }
  });

  it('records the tool call and its result on the tool rows', async () => {
    const rows = await runOneTurn();
    const toolRows = rows.filter((row) => row.event_type.startsWith('TOOL_'));
    expect(toolRows.map((row) => row.event_type)).toEqual([
      'TOOL_STARTING',
      'TOOL_COMPLETED',
    ]);
    for (const row of toolRows) {
      expect(row.agent).toBe('weather_agent');
      expect(String(row.content)).toContain('lookup');
    }
  });
});
