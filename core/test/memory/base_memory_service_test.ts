/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  addEventsToMemory,
  addMemory,
  createEvent,
  InMemoryMemoryService,
  NotImplementedError,
  type AddEventsToMemoryRequest,
  type AddMemoryRequest,
  type BaseMemoryService,
  type MemoryEntry,
  type SearchMemoryResponse,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const EMPTY_RESPONSE: SearchMemoryResponse = {memories: []};

const MEMORIES: MemoryEntry[] = [
  {content: {role: 'user', parts: [{text: 'prefers metric units'}]}},
];

const SESSION = {
  id: 'session-1',
  appName: 'myApp',
  userId: 'alice',
  state: {},
  events: [],
  lastUpdateTime: 0,
};

/** A service that implements only the two required members. */
function createRequiredOnlyService(): BaseMemoryService {
  return {
    async addSessionToMemory() {},
    async searchMemory() {
      return EMPTY_RESPONSE;
    },
  };
}

describe('BaseMemoryService contract', () => {
  it('accepts a service that implements only the two required members', async () => {
    const service = createRequiredOnlyService();

    await service.addSessionToMemory(SESSION);
    const response = await service.searchMemory({
      appName: 'myApp',
      userId: 'alice',
      query: 'hello',
    });

    expect(response).toEqual(EMPTY_RESPONSE);
    expect(service.addEventsToMemory).toBeUndefined();
    expect(service.addMemory).toBeUndefined();
  });

  it('passes an event delta to a service that implements addEventsToMemory', async () => {
    const received: AddEventsToMemoryRequest[] = [];
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      async addEventsToMemory(request) {
        received.push(request);
      },
    };
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

    await service.addEventsToMemory?.(request);

    expect(received).toEqual([request]);
  });

  it('leaves sessionId and customMetadata absent when the caller omits them', async () => {
    let received: AddEventsToMemoryRequest | undefined;
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      async addEventsToMemory(request) {
        received = request;
      },
    };

    await service.addEventsToMemory?.({
      appName: 'myApp',
      userId: 'alice',
      events: [],
    });

    if (!received) {
      expect.fail('addEventsToMemory was not called');
    }
    expect('sessionId' in received).toBe(false);
    expect('customMetadata' in received).toBe(false);
    expect(received.events).toEqual([]);
  });

  it('passes memory items to a service that implements addMemory', async () => {
    const received: AddMemoryRequest[] = [];
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      async addMemory(request) {
        received.push(request);
      },
    };
    const request: AddMemoryRequest = {
      appName: 'myApp',
      userId: 'alice',
      memories: MEMORIES,
      customMetadata: {ttl: '3600s'},
    };

    await service.addMemory?.(request);

    expect(received).toEqual([request]);
  });

  it('propagates an error thrown by an optional member', async () => {
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      async addMemory() {
        throw new Error('memories must not be empty');
      },
    };

    await expect(
      service.addMemory?.({appName: 'myApp', userId: 'alice', memories: []}),
    ).rejects.toThrow('memories must not be empty');
  });
});

describe('addEventsToMemory', () => {
  it('rejects with NotImplementedError when the service omits the member', async () => {
    const rejection = addEventsToMemory(createRequiredOnlyService(), {
      appName: 'myApp',
      userId: 'alice',
      events: [],
    });

    await expect(rejection).rejects.toBeInstanceOf(NotImplementedError);
    await expect(rejection).rejects.toThrow(
      'does not support adding event deltas',
    );
    await expect(rejection).rejects.toThrow('addSessionToMemory(session)');
  });

  it('delegates the whole request when the service implements the member', async () => {
    const received: AddEventsToMemoryRequest[] = [];
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      async addEventsToMemory(request) {
        received.push(request);
      },
    };
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

    await expect(addEventsToMemory(service, request)).resolves.toBeUndefined();

    expect(received).toEqual([request]);
    expect(received[0].customMetadata).toEqual({ttl: '3600s'});
    expect(received[0].sessionId).toBe('session-1');
  });

  it('does not add sessionId or customMetadata the caller omitted', async () => {
    let received: AddEventsToMemoryRequest | undefined;
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      async addEventsToMemory(request) {
        received = request;
      },
    };

    await addEventsToMemory(service, {
      appName: 'myApp',
      userId: 'alice',
      events: [],
    });

    if (!received) {
      expect.fail('addEventsToMemory was not called');
    }
    expect('sessionId' in received).toBe(false);
    expect('customMetadata' in received).toBe(false);
  });

  it('surfaces an implementation error unchanged', async () => {
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      async addEventsToMemory() {
        throw new Error('events must contain at least one entry.');
      },
    };

    const rejection = addEventsToMemory(service, {
      appName: 'myApp',
      userId: 'alice',
      events: [],
    });

    await expect(rejection).rejects.toThrow(
      'events must contain at least one entry.',
    );
    await expect(rejection).rejects.not.toBeInstanceOf(NotImplementedError);
  });

  it('reports InMemoryMemoryService as not supporting event deltas', async () => {
    await expect(
      addEventsToMemory(new InMemoryMemoryService(), {
        appName: 'myApp',
        userId: 'alice',
        events: [],
      }),
    ).rejects.toBeInstanceOf(NotImplementedError);
  });
});

describe('addMemory', () => {
  it('rejects with NotImplementedError when the service omits the member', async () => {
    const rejection = addMemory(createRequiredOnlyService(), {
      appName: 'myApp',
      userId: 'alice',
      memories: MEMORIES,
    });

    await expect(rejection).rejects.toBeInstanceOf(NotImplementedError);
    await expect(rejection).rejects.toThrow(
      'does not support direct memory writes',
    );
    await expect(rejection).rejects.toThrow('addEventsToMemory(...)');
    await expect(rejection).rejects.toThrow('addSessionToMemory(session)');
  });

  it('delegates the whole request when the service implements the member', async () => {
    const received: AddMemoryRequest[] = [];
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      async addMemory(request) {
        received.push(request);
      },
    };
    const request: AddMemoryRequest = {
      appName: 'myApp',
      userId: 'alice',
      memories: MEMORIES,
      customMetadata: {ttl: '3600s'},
    };

    await expect(addMemory(service, request)).resolves.toBeUndefined();

    expect(received).toEqual([request]);
    expect(received[0].customMetadata).toEqual({ttl: '3600s'});
  });

  it('surfaces an implementation error unchanged', async () => {
    const service: BaseMemoryService = {
      ...createRequiredOnlyService(),
      async addMemory() {
        throw new Error('memories must contain at least one entry.');
      },
    };

    const rejection = addMemory(service, {
      appName: 'myApp',
      userId: 'alice',
      memories: [],
    });

    await expect(rejection).rejects.toThrow(
      'memories must contain at least one entry.',
    );
    await expect(rejection).rejects.not.toBeInstanceOf(NotImplementedError);
  });

  it('reports InMemoryMemoryService as not supporting direct writes', async () => {
    const rejection = addMemory(new InMemoryMemoryService(), {
      appName: 'myApp',
      userId: 'alice',
      memories: MEMORIES,
    });

    await expect(rejection).rejects.toBeInstanceOf(NotImplementedError);
    await expect(rejection).rejects.toThrow(
      'does not support direct memory writes',
    );
  });
});
