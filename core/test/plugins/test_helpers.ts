/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  Context,
  createSession,
  FunctionTool,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';

/** Options for the invocation and callback contexts the plugin tests drive. */
export interface TestContextOptions {
  /** The branch of the invocation, if the test asserts on one. */
  branch?: string;
  /** The initial session state. */
  state?: Record<string, unknown>;
  /** The id of the function call a tool context belongs to. */
  functionCallId?: string;
}

/** Builds a real invocation context for the plugin callbacks under test. */
export function createTestInvocationContext(
  options: TestContextOptions = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    branch: options.branch,
    agent: new LlmAgent({name: 'test_agent'}),
    session: createSession({
      id: 'session-1',
      appName: 'test-app',
      userId: 'user-1',
      state: options.state,
    }),
    pluginManager: new PluginManager([]),
  });
}

/** Builds a real callback context for the plugin callbacks under test. */
export function createTestContext(options: TestContextOptions = {}): Context {
  return new Context({
    invocationContext: createTestInvocationContext(options),
    functionCallId: options.functionCallId,
  });
}

/** Builds a real tool the plugin callbacks can report on by name. */
export function createTestTool(name: string): BaseTool {
  return new FunctionTool({
    name,
    description: `The ${name} test tool.`,
    execute: async () => ({}),
  });
}
