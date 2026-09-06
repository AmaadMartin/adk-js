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
  ToolConfirmation,
} from '@google/adk';

/**
 * Builds a real `Context` for a tool call.
 *
 * The Python reference tests pass `tool_context=None`. adk-js types the field
 * as `Context`, so the tests build one from real objects instead of casting.
 */
export function makeContext(
  options: {
    functionCallId?: string;
    toolConfirmation?: ToolConfirmation;
  } = {},
): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'environment_agent', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, ...options});
}

/** A `Context` whose tool call is already approved. */
export function makeConfirmedContext(): Context {
  return makeContext({
    functionCallId: 'fc-1',
    toolConfirmation: new ToolConfirmation({confirmed: true}),
  });
}
