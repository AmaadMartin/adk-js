/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  functionsExportedForTestingOnly,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  LongRunningFunctionTool,
  PluginManager,
  Session,
  SingleAfterToolCallback,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {z} from 'zod';

const {handleFunctionCallList} = functionsExportedForTestingOnly;

/** An after-tool callback that records what it was handed and overrides nothing. */
function recordingCallback(
  seen: Array<Record<string, unknown>>,
): SingleAfterToolCallback {
  return async ({response}) => {
    seen.push(response);
    return undefined;
  };
}

function runWith(
  tool: BaseTool,
  afterToolCallbacks: SingleAfterToolCallback[],
): Promise<unknown> {
  const invocationContext = new InvocationContext({
    invocationId: 'inv_123',
    session: {} as Session,
    agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
    pluginManager: new PluginManager(),
  });
  return handleFunctionCallList({
    invocationContext,
    functionCalls: [{id: 'call_1', name: tool.name, args: {}}],
    toolsDict: {[tool.name]: tool},
    beforeToolCallbacks: [],
    afterToolCallbacks,
  });
}

describe('the response an after-tool callback receives', () => {
  it('wraps a tool result that is not a record', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const scalarTool = new FunctionTool({
      name: 'scalarTool',
      description: 'answers with a bare string',
      parameters: z.object({}),
      execute: async () => 'plain text',
    });

    await runWith(scalarTool, [recordingCallback(seen)]);

    expect(seen).toEqual([{result: 'plain text'}]);
  });

  it('is an empty record when the tool answers with nothing', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const deferredTool = new LongRunningFunctionTool({
      name: 'deferredTool',
      description: 'answers later',
      parameters: z.object({}),
      execute: async (_args, _toolContext?: Context) => undefined,
    });

    await runWith(deferredTool, [recordingCallback(seen)]);

    expect(seen).toEqual([{}]);
  });
});
