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
  LlmRequest,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';

/**
 * Options for {@link createReadonlyContext}.
 */
interface ReadonlyContextOptions {
  /** Name of the agent that owns the invocation. */
  agentName?: string;
  /** Initial session state, readable through `context.state`. */
  state?: Record<string, unknown>;
}

/** Builds the invocation that backs the context factories below. */
function createInvocationContext(
  options: ReadonlyContextOptions = {},
): InvocationContext {
  const {agentName = 'test-agent', state = {}} = options;
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: agentName}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      state,
    }),
    pluginManager: new PluginManager([]),
  });
}

/**
 * Creates a real {@link ReadonlyContext} backed by a real
 * {@link InvocationContext}, for tests that need to pass a context to an API
 * without standing up a runner.
 */
export function createReadonlyContext(
  options: ReadonlyContextOptions = {},
): ReadonlyContext {
  return new ReadonlyContext(createInvocationContext(options));
}

/**
 * Creates a real {@link Context} for tests that invoke a tool directly, so the
 * tool runs against the same plumbing the agent request loop hands it.
 */
export function createToolContext(): Context {
  return new Context({invocationContext: createInvocationContext()});
}

/**
 * Creates a minimal, fully typed {@link LlmRequest}. Any field may be replaced
 * through `overrides`.
 */
export function createLlmRequest(
  overrides: Partial<LlmRequest> = {},
): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}, ...overrides};
}
