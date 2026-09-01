/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
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
 * The MCP debug capture writes onto the invocation, so the tests need a
 * genuine context rather than a cast-over-nothing stub.
 *
 * @return The invocation context.
 */
export function createTestInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.0-flash'}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
    sessionService: new InMemorySessionService(),
  });
}

/** A readonly context over {@link createTestInvocationContext}. */
export function createTestReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(createTestInvocationContext());
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
