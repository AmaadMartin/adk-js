/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseCodeExecutor,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  PluginManager,
  ReadonlyContext,
  Session,
} from '@google/adk';

/**
 * Options for {@link createInvocationContext} and the context factories built
 * on top of it.
 */
interface InvocationContextOptions {
  /** Name of the agent that owns the invocation. */
  agentName?: string;
  /** Initial session state, readable through `context.state`. */
  state?: Record<string, unknown>;
  /** Code executor carried by the agent that owns the invocation. */
  codeExecutor?: BaseCodeExecutor;
  /** Session to run against. Defaults to a fresh one seeded with `state`. */
  session?: Session;
  /** Signal that cancels the invocation. */
  abortSignal?: AbortSignal;
}

/**
 * Builds a real {@link InvocationContext} for tests, so that a change to
 * `InvocationContextParams` is a compile error in the fixtures rather than a
 * runtime surprise.
 *
 * The defaults are rebuilt on every call: tools under test mutate
 * `session.state` in place, so a shared session would leak between tests.
 */
export function createInvocationContext(
  options: InvocationContextOptions = {},
): InvocationContext {
  const {
    agentName = 'test-agent',
    state = {},
    codeExecutor,
    session,
    abortSignal,
  } = options;
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: agentName, codeExecutor}),
    session:
      session ??
      createSession({
        id: 'test-session',
        appName: 'test-app',
        userId: 'test-user',
        state,
      }),
    pluginManager: new PluginManager([]),
    abortSignal,
  });
}

/**
 * Creates a real {@link ReadonlyContext} backed by a real
 * {@link InvocationContext}, for tests that need to pass a context to an API
 * without standing up a runner.
 */
export function createReadonlyContext(
  options: InvocationContextOptions = {},
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
