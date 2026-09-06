/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseMemoryService,
  Context,
  createSession,
  InvocationContext,
  MemoryEntry,
  PluginManager,
  SearchMemoryResponse,
} from '@google/adk';

/**
 * A memory service that returns a fixed list of entries, as a Memory Bank
 * backend does when a remembered turn holds no text.
 * `InMemoryMemoryService` cannot produce such an entry: it skips an event
 * whose parts hold no words.
 */
export class FixedMemoryService implements BaseMemoryService {
  constructor(private readonly memories: MemoryEntry[]) {}

  async addSessionToMemory(): Promise<void> {}

  async searchMemory(): Promise<SearchMemoryResponse> {
    return {memories: this.memories};
  }
}

/**
 * Builds a real `Context` over a real `InvocationContext` and `Session`, so a
 * memory tool runs against the same plumbing the agent request loop uses.
 */
export function createMemoryToolContext(
  memories: MemoryEntry[],
  memoryService: BaseMemoryService = new FixedMemoryService(memories),
): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'test-invocation',
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
    memoryService,
    userContent: {role: 'user', parts: [{text: 'hello'}]},
  });
  return new Context({invocationContext});
}
