/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
} from '@google/adk';
import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {vi} from 'vitest';

/**
 * Builds a real invocation context for the MCP tests.
 *
 * The MCP header provider and progress factory receive a context, so the tests
 * need a genuine one rather than a cast-over-nothing stub.
 *
 * @param state The initial session state the context exposes.
 * @return The invocation context.
 */
export function createTestInvocationContext(
  state: Record<string, unknown> = {},
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      state,
    }),
    pluginManager: new PluginManager([]),
    sessionService: new InMemorySessionService(),
  });
}

/** A readonly context over {@link createTestInvocationContext}. */
export function createTestReadonlyContext(
  state: Record<string, unknown> = {},
): ReadonlyContext {
  return new ReadonlyContext(createTestInvocationContext(state));
}

/**
 * A tool context over {@link createTestInvocationContext}.
 *
 * It carries a function call id, because a real tool call always has one and
 * `requestConfirmation` refuses to run without it.
 */
export function createTestToolContext(
  state: Record<string, unknown> = {},
): Context {
  return new Context({
    invocationContext: createTestInvocationContext(state),
    functionCallId: 'test-function-call-id',
  });
}

/**
 * Builds an MCP `Client` test double.
 *
 * `Client` is a class with private state, so no object literal satisfies it
 * structurally. The cast every stub needs is confined to this one helper
 * instead of being repeated at each stub site.
 *
 * @param parts The client methods the test under exercise actually calls.
 * @return The stub, typed as a `Client`.
 */
export function clientStub(parts: Partial<Client>): Client {
  return {
    connect: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
    ...parts,
  } as Client;
}
