/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolset,
  Context,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {expect} from 'vitest';

/** Builds the tool context every `runAsync` call requires. */
export async function createToolContext(): Promise<Context> {
  const session = await new InMemorySessionService().createSession({
    appName: 'gcs-test-app',
    userId: 'gcs-test-user',
  });
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'gcs-test-invocation',
      agent: new LlmAgent({name: 'gcs_test_agent'}),
      session,
      pluginManager: new PluginManager(),
    }),
  });
}

/** Returns the named tool of a toolset, failing the test when it is absent. */
export async function getTool(
  toolset: BaseToolset,
  name: string,
): Promise<BaseTool> {
  const tool = (await toolset.getTools()).find((it) => it.name === name);
  if (!tool) {
    expect.fail(`Toolset does not expose a tool named ${name}.`);
  }
  return tool;
}
