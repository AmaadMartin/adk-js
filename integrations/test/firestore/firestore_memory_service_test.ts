/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Firestore} from '@google-cloud/firestore';
import {createEvent, createSession, getLogger, setLogger} from '@google/adk';
import {FirestoreMemoryService} from '@google/adk-integrations';
import {createUserContent} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {extractKeywords} from '../../src/firestore/firestore_memory_service.js';
import {DEFAULT_STOP_WORDS} from '../../src/firestore/stop_words.js';
import {FakeFirestore} from './firestore_memory_test_doubles.js';

vi.mock('@google-cloud/firestore', async () => {
  const doubles = await import('./firestore_memory_test_doubles.js');
  return {Firestore: doubles.FakeFirestore};
});

const APP_NAME = 'test_app';
const USER_ID = 'test_user';
const TIMESTAMP_MS = 1234567890000;
const TIMESTAMP_ISO = '2009-02-13T23:31:30.000Z';

describe('FirestoreMemoryService', () => {
  let warnings: string[] = [];
  let previousLogger = getLogger();

  beforeEach(() => {
    FakeFirestore.reset();
    warnings = [];
    previousLogger = getLogger();
    setLogger({
      setLogLevel: () => {},
      log: () => {},
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => {
        warnings.push(args.map((arg) => String(arg)).join(' '));
      },
      error: () => {},
    });
  });

  afterEach(() => {
    setLogger(previousLogger);
  });

  describe('options', () => {
    it('reads and writes a custom memories collection', async () => {
      const {service, store} = createService({memoriesCollection: 'notes'});

      await service.addSessionToMemory(
        sessionWith(
          createEvent({
            author: 'user',
            content: createUserContent('quick brown fox'),
            timestamp: TIMESTAMP_MS,
          }),
        ),
      );
      const response = await search(service, 'quick');

      expect(store.collectionCalls).toEqual(['notes', 'notes']);
      expect(store.documents[0].collectionPath).toBe('notes');
      expect(response.memories).toHaveLength(1);
    });

    it('replaces the default stop words rather than extending them', async () => {
      const {service, store} = createService({
        stopWords: new Set(['quick']),
      });

      await search(service, 'the quick');

      expect(keywordLanes(store)).toEqual(['the']);
    });

    it('filters nothing when the stop words are empty', async () => {
      const {service, store} = createService({stopWords: new Set()});

      await search(service, 'the and or');

      expect(keywordLanes(store)).toEqual(['the', 'and', 'or']);
    });

    it('extends the default stop words when the caller spreads them', async () => {
      const {service, store} = createService({
        stopWords: new Set([...DEFAULT_STOP_WORDS, 'agent']),
      });

      await search(service, 'the agent quick');

      expect(keywordLanes(store)).toEqual(['quick']);
    });

    it('issues one lane per distinct query keyword', async () => {
      const {service, store} = createService();

      await search(service, 'quick quick fox');

      expect(keywordLanes(store)).toEqual(['quick', 'fox']);
    });
  });

  describe('addSessionToMemory', () => {
    it('skips an event that carries no content', async () => {
      const {service, store} = createService();

      await service.addSessionToMemory(
        sessionWith(createEvent({author: 'user'})),
      );

      expect(store.batches[0].sets).toEqual([]);
    });

    it('skips an event whose parts carry no text', async () => {
      const {service, store} = createService();

      await service.addSessionToMemory(
        sessionWith(
          createEvent({
            author: 'user',
            content: {
              role: 'user',
              parts: [{inlineData: {mimeType: 'image/png', data: 'AAAA'}}],
            },
          }),
        ),
      );

      expect(store.batches[0].sets).toEqual([]);
    });

    it('skips an event whose content has no parts', async () => {
      const {service, store} = createService();

      await service.addSessionToMemory(
        sessionWith(createEvent({author: 'user', content: {role: 'user'}})),
      );

      expect(store.batches[0].sets).toEqual([]);
    });

    it('drops the undefined fields of the stored content', async () => {
      const {service, store} = createService();

      await service.addSessionToMemory(
        sessionWith(
          createEvent({
            author: 'user',
            content: {role: undefined, parts: [{text: 'quick', thought: true}]},
          }),
        ),
      );

      expect(store.batches[0].sets[0].data['content']).toEqual({
        parts: [{text: 'quick', thought: true}],
      });
    });

    it('round-trips a written event through a search', async () => {
      const {service} = createService();

      await service.addSessionToMemory(
        sessionWith(
          createEvent({
            author: 'model',
            content: createUserContent('the quick brown fox'),
            timestamp: TIMESTAMP_MS,
          }),
        ),
      );
      const response = await search(service, 'fox');

      expect(response.memories).toEqual([
        {
          content: {role: 'user', parts: [{text: 'the quick brown fox'}]},
          author: 'model',
          timestamp: TIMESTAMP_ISO,
        },
      ]);
    });

    it('does not return a memory written for another user', async () => {
      const {service} = createService();

      await service.addSessionToMemory(
        createSession({
          id: 'other_session',
          appName: APP_NAME,
          userId: 'other_user',
          events: [
            createEvent({
              author: 'user',
              content: createUserContent('quick brown fox'),
            }),
          ],
        }),
      );
      const response = await search(service, 'quick');

      expect(response.memories).toEqual([]);
    });
  });

  describe('searchMemory', () => {
    it('returns both entries when only their timestamps differ', async () => {
      const {service, store} = createService();
      const document = {
        appName: APP_NAME,
        userId: USER_ID,
        keywords: ['quick'],
        author: 'user',
        content: createUserContent('quick brown fox'),
      };
      store.seed('memories', {...document, timestamp: TIMESTAMP_MS});
      store.seed('memories', {...document, timestamp: TIMESTAMP_MS + 1000});

      const response = await search(service, 'quick');

      expect(response.memories.map((entry) => entry.timestamp)).toEqual([
        TIMESTAMP_ISO,
        '2009-02-13T23:31:31.000Z',
      ]);
    });

    it('keeps the author and timestamp of a stored content with no parts', async () => {
      const {service, store} = createService();
      store.seed('memories', {
        appName: APP_NAME,
        userId: USER_ID,
        keywords: ['quick'],
        author: 'model',
        content: {role: 'model'},
        timestamp: TIMESTAMP_MS,
      });

      const response = await search(service, 'quick');

      expect(response.memories).toEqual([
        {content: {role: 'model'}, author: 'model', timestamp: TIMESTAMP_ISO},
      ]);
    });

    it('reads a missing author as an empty string', async () => {
      const {service, store} = createService();
      store.seed('memories', {
        appName: APP_NAME,
        userId: USER_ID,
        keywords: ['quick'],
        content: createUserContent('quick brown fox'),
        timestamp: TIMESTAMP_MS,
      });

      const response = await search(service, 'quick');

      expect(response.memories[0].author).toBe('');
    });

    it('reads a missing timestamp as the epoch', async () => {
      const {service, store} = createService();
      store.seed('memories', {
        appName: APP_NAME,
        userId: USER_ID,
        keywords: ['quick'],
        author: 'user',
        content: createUserContent('quick brown fox'),
      });

      const response = await search(service, 'quick');

      expect(response.memories[0].timestamp).toBe('1970-01-01T00:00:00.000Z');
    });

    it('reads a timestamp no Date can hold as the epoch', async () => {
      const {service, store} = createService();
      store.seed('memories', {
        appName: APP_NAME,
        userId: USER_ID,
        keywords: ['quick'],
        author: 'user',
        content: createUserContent('quick brown fox'),
        timestamp: Number.NaN,
      });

      const response = await search(service, 'quick');

      expect(response.memories[0].timestamp).toBe('1970-01-01T00:00:00.000Z');
    });

    it('skips a document that stores no content, without warning', async () => {
      const {service, store} = createService();
      store.seed('memories', {
        appName: APP_NAME,
        userId: USER_ID,
        keywords: ['quick'],
        author: 'user',
      });

      const response = await search(service, 'quick');

      expect(response.memories).toEqual([]);
      expect(warnings).toEqual([]);
    });

    it.each([
      ['null', null],
      ['an array', [{text: 'quick'}]],
    ])(
      'warns and skips a document whose content is %s',
      async (_label, content) => {
        const {service, store} = createService();
        store.seed('memories', {
          appName: APP_NAME,
          userId: USER_ID,
          keywords: ['quick'],
          author: 'user',
          content,
        });

        const response = await search(service, 'quick');

        expect(response.memories).toEqual([]);
        expect(warnings.join('\n')).toContain('Failed to parse memory entry');
      },
    );
  });

  describe('extractKeywords', () => {
    it('drops every one of the 133 default stop words', () => {
      expect(DEFAULT_STOP_WORDS.size).toBe(133);
      expect(
        extractKeywords([...DEFAULT_STOP_WORDS].join(' '), DEFAULT_STOP_WORDS),
      ).toEqual(new Set());
    });

    it('drops digits and non-ASCII letters', () => {
      expect(
        extractKeywords(
          '42 3.14 ドキュメント Привет Ωμέγα',
          DEFAULT_STOP_WORDS,
        ),
      ).toEqual(new Set());
      expect(extractKeywords('quick42fox', DEFAULT_STOP_WORDS)).toEqual(
        new Set(['quick', 'fox']),
      );
    });
  });
});

/** Builds a service over a fresh fake client. */
function createService(
  options: {
    memoriesCollection?: string;
    stopWords?: ReadonlySet<string>;
  } = {},
): {service: FirestoreMemoryService; store: FakeFirestore} {
  const client = new Firestore();
  return {
    service: new FirestoreMemoryService({client, ...options}),
    store: FakeFirestore.latest(),
  };
}

/** Wraps events in a session scoped to the shared app and user. */
function sessionWith(...events: ReturnType<typeof createEvent>[]) {
  return createSession({
    id: 'test_session',
    appName: APP_NAME,
    userId: USER_ID,
    events,
  });
}

/** Searches the shared scope. */
function search(service: FirestoreMemoryService, query: string) {
  return service.searchMemory({appName: APP_NAME, userId: USER_ID, query});
}

/** The keyword each lane queried, in lane order. */
function keywordLanes(store: FakeFirestore): unknown[] {
  return store.whereCalls
    .filter((call) => call.opStr === 'array-contains')
    .map((call) => call.value);
}
