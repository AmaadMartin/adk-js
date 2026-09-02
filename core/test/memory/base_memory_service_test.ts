/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE,
  EVENT_DELTAS_UNSUPPORTED_MESSAGE,
  addEventsToMemory,
  addMemory,
  createEvent,
  type AddEventsToMemoryRequest,
  type AddMemoryRequest,
  type BaseMemoryService,
  type MemoryEntry,
  type SearchMemoryResponse,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const EMPTY_RESPONSE: SearchMemoryResponse = {memories: []};

/** A service that implements only the two required members. */
function createRequiredOnlyService() {
  return {
    addSessionToMemory: vi.fn(async () => {}),
    searchMemory: vi.fn(async () => EMPTY_RESPONSE),
  } satisfies BaseMemoryService;
}

function createEventWritingService() {
  return {
    ...createRequiredOnlyService(),
    addEventsToMemory: vi.fn(async (_request: AddEventsToMemoryRequest) => {}),
  } satisfies BaseMemoryService;
}

function createMemoryWritingService() {
  return {
    ...createRequiredOnlyService(),
    addMemory: vi.fn(async (_request: AddMemoryRequest) => {}),
  } satisfies BaseMemoryService;
}

describe('addEventsToMemory', () => {
  it('forwards the full request to a service that implements the member', async () => {
    const service = createEventWritingService();
    const request: AddEventsToMemoryRequest = {
      appName: 'myApp',
      userId: 'alice',
      events: [
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'hello world'}]},
        }),
      ],
      sessionId: 'session-1',
      customMetadata: {ttl: '3600s'},
    };

    await addEventsToMemory(service, request);

    expect(service.addEventsToMemory).toHaveBeenCalledTimes(1);
    expect(service.addEventsToMemory).toHaveBeenCalledWith(request);
    expect(service.addEventsToMemory.mock.calls[0][0]).toBe(request);
  });

  it('forwards a request whose sessionId and customMetadata are absent', async () => {
    const service = createEventWritingService();
    const request: AddEventsToMemoryRequest = {
      appName: 'myApp',
      userId: 'alice',
      events: [createEvent({author: 'user'})],
    };

    await addEventsToMemory(service, request);

    const received = service.addEventsToMemory.mock.calls[0][0];
    expect('sessionId' in received).toBe(false);
    expect('customMetadata' in received).toBe(false);
  });

  it('forwards an empty events array without special-casing it', async () => {
    const service = createEventWritingService();

    await addEventsToMemory(service, {
      appName: 'myApp',
      userId: 'alice',
      events: [],
    });

    expect(service.addEventsToMemory).toHaveBeenCalledTimes(1);
    expect(service.addEventsToMemory.mock.calls[0][0].events).toEqual([]);
  });

  it('rejects when the service omits the member and calls nothing else', async () => {
    const service = createRequiredOnlyService();

    await expect(
      addEventsToMemory(service, {
        appName: 'myApp',
        userId: 'alice',
        events: [],
      }),
    ).rejects.toThrow(EVENT_DELTAS_UNSUPPORTED_MESSAGE);
    expect(service.addSessionToMemory).not.toHaveBeenCalled();
    expect(service.searchMemory).not.toHaveBeenCalled();
  });

  it('propagates an error thrown by the implementing member', async () => {
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      addEventsToMemory: async () => {
        throw new Error('quota exhausted');
      },
    };

    await expect(
      addEventsToMemory(service, {
        appName: 'myApp',
        userId: 'alice',
        events: [],
      }),
    ).rejects.toThrow('quota exhausted');
  });
});

describe('addMemory', () => {
  const memories: MemoryEntry[] = [
    {content: {role: 'user', parts: [{text: 'prefers metric units'}]}},
  ];

  it('forwards the full request to a service that implements the member', async () => {
    const service = createMemoryWritingService();
    const request: AddMemoryRequest = {
      appName: 'myApp',
      userId: 'alice',
      memories,
      customMetadata: {ttl: '3600s'},
    };

    await addMemory(service, request);

    expect(service.addMemory).toHaveBeenCalledTimes(1);
    expect(service.addMemory).toHaveBeenCalledWith(request);
    expect(service.addMemory.mock.calls[0][0]).toBe(request);
  });

  it('forwards a request whose customMetadata is absent', async () => {
    const service = createMemoryWritingService();

    await addMemory(service, {appName: 'myApp', userId: 'alice', memories});

    const received = service.addMemory.mock.calls[0][0];
    expect('customMetadata' in received).toBe(false);
    expect(received.memories).toEqual(memories);
  });

  it('rejects when the service omits the member', async () => {
    const service = createRequiredOnlyService();

    await expect(
      addMemory(service, {appName: 'myApp', userId: 'alice', memories}),
    ).rejects.toThrow(DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE);
    expect(service.addSessionToMemory).not.toHaveBeenCalled();
    expect(service.searchMemory).not.toHaveBeenCalled();
  });

  it('propagates an error thrown by the implementing member', async () => {
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      addMemory: async () => {
        throw new Error('memories must not be empty');
      },
    };

    await expect(
      addMemory(service, {appName: 'myApp', userId: 'alice', memories: []}),
    ).rejects.toThrow('memories must not be empty');
  });
});

describe('BaseMemoryService contract', () => {
  it('keeps the unsupported-path messages that adk-python raises', () => {
    expect(EVENT_DELTAS_UNSUPPORTED_MESSAGE).toBe(
      'This memory service does not support adding event deltas. ' +
        'Call addSessionToMemory(session) to ingest the full session.',
    );
    expect(DIRECT_MEMORY_WRITES_UNSUPPORTED_MESSAGE).toBe(
      'This memory service does not support direct memory writes. ' +
        'Call addEventsToMemory(...) or addSessionToMemory(session) instead.',
    );
  });

  it('accepts a service that implements only the two required members', async () => {
    const service: BaseMemoryService = createRequiredOnlyService();
    const session = {
      id: 'session-1',
      appName: 'myApp',
      userId: 'alice',
      state: {},
      events: [],
      lastUpdateTime: 0,
    };

    await service.addSessionToMemory(session);
    const response = await service.searchMemory({
      appName: 'myApp',
      userId: 'alice',
      query: 'hello',
    });

    expect(response).toEqual(EMPTY_RESPONSE);
    expect(service.addEventsToMemory).toBeUndefined();
    expect(service.addMemory).toBeUndefined();
  });
});
