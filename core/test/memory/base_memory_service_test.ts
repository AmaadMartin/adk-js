/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AddMemoryRequest,
  BaseMemoryService,
  DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE,
  EVENT_DELTAS_UNSUPPORTED_MESSAGE,
  InMemoryMemoryService,
  addEventsToMemory,
  addMemory,
  createEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

describe('addEventsToMemory', () => {
  it('rejects when the service does not implement addEventsToMemory', async () => {
    const service: BaseMemoryService = {
      async addSessionToMemory() {},
      async searchMemory() {
        return {memories: []};
      },
    };

    await expect(
      addEventsToMemory(service, {
        appName: 'myApp',
        userId: 'alice',
        events: [],
      }),
    ).rejects.toThrow(EVENT_DELTAS_UNSUPPORTED_MESSAGE);
  });

  it('forwards the request to a service that implements it', async () => {
    const service = new InMemoryMemoryService();

    await addEventsToMemory(service, {
      appName: 'myApp',
      userId: 'alice',
      sessionId: 'session-1',
      events: [
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'hello world'}]},
        }),
      ],
    });

    const result = await service.searchMemory({
      appName: 'myApp',
      userId: 'alice',
      query: 'hello',
    });

    expect(result.memories).toHaveLength(1);
  });
});

describe('addMemory', () => {
  it('reports the same wording as adk-python', () => {
    expect(DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE).toBe(
      'This memory service does not support direct memory writes. ' +
        'Call addEventsToMemory(...) or addSessionToMemory(session) instead.',
    );
  });

  it('rejects when the service does not implement addMemory', async () => {
    const service: BaseMemoryService = {
      async addSessionToMemory() {},
      async searchMemory() {
        return {memories: []};
      },
    };

    await expect(
      addMemory(service, {appName: 'myApp', userId: 'alice', memories: []}),
    ).rejects.toThrow(DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE);
  });

  it('rejects for InMemoryMemoryService', async () => {
    const service = new InMemoryMemoryService();

    await expect(
      addMemory(service, {appName: 'myApp', userId: 'alice', memories: []}),
    ).rejects.toThrow(DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE);
  });

  it('forwards the request to a service that implements it', async () => {
    let received: AddMemoryRequest | undefined;
    const service: BaseMemoryService = {
      async addSessionToMemory() {},
      async searchMemory() {
        return {memories: []};
      },
      async addMemory(request) {
        received = request;
      },
    };
    const request: AddMemoryRequest = {
      appName: 'myApp',
      userId: 'alice',
      memories: [
        {content: {role: 'user', parts: [{text: 'prefers window seats'}]}},
      ],
      customMetadata: {enable_consolidation: true},
    };

    await addMemory(service, request);

    expect(received).toEqual(request);
  });
});
