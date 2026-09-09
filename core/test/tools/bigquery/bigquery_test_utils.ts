/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  createSession,
} from '@google/adk';

/**
 * Builds a real {@link Context} over a real session, so that the fixtures
 * break if the context contract changes.
 *
 * @param options.sessionId Distinguishes the sessions of concurrent calls.
 * @param options.functionCallId Required by `requestCredential`.
 * @param options.state Initial session state.
 * @return The tool context.
 */
export function createToolContext(
  options: {
    sessionId?: string;
    functionCallId?: string;
    state?: Record<string, unknown>;
  } = {},
): Context {
  const session = createSession({
    id: options.sessionId ?? 'session-1',
    appName: 'bigquery-app',
    userId: 'user-1',
    state: options.state,
  });
  const invocationContext = new InvocationContext({
    invocationId: `inv-${session.id}`,
    agent: new LlmAgent({name: 'bq_agent', model: 'gemini-2.5-flash'}),
    session,
    pluginManager: new PluginManager([]),
  });
  return new Context({
    invocationContext,
    functionCallId: options.functionCallId ?? 'fc-1',
  });
}
