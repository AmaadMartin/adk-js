/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  ActiveStreamingTool,
  Context,
  createSession,
  InvocationContext,
  LiveRequestQueue,
  LongRunningFunctionTool,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const LONG_RUNNING_INSTRUCTION = `\n\nNOTE: This is a long-running operation. Do not call this tool again if it has already returned some intermediate or pending status.`;

describe('LongRunningFunctionTool', () => {
  it('sets isLongRunning to true', () => {
    const tool = new LongRunningFunctionTool({
      name: 'my_tool',
      description: 'Does something.',
      execute: async () => 'done',
    });

    expect(tool.isLongRunning).toBe(true);
  });

  it('appends long-running instruction to existing description', () => {
    const tool = new LongRunningFunctionTool({
      name: 'my_tool',
      description: 'Does something.',
      execute: async () => 'done',
    });

    const declaration = tool._getDeclaration();
    expect(declaration.description).toBe(
      'Does something.' + LONG_RUNNING_INSTRUCTION,
    );
  });

  it('sets long-running instruction as description when none provided', () => {
    const tool = new LongRunningFunctionTool({
      name: 'my_tool',
      description: '',
      execute: async () => 'done',
    });

    const declaration = tool._getDeclaration();
    expect(declaration.description).toBe(LONG_RUNNING_INSTRUCTION.trimStart());
  });

  it('preserves the tool name in declaration', () => {
    const tool = new LongRunningFunctionTool({
      name: 'background_task',
      description: 'Runs a background task.',
      execute: async () => null,
    });

    const declaration = tool._getDeclaration();
    expect(declaration.name).toBe('background_task');
  });

  it('executes the underlying function via runAsync', async () => {
    const tool = new LongRunningFunctionTool({
      name: 'compute',
      description: 'Computes a value.',
      execute: async () => 42,
    });

    const result = await tool.runAsync({
      args: {},
      toolContext: {} as never,
    });

    expect(result).toBe(42);
  });

  it('receives the live input stream registered under its name', async () => {
    const stream = new LiveRequestQueue();
    let received: LiveRequestQueue | undefined;
    const tool = new LongRunningFunctionTool({
      name: 'watch_feed',
      description: 'Watches the live input stream.',
      execute: (_input, _toolContext, inputStream) => {
        received = inputStream;
        return 'done';
      },
    });
    const toolContext = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'test-invocation',
        session: createSession({id: 'test-session', appName: 'test-app'}),
        pluginManager: new PluginManager([]),
        activeStreamingTools: {watch_feed: new ActiveStreamingTool({stream})},
      }),
    });

    const result = await tool.runAsync({args: {}, toolContext});

    expect(received).toBe(stream);
    expect(result).toBe('done');
  });
});
