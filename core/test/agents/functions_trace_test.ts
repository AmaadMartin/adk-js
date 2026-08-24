/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BaseTool, Session} from '@google/adk';
import {
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import type {FunctionCall} from '@google/genai';
import {createPartFromBase64} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {traceToolCall} from '../../src/telemetry/tracing.js';

vi.mock('../../src/telemetry/tracing.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/telemetry/tracing.js')>();
  return {...actual, traceToolCall: vi.fn()};
});

const {handleFunctionCallList} = functionsExportedForTestingOnly;

const CHART_DATA = 'Y2hhcnQtYnl0ZXM=';

const chartTool = new FunctionTool({
  name: 'chartTool',
  description: 'returns a chart',
  parameters: z.object({}),
  execute: async () => createPartFromBase64(CHART_DATA, 'image/png'),
});

const summaryTool = new FunctionTool({
  name: 'summaryTool',
  description: 'returns a summary',
  parameters: z.object({}),
  execute: async () => ({summary: 'up 3%'}),
});

describe('the traced tool-call event', () => {
  let invocationContext: InvocationContext;

  beforeEach(() => {
    vi.mocked(traceToolCall).mockClear();
    invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {} as Session,
      agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
      pluginManager: new PluginManager(),
    });
  });

  async function tracedResponseFor(tool: BaseTool) {
    const functionCall: FunctionCall = {
      id: 'call_1',
      name: tool.name,
      args: {},
    };
    await handleFunctionCallList({
      invocationContext,
      functionCalls: [functionCall],
      toolsDict: {[tool.name]: tool},
      beforeToolCallbacks: [],
      afterToolCallbacks: [],
    });
    const [params] = vi.mocked(traceToolCall).mock.calls[0];
    return params.functionResponseEvent.content?.parts?.[0].functionResponse;
  }

  it('carries the media the tool returned', async () => {
    const response = await tracedResponseFor(chartTool);

    expect(response?.parts).toEqual([
      {inlineData: {data: CHART_DATA, mimeType: 'image/png'}},
    ]);
    expect(response?.response).toEqual({});
  });

  it('is unchanged for a media-free tool result', async () => {
    const response = await tracedResponseFor(summaryTool);

    expect(response).toStrictEqual({
      id: 'call_1',
      name: 'summaryTool',
      response: {summary: 'up 3%'},
    });
  });
});
