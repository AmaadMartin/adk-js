/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  InMemoryMemoryService,
  InMemorySessionService,
  SearchMemoryResponse,
  createEvent,
  createSession,
} from '@google/adk';
import {beforeEach, describe, expect, it} from 'vitest';

function textEvent(id: string, text: string) {
  return createEvent({
    id,
    author: 'user',
    content: {role: 'user', parts: [{text}]},
  });
}

function memoryTexts(response: SearchMemoryResponse) {
  return response.memories.map((memory) => memory.content.parts?.[0]?.text);
}

describe('InMemoryMemoryService', () => {
  let service: InMemoryMemoryService;
  let sessionService: InMemorySessionService;

  beforeEach(() => {
    service = new InMemoryMemoryService();
    sessionService = new InMemorySessionService();
  });

  describe('addSessionToMemory', () => {
    it('stores events that have content parts', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].content).toEqual(event.content);
    });

    it('filters out events with no content parts', async () => {
      const emptyEvent = createEvent({author: 'user'});
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event: emptyEvent});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('stores events under the correct appName/userId key', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const sessionAlice = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session: sessionAlice, event});

      const sessionBob = await sessionService.createSession({
        appName: 'myApp',
        userId: 'bob',
      });

      await service.addSessionToMemory(sessionAlice);
      await service.addSessionToMemory(sessionBob);

      const aliceResult = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });
      const bobResult = await service.searchMemory({
        appName: 'myApp',
        userId: 'bob',
        query: 'hello',
      });

      expect(aliceResult.memories).toHaveLength(1);
      expect(bobResult.memories).toHaveLength(0);
    });
  });

  describe('searchMemory', () => {
    it('returns empty memories when no session added for user', async () => {
      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'unknown',
        query: 'hello',
      });

      expect(result.memories).toEqual([]);
    });

    it('returns matching memory entries for keyword query', async () => {
      const event = createEvent({
        author: 'agent',
        content: {role: 'model', parts: [{text: 'the weather is sunny today'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'weather',
      });

      expect(result.memories).toHaveLength(1);
      expect(result.memories[0].author).toBe('agent');
    });

    it('returns no matches when query has no overlapping words', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'goodbye',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('matches case-insensitively', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'Hello World'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(1);
    });

    it('does not return memories from a different user', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'secret info'}]},
      });
      const sessionAlice = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session: sessionAlice, event});

      await service.addSessionToMemory(sessionAlice);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'bob',
        query: 'secret',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('does not return memories from a different app', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'appA',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'appB',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(0);
    });

    it('includes author and ISO timestamp in returned memory entries', async () => {
      const timestamp = new Date('2024-01-15T10:30:00.000Z').getTime();
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
        timestamp,
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories[0].author).toBe('user');
      expect(result.memories[0].timestamp).toBe('2024-01-15T10:30:00.000Z');
    });

    it('matches any word in a multi-word query', async () => {
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'python programming language'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'irrelevant python',
      });

      expect(result.memories).toHaveLength(1);
    });
  });

  describe('prototype pollution', () => {
    it('indexes a session whose id is __proto__', async () => {
      // `session.id` comes off the request path and holds no `/`, so unlike
      // the user key it can be exactly `__proto__`. On a plain inner map that
      // key re-parents the map instead of creating an own property, and the
      // `Object.values` scan in `searchMemory` then steps over the session.
      const event = createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello world'}]},
      });
      const session = await sessionService.createSession({
        appName: 'myApp',
        userId: 'alice',
        sessionId: '__proto__',
      });
      await sessionService.appendEvent({session, event});

      await service.addSessionToMemory(session);

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'hello',
      });

      expect(result.memories).toHaveLength(1);
    });
  });

  describe('addEventsToMemory', () => {
    it('ingests an explicit event list', async () => {
      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: 'session-1',
        events: [textEvent('event-1a', 'The ADK is a great toolkit.')],
      });

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'toolkit',
      });

      expect(memoryTexts(result)).toEqual(['The ADK is a great toolkit.']);
    });

    it('collects events into one bucket when no sessionId is given', async () => {
      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        events: [textEvent('event-1', 'the first fact')],
      });
      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        events: [textEvent('event-2', 'the second fact')],
      });

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'fact',
      });

      expect(memoryTexts(result)).toEqual([
        'the first fact',
        'the second fact',
      ]);
    });

    it('appends to a session without replacing its events', async () => {
      await service.addSessionToMemory(
        createSession({
          id: 'session-1',
          appName: 'myApp',
          userId: 'alice',
          events: [
            textEvent('event-1a', 'The deploy is ready.'),
            textEvent('event-1c', 'The deploy failed.'),
          ],
        }),
      );

      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: 'session-1',
        events: [textEvent('event-1d', 'A new deploy fact.')],
      });

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'deploy',
      });

      expect(memoryTexts(result)).toEqual([
        'The deploy is ready.',
        'The deploy failed.',
        'A new deploy fact.',
      ]);
    });

    it('skips an event whose id is already in the bucket', async () => {
      await service.addSessionToMemory(
        createSession({
          id: 'session-1',
          appName: 'myApp',
          userId: 'alice',
          events: [
            textEvent('event-1a', 'The deploy is ready.'),
            textEvent('event-1c', 'The deploy failed.'),
          ],
        }),
      );

      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: 'session-1',
        events: [textEvent('event-1a', 'Updated deploy text.')],
      });

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'deploy',
      });

      expect(memoryTexts(result)).toEqual([
        'The deploy is ready.',
        'The deploy failed.',
      ]);
    });

    it('does not store events with no content parts', async () => {
      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: 'session-1',
        events: [
          createEvent({id: 'event-no-content', author: 'user'}),
          createEvent({
            id: 'event-no-parts',
            author: 'user',
            content: {role: 'user'},
          }),
          textEvent('event-kept', 'the stored fact'),
        ],
      });

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'fact',
      });

      expect(memoryTexts(result)).toEqual(['the stored fact']);
    });

    it('ignores customMetadata', async () => {
      await service.addEventsToMemory({
        appName: 'myApp',
        userId: 'alice',
        sessionId: 'session-1',
        events: [textEvent('event-1a', 'the stored fact')],
        customMetadata: {scope: 'ignored'},
      });

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'fact',
      });

      expect(memoryTexts(result)).toEqual(['the stored fact']);
    });
  });

  describe('searchMemory ranking', () => {
    it('ranks events by the number of matching query words', async () => {
      await service.addSessionToMemory(
        createSession({
          id: 'session-ranked',
          appName: 'myApp',
          userId: 'alice',
          events: [
            textEvent('ranked-a', 'The deploy is ready.'),
            textEvent('ranked-b', 'Ready.'),
            textEvent('ranked-c', 'The deploy status is ready.'),
          ],
        }),
      );

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'deploy status ready',
      });

      expect(memoryTexts(result)).toEqual([
        'The deploy status is ready.',
        'The deploy is ready.',
        'Ready.',
      ]);
    });

    it('returns at most ten memories, best match first', async () => {
      const events = Array.from({length: 20}, (unused, index) =>
        textEvent(`note-${index}`, `note ${index} about work`),
      );
      events.push(textEvent('backlog', 'the backlog note about work'));
      await service.addSessionToMemory(
        createSession({
          id: 'session-many',
          appName: 'myApp',
          userId: 'alice',
          events,
        }),
      );

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'work backlog note',
      });

      expect(memoryTexts(result)).toEqual([
        'the backlog note about work',
        ...Array.from(
          {length: 9},
          (unused, index) => `note ${index} about work`,
        ),
      ]);
    });
  });

  describe('tokenization', () => {
    it('matches tokens that contain digits or underscores', async () => {
      await service.addSessionToMemory(
        createSession({
          id: 'session-tokens',
          appName: 'myApp',
          userId: 'alice',
          events: [textEvent('event-build', 'build_id 4242 finished')],
        }),
      );

      const byNumber = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: '4242',
      });
      const byName = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'build_id',
      });

      expect(memoryTexts(byNumber)).toEqual(['build_id 4242 finished']);
      expect(memoryTexts(byName)).toEqual(['build_id 4242 finished']);
    });

    it('skips parts that carry no text', async () => {
      const event = createEvent({
        id: 'event-mixed',
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {text: ''},
            {inlineData: {mimeType: 'image/png', data: 'AAAA'}},
            {text: 'the chart is attached'},
          ],
        },
      });
      await service.addSessionToMemory(
        createSession({
          id: 'session-mixed',
          appName: 'myApp',
          userId: 'alice',
          events: [event],
        }),
      );

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: 'chart',
      });

      expect(result.memories).toHaveLength(1);
    });

    it('skips an event whose text holds no words', async () => {
      await service.addSessionToMemory(
        createSession({
          id: 'session-punctuation',
          appName: 'myApp',
          userId: 'alice',
          events: [textEvent('event-punctuation', '... !!! ...')],
        }),
      );

      const result = await service.searchMemory({
        appName: 'myApp',
        userId: 'alice',
        query: '...',
      });

      expect(result.memories).toEqual([]);
    });

    it.each<[string, string, number]>([
      ['私の名前は太郎です', '太郎', 1],
      ['私の名前は太郎です', '天気', 0],
      ['我喜欢机器学习', '机器学习', 1],
      ['我喜欢机器学习', '天气预报', 0],
      ['제 이름은 민수입니다', '민수입니다', 1],
      ['Меня зовут Алексей', 'Алексей', 1],
      ['太郎 works at ABC Corp', '太郎', 1],
      ['太郎 works at ABC Corp', 'ABC', 1],
      ['I like to code in Python.', 'thon', 0],
    ])(
      'returns %i memories for %s searched with %s',
      async (eventText, query, expectedCount) => {
        await service.addSessionToMemory(
          createSession({
            id: 'session-i18n',
            appName: 'myApp',
            userId: 'alice',
            events: [textEvent('event-i18n', eventText)],
          }),
        );

        const result = await service.searchMemory({
          appName: 'myApp',
          userId: 'alice',
          query,
        });

        expect(result.memories).toHaveLength(expectedCount);
      },
    );
  });

  describe('user key scoping', () => {
    it('does not collide when an identifier contains a slash', async () => {
      await service.addSessionToMemory(
        createSession({
          id: 'session-slashed-app',
          appName: 'app/other-user',
          userId: 'user',
          events: [textEvent('event-slashed-app', 'This is a secret.')],
        }),
      );

      const aliased = await service.searchMemory({
        appName: 'app',
        userId: 'other-user/user',
        query: 'secret',
      });
      const owner = await service.searchMemory({
        appName: 'app/other-user',
        userId: 'user',
        query: 'secret',
      });

      expect(aliased.memories).toEqual([]);
      expect(memoryTexts(owner)).toEqual(['This is a secret.']);
    });
  });
});
