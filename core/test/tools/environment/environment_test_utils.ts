/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';

/**
 * Builds a real tool context for the environment tool tests.
 *
 * adk-python passes `tool_context=None`; adk-js types it as a {@link Context},
 * so the tests construct one rather than cast a literal. The environment tools
 * do not read it, so the contents only have to be valid.
 */
export function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'environment-tool-test',
      agent: new LlmAgent({name: 'environment_tool_test_agent'}),
      session: createSession({
        id: 'environment-tool-test-session',
        appName: 'environment-tool-test',
        userId: 'environment-tool-test-user',
      }),
      pluginManager: new PluginManager([]),
    }),
  });
}
