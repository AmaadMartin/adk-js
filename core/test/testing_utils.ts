/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';

/**
 * Options for {@link createReadonlyContext}.
 */
export interface ReadonlyContextOptions {
  /** Name of the agent that owns the invocation. */
  agentName?: string;
  /** Initial session state, readable through `context.state`. */
  state?: Record<string, unknown>;
  /** Id of the invocation. */
  invocationId?: string;
}

/**
 * Creates a real {@link ReadonlyContext} backed by a real
 * {@link InvocationContext}, for tests that need to pass a context to an API
 * without standing up a runner.
 */
export function createReadonlyContext(
  options: ReadonlyContextOptions = {},
): ReadonlyContext {
  const {
    agentName = 'test-agent',
    state = {},
    invocationId = 'test-invocation',
  } = options;
  return new ReadonlyContext(
    new InvocationContext({
      invocationId,
      agent: new LlmAgent({name: agentName}),
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state,
      }),
      pluginManager: new PluginManager([]),
    }),
  );
}
