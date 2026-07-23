/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';

import {Client} from '@google-cloud/vertexai';
import {
  createEvent,
  createSession,
  VertexAiRagMemoryService,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The installed @google-cloud/vertexai SDK has no `rag` binding, so a real
// Client is only ever constructed (never called) on the no-injected-client
// path. Mock it so we can assert the derived project/location without network.
vi.mock('@google-cloud/vertexai', () => ({Client: vi.fn()}));

const SOURCE_DISPLAY_NAME_PREFIX = 'adk-memory-v1.';

/** Mirrors the production encoding so tests can build expected display names. */
function encodePart(value: string): string {
  return Buffer.from(value, 'utf-8').toString('base64url');
}

function buildDisplayName(
  appName: string,
  userId: string,
  sessionId: string,
): string {
  return (
    SOURCE_DISPLAY_NAME_PREFIX +
    [encodePart(appName), encodePart(userId), encodePart(sessionId)].join('.')
  );
}

interface RagContextFixture {
  sourceDisplayName?: unknown;
  text?: string;
}

/** Builds a retrieveContexts response with a single JSON line per context. */
function ragContext(
  sourceDisplayName: unknown,
  text: string,
): RagContextFixture {
  return {
    sourceDisplayName,
    text: JSON.stringify({author: 'user', timestamp: 1, text}),
  };
}

function retrieveResponse(contexts: RagContextFixture[]) {
  return {contexts: {contexts}};
}

interface MockRagClient {
  rag: {
    uploadFile: ReturnType<typeof vi.fn>;
    retrieveContexts: ReturnType<typeof vi.fn>;
  };
}

function createMockClient(): MockRagClient {
  return {
    rag: {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      retrieveContexts: vi.fn().mockResolvedValue(retrieveResponse([])),
    },
  };
}

describe('VertexAiRagMemoryService', () => {
  let mockClient: MockRagClient;
  const savedEnv = {...process.env};

  beforeEach(() => {
    mockClient = createMockClient();
    vi.mocked(Client).mockClear();
    delete process.env['GOOGLE_CLOUD_PROJECT'];
    delete process.env['GOOGLE_CLOUD_LOCATION'];
  });

  afterEach(() => {
    process.env = {...savedEnv};
  });

  function newService(
    options: ConstructorParameters<typeof VertexAiRagMemoryService>[0] = {},
  ): VertexAiRagMemoryService {
    return new VertexAiRagMemoryService({
      client: mockClient as unknown as Client,
      ...options,
    });
  }

  describe('constructor', () => {
    it('derives project/location from a full corpus name', () => {
      new VertexAiRagMemoryService({
        ragCorpus: 'projects/my-proj/locations/us-west1/ragCorpora/my-corpus',
      });

      expect(Client).toHaveBeenCalledWith({
        project: 'my-proj',
        location: 'us-west1',
      });
    });

    it('prefers explicit options over environment variables', () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'env-proj';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'env-loc';

      new VertexAiRagMemoryService({
        projectId: 'opt-proj',
        location: 'opt-loc',
        ragCorpus: 'projects/corpus-proj/locations/corpus-loc/ragCorpora/c',
      });

      expect(Client).toHaveBeenCalledWith({
        project: 'opt-proj',
        location: 'opt-loc',
      });
    });

    it('falls back to environment variables', () => {
      process.env['GOOGLE_CLOUD_PROJECT'] = 'env-proj';
      process.env['GOOGLE_CLOUD_LOCATION'] = 'env-loc';

      new VertexAiRagMemoryService({ragCorpus: 'bare-corpus-id'});

      expect(Client).toHaveBeenCalledWith({
        project: 'env-proj',
        location: 'env-loc',
      });
    });

    it('only derives the missing coordinate from the corpus', () => {
      new VertexAiRagMemoryService({
        projectId: 'opt-proj',
        ragCorpus: 'projects/corpus-proj/locations/corpus-loc/ragCorpora/c',
      });

      expect(Client).toHaveBeenCalledWith({
        project: 'opt-proj',
        location: 'corpus-loc',
      });
    });

    it('ignores a corpus that is not a valid resource path', () => {
      new VertexAiRagMemoryService({ragCorpus: 'projects/only/two'});

      expect(Client).toHaveBeenCalledWith({
        project: undefined,
        location: undefined,
      });
    });

    it('uses an injected client instead of constructing one', () => {
      newService({ragCorpus: 'c'});
      expect(Client).not.toHaveBeenCalled();
    });

    it('builds a VertexRagStore carrying similarityTopK and threshold', async () => {
      const service = newService({ragCorpus: 'my-corpus', similarityTopK: 7});
      await service.searchMemory({
        appName: 'app',
        userId: 'user',
        query: 'q',
      });

      expect(mockClient.rag.retrieveContexts).toHaveBeenCalledWith({
        vertexRagStore: {
          ragResources: [{ragCorpus: 'my-corpus'}],
          similarityTopK: 7,
          vectorDistanceThreshold: 10,
        },
        query: {text: 'q', similarityTopK: 7},
      });
    });

    it('honors an explicit vectorDistanceThreshold', async () => {
      const service = newService({
        ragCorpus: 'my-corpus',
        vectorDistanceThreshold: 3,
      });
      await service.searchMemory({appName: 'a', userId: 'u', query: 'q'});

      expect(
        mockClient.rag.retrieveContexts.mock.calls[0][0].vertexRagStore
          .vectorDistanceThreshold,
      ).toBe(3);
    });
  });

  describe('addSessionToMemory', () => {
    it('uploads only text-bearing events with an unambiguous name', async () => {
      let uploadedText: string | undefined;
      let uploadedDisplayName: string | undefined;
      mockClient.rag.uploadFile.mockImplementation(
        async (params: {path: string; displayName: string}) => {
          uploadedText = await readFile(params.path, 'utf-8');
          uploadedDisplayName = params.displayName;
        },
      );

      const service = newService({ragCorpus: 'my-corpus'});
      const session = createSession({
        id: 'session-1',
        appName: 'demo',
        userId: 'alice',
        events: [
          createEvent({author: 'user'}), // no content -> skipped
          createEvent({
            author: 'model',
            content: {parts: [{functionCall: {name: 'x', args: {}}}]},
          }), // parts but no text -> skipped
          createEvent({
            author: 'user',
            timestamp: 1000,
            content: {parts: [{text: 'first\nline'}, {text: 'second'}]},
          }),
        ],
      });

      await service.addSessionToMemory(session);

      expect(mockClient.rag.uploadFile).toHaveBeenCalledTimes(1);
      expect(uploadedDisplayName).toBe(
        buildDisplayName('demo', 'alice', 'session-1'),
      );
      const lines = uploadedText!.split('\n');
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0])).toEqual({
        author: 'user',
        timestamp: 1000,
        text: 'first line.second',
      });
    });

    it('throws when no rag resources are configured', async () => {
      const service = newService();
      const session = createSession({
        id: 's',
        appName: 'a',
        userId: 'u',
        events: [
          createEvent({author: 'user', content: {parts: [{text: 'hi'}]}}),
        ],
      });

      await expect(service.addSessionToMemory(session)).rejects.toThrow(
        'Rag resources must be set.',
      );
      expect(mockClient.rag.uploadFile).not.toHaveBeenCalled();
    });

    it('removes the temp file even when the upload fails', async () => {
      let capturedPath: string | undefined;
      mockClient.rag.uploadFile.mockImplementation(
        async (params: {path: string}) => {
          capturedPath = params.path;
          expect(existsSync(params.path)).toBe(true);
          throw new Error('upload failed');
        },
      );

      const service = newService({ragCorpus: 'my-corpus'});
      const session = createSession({
        id: 's',
        appName: 'a',
        userId: 'u',
        events: [
          createEvent({author: 'user', content: {parts: [{text: 'hi'}]}}),
        ],
      });

      await expect(service.addSessionToMemory(session)).rejects.toThrow(
        'upload failed',
      );
      expect(capturedPath).toBeDefined();
      expect(existsSync(capturedPath!)).toBe(false);
    });
  });

  describe('searchMemory', () => {
    it('rejects ambiguous and legacy display names', async () => {
      mockClient.rag.retrieveContexts.mockResolvedValue(
        retrieveResponse([
          ragContext('demo.alice.smith.session_secret', 'SECRET'),
          ragContext(
            buildDisplayName('demo', 'alice', 'session_ok'),
            'NORMAL_ALICE_MEMORY',
          ),
          ragContext('demo.alice.legacy_session', 'LEGACY_ALICE_MEMORY'),
          ragContext('demo.bob.session_other', 'BOB_MEMORY'),
        ]),
      );

      const service = newService({ragCorpus: 'unused'});
      const {memories} = await service.searchMemory({
        appName: 'demo',
        userId: 'alice',
        query: 'secret',
      });

      expect(memories.map((m) => m.content.parts![0].text)).toEqual([
        'NORMAL_ALICE_MEMORY',
        'LEGACY_ALICE_MEMORY',
      ]);
    });

    it('round-trips added memory through unambiguous display names', async () => {
      let displayName: string | undefined;
      mockClient.rag.uploadFile.mockImplementation(
        async (params: {displayName: string}) => {
          displayName = params.displayName;
        },
      );

      const service = newService({ragCorpus: 'my-corpus'});
      await service.addSessionToMemory(
        createSession({
          id: 'session.secret',
          appName: 'demo.app',
          userId: 'alice.smith',
          events: [
            createEvent({
              author: 'user',
              timestamp: 1,
              content: {parts: [{text: 'sensitive memory'}]},
            }),
          ],
        }),
      );

      expect(displayName!.startsWith(SOURCE_DISPLAY_NAME_PREFIX)).toBe(true);
      expect(displayName).not.toBe('demo.app.alice.smith.session.secret');

      mockClient.rag.retrieveContexts.mockResolvedValue(
        retrieveResponse([ragContext(displayName, 'sensitive memory')]),
      );

      const {memories} = await service.searchMemory({
        appName: 'demo.app',
        userId: 'alice.smith',
        query: 'sensitive',
      });
      expect(memories.map((m) => m.content.parts![0].text)).toEqual([
        'sensitive memory',
      ]);
    });

    it('round-trips unicode and padding-variant identities', async () => {
      let displayName: string | undefined;
      mockClient.rag.uploadFile.mockImplementation(
        async (params: {displayName: string}) => {
          displayName = params.displayName;
        },
      );

      const service = newService({ragCorpus: 'my-corpus'});
      await service.addSessionToMemory(
        createSession({
          id: 's', // 1 byte -> distinct base64 padding length
          appName: '应用',
          userId: '用户🎉',
          events: [
            createEvent({
              author: 'user',
              timestamp: 5,
              content: {parts: [{text: 'unicode memory'}]},
            }),
          ],
        }),
      );

      mockClient.rag.retrieveContexts.mockResolvedValue(
        retrieveResponse([ragContext(displayName, 'unicode memory')]),
      );

      const {memories} = await service.searchMemory({
        appName: '应用',
        userId: '用户🎉',
        query: 'unicode',
      });
      expect(memories.map((m) => m.content.parts![0].text)).toEqual([
        'unicode memory',
      ]);
    });

    it('drops prefixed names with the wrong part count or corrupt base64', async () => {
      const wrongCount =
        SOURCE_DISPLAY_NAME_PREFIX +
        [encodePart('a'), encodePart('b')].join('.');
      const corrupt =
        SOURCE_DISPLAY_NAME_PREFIX +
        ['not_valid_base64!!!', encodePart('alice'), encodePart('s')].join('.');

      mockClient.rag.retrieveContexts.mockResolvedValue(
        retrieveResponse([
          ragContext(wrongCount, 'WRONG_COUNT'),
          ragContext(corrupt, 'CORRUPT'),
          ragContext(buildDisplayName('demo', 'alice', 'ok'), 'KEPT'),
        ]),
      );

      const service = newService({ragCorpus: 'unused'});
      const {memories} = await service.searchMemory({
        appName: 'demo',
        userId: 'alice',
        query: 'q',
      });
      expect(memories.map((m) => m.content.parts![0].text)).toEqual(['KEPT']);
    });

    it('skips non-string display names, blank lines, and non-JSON lines', async () => {
      const displayName = buildDisplayName('demo', 'alice', 'session_ok');
      mockClient.rag.retrieveContexts.mockResolvedValue(
        retrieveResponse([
          {sourceDisplayName: 42, text: 'ignored'}, // non-string -> skipped
          {sourceDisplayName: undefined, text: 'ignored'}, // missing -> skipped
          {
            sourceDisplayName: displayName,
            text: [
              JSON.stringify({author: 'user', timestamp: 3000, text: 'third'}),
              '',
              'this is not json',
              JSON.stringify({author: 'user', timestamp: 1000, text: 'first'}),
            ].join('\n'),
          },
          {sourceDisplayName: displayName, text: undefined}, // no text -> empty
        ]),
      );

      const service = newService({ragCorpus: 'unused'});
      const {memories} = await service.searchMemory({
        appName: 'demo',
        userId: 'alice',
        query: 'q',
      });

      expect(memories.map((m) => m.content.parts![0].text)).toEqual([
        'first',
        'third',
      ]);
      expect(memories[0].timestamp).toBe(new Date(1000).toISOString());
      expect(memories[0].author).toBe('user');
    });

    it('merges overlapping event lists and keeps disjoint lists separate', async () => {
      const displayName = buildDisplayName('demo', 'alice', 'session_ok');
      const line = (timestamp: number, text: string) =>
        JSON.stringify({author: 'user', timestamp, text});

      mockClient.rag.retrieveContexts.mockResolvedValue(
        retrieveResponse([
          {sourceDisplayName: displayName, text: line(1000, 'A1')},
          {
            sourceDisplayName: displayName,
            text: [line(3000, 'B3'), line(2000, 'B2')].join('\n'),
          },
          {
            sourceDisplayName: displayName,
            text: [line(1000, 'C1'), line(2000, 'C2')].join('\n'),
          },
          {sourceDisplayName: displayName, text: line(9000, 'D9')},
        ]),
      );

      const service = newService({ragCorpus: 'unused'});
      const {memories} = await service.searchMemory({
        appName: 'demo',
        userId: 'alice',
        query: 'q',
      });

      // t1 from A, t2 from C (seen before B), t3 from B; t9 disjoint list.
      expect(memories.map((m) => m.content.parts![0].text)).toEqual([
        'A1',
        'C2',
        'B3',
        'D9',
      ]);
    });

    it('applies defaults for missing event fields', async () => {
      const displayName = buildDisplayName('demo', 'alice', 'ok');
      mockClient.rag.retrieveContexts.mockResolvedValue(
        retrieveResponse([{sourceDisplayName: displayName, text: '{}'}]),
      );

      const service = newService({ragCorpus: 'unused'});
      const {memories} = await service.searchMemory({
        appName: 'demo',
        userId: 'alice',
        query: 'q',
      });

      expect(memories).toHaveLength(1);
      expect(memories[0].author).toBe('');
      expect(memories[0].content.parts![0].text).toBe('');
      expect(memories[0].timestamp).toBe(new Date(0).toISOString());
    });

    it('returns no memories for an empty context list', async () => {
      mockClient.rag.retrieveContexts.mockResolvedValue(retrieveResponse([]));
      const service = newService({ragCorpus: 'unused'});
      const {memories} = await service.searchMemory({
        appName: 'demo',
        userId: 'alice',
        query: 'q',
      });
      expect(memories).toEqual([]);
    });

    it('tolerates a response missing the contexts field', async () => {
      mockClient.rag.retrieveContexts.mockResolvedValue({});
      const service = newService({ragCorpus: 'unused'});
      const {memories} = await service.searchMemory({
        appName: 'demo',
        userId: 'alice',
        query: 'q',
      });
      expect(memories).toEqual([]);
    });
  });
});
