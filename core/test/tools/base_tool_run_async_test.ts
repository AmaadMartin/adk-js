/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  RunAsyncToolRequest,
  ToolErrorType,
  ToolExecutionError,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** A tool the model runs, so it never implements `runAsync`. */
class DeclarationOnlyTool extends BaseTool {}

/** A tool the client runs, so it implements `runAsync`. */
class EchoTool extends BaseTool {
  override async runAsync({args}: RunAsyncToolRequest): Promise<unknown> {
    return args;
  }
}

function createRequest(): RunAsyncToolRequest {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager([]),
  });
  return {args: {}, toolContext: new Context({invocationContext})};
}

describe('BaseTool.runAsync', () => {
  it('rejects when the subclass does not implement it', async () => {
    const tool = new DeclarationOnlyTool({
      name: 'server_side_tool',
      description: 'Runs in the model.',
    });

    await expect(tool.runAsync(createRequest())).rejects.toBeInstanceOf(
      ToolExecutionError,
    );
  });

  it('names the tool in the rejection message', async () => {
    const tool = new DeclarationOnlyTool({
      name: 'server_side_tool',
      description: 'Runs in the model.',
    });

    await expect(tool.runAsync(createRequest())).rejects.toThrow(
      'Tool server_side_tool does not implement runAsync.',
    );
  });

  it('rejects with the internal server error type', async () => {
    const tool = new DeclarationOnlyTool({
      name: 'server_side_tool',
      description: 'Runs in the model.',
    });

    await expect(tool.runAsync(createRequest())).rejects.toMatchObject({
      errorType: ToolErrorType.INTERNAL_SERVER_ERROR,
    });
  });

  it('runs the subclass implementation when there is one', async () => {
    const tool = new EchoTool({
      name: 'echo_tool',
      description: 'Echoes its arguments.',
    });
    const request = createRequest();
    request.args = {city: 'Seattle'};

    await expect(tool.runAsync(request)).resolves.toEqual({city: 'Seattle'});
  });
});
