/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  createSession,
  getLogger,
  MemoryEntry,
  RagApiClient,
  RagContext,
  RagFile,
  Session,
  VertexAiRagMemoryService,
  VertexAiRagMemoryServiceOptions,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {buildSourceDisplayName} from '../../src/memory/rag_memory_transcript.js';

/** Mirrors the page cap the service applies to a corpus listing. */
const MAX_RAG_FILE_PAGES = 10;

const CORPUS = 'projects/test-project/locations/us-central1/ragCorpora/1';

const ALICE_SESSION_1 = buildSourceDisplayName({
  appName: 'demo',
  userId: 'alice',
  sessionId: 'session-1',
});
const ALICE_SESSION_2 = buildSourceDisplayName({
  appName: 'demo',
  userId: 'alice',
  sessionId: 'session-2',
});
const BOB_SESSION = buildSourceDisplayName({
  appName: 'demo',
  userId: 'bob',
  sessionId: 'session-9',
});
const OTHER_APP_SESSION = buildSourceDisplayName({
  appName: 'other',
  userId: 'alice',
  sessionId: 'session-3',
});

const ALICE_REQUEST = {appName: 'demo', userId: 'alice', query: 'memory'};

interface FakeRagApiClient extends RagApiClient {
  listRagFiles: Mock<RagApiClient['listRagFiles']>;
  uploadRagFile: Mock<RagApiClient['uploadRagFile']>;
  retrieveContexts: Mock<RagApiClient['retrieveContexts']>;
}

/** A client that lists one file for `demo`/`alice` and retrieves nothing. */
function createFakeClient(): FakeRagApiClient {
  return {
    listRagFiles: vi
      .fn<RagApiClient['listRagFiles']>()
      .mockResolvedValue({ragFiles: [ragFile('alice-1', ALICE_SESSION_1)]}),
    uploadRagFile: vi
      .fn<RagApiClient['uploadRagFile']>()
      .mockResolvedValue(undefined),
    retrieveContexts: vi
      .fn<RagApiClient['retrieveContexts']>()
      .mockResolvedValue({contexts: {contexts: []}}),
  };
}

function createService(
  client: RagApiClient,
  options: Partial<VertexAiRagMemoryServiceOptions> = {},
): VertexAiRagMemoryService {
  return new VertexAiRagMemoryService({
    ragCorpus: CORPUS,
    ragApiClient: client,
    ...options,
  });
}

function ragContext(sourceDisplayName: string, text: string): RagContext {
  return {
    sourceDisplayName,
    text: JSON.stringify({author: 'user', timestamp: 1, text}),
  };
}

function ragFile(ragFileId: string, displayName: string): RagFile {
  // A listing entry reports the full resource name, not the bare file id.
  return {name: `${CORPUS}/ragFiles/${ragFileId}`, displayName};
}

function memoryTexts(memories: MemoryEntry[]): Array<string | undefined> {
  return memories.map((memory) => memory.content.parts?.[0].text);
}

function retrieveCall(client: FakeRagApiClient, index = 0) {
  return client.retrieveContexts.mock.calls[index][0];
}

/** Silences the warning the unscoped paths emit, and returns the spy. */
function spyOnWarn() {
  return vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
}

function session(): Session {
  return createSession({
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
  });
}

beforeEach(() => {
  // The service reads these, so a developer machine that sets them must not
  // change what the tests observe.
  vi.stubEnv('GOOGLE_CLOUD_PROJECT', '');
  vi.stubEnv('GOOGLE_CLOUD_LOCATION', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('VertexAiRagMemoryService constructor', () => {
  it('takes the project and the location from a qualified corpus name', async () => {
    const client = createFakeClient();

    await createService(client).searchMemory(ALICE_REQUEST);

    expect(retrieveCall(client).parent).toBe(
      'projects/test-project/locations/us-central1',
    );
  });

  it('prefers an explicit project and location over the corpus name', async () => {
    const client = createFakeClient();

    await createService(client, {
      project: 'other-project',
      location: 'europe-west4',
    }).searchMemory(ALICE_REQUEST);

    expect(retrieveCall(client).parent).toBe(
      'projects/other-project/locations/europe-west4',
    );
  });

  it('falls back to the environment for a bare corpus id', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');
    const client = createFakeClient();

    await createService(client, {ragCorpus: 'bare-id'}).searchMemory(
      ALICE_REQUEST,
    );

    expect(retrieveCall(client).parent).toBe(
      'projects/env-project/locations/env-location',
    );
  });

  it('qualifies a bare corpus id on every rag call', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');
    const qualified =
      'projects/env-project/locations/env-location/ragCorpora/bare-id';
    const client = createFakeClient();
    const service = createService(client, {ragCorpus: 'bare-id'});

    await service.addSessionToMemory(session());
    await service.searchMemory(ALICE_REQUEST);

    expect(client.uploadRagFile.mock.calls[0][0].ragCorpus).toBe(qualified);
    expect(client.listRagFiles.mock.calls[0][0].ragCorpus).toBe(qualified);
    expect(retrieveCall(client).vertexRagStore.ragResources).toEqual([
      {ragCorpus: qualified, ragFileIds: ['alice-1']},
    ]);
  });

  it('passes a qualified corpus name through unchanged', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'env-location');
    const client = createFakeClient();

    await createService(client).addSessionToMemory(session());

    expect(client.uploadRagFile.mock.calls[0][0].ragCorpus).toBe(CORPUS);
  });

  it('addresses the project and the location the corpus names, not the environment', async () => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'env-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'europe-west4');
    const client = createFakeClient();

    await createService(client).searchMemory(ALICE_REQUEST);

    expect(retrieveCall(client).parent).toBe(
      'projects/test-project/locations/us-central1',
    );
  });

  it('defers an unresolvable project and location to the first call', async () => {
    const client = createFakeClient();

    const service = createService(client, {ragCorpus: 'bare-id'});

    await expect(service.searchMemory(ALICE_REQUEST)).rejects.toThrow(
      'needs a project and a location',
    );
    expect(client.retrieveContexts).not.toHaveBeenCalled();
  });

  it('sends the default vector distance threshold on the store', async () => {
    const client = createFakeClient();

    await createService(client).searchMemory(ALICE_REQUEST);

    expect(retrieveCall(client).vertexRagStore.vectorDistanceThreshold).toBe(
      10,
    );
  });

  it('sends a configured vector distance threshold on the store', async () => {
    const client = createFakeClient();

    await createService(client, {vectorDistanceThreshold: 0.5}).searchMemory(
      ALICE_REQUEST,
    );

    expect(retrieveCall(client).vertexRagStore.vectorDistanceThreshold).toBe(
      0.5,
    );
  });
});

describe('VertexAiRagMemoryService.searchMemory', () => {
  it('forwards similarityTopK on the query and not on the store', async () => {
    const client = createFakeClient();

    await createService(client, {similarityTopK: 7}).searchMemory(
      ALICE_REQUEST,
    );

    expect(retrieveCall(client).query.ragRetrievalConfig?.topK).toBe(7);
    expect(retrieveCall(client).vertexRagStore.similarityTopK).toBeUndefined();
  });

  it('sends no retrieval config when similarityTopK is unset', async () => {
    const client = createFakeClient();

    await createService(client).searchMemory(ALICE_REQUEST);

    expect(retrieveCall(client).query).toEqual({
      text: 'memory',
      ragRetrievalConfig: undefined,
    });
    expect(retrieveCall(client).vertexRagStore.similarityTopK).toBeUndefined();
  });

  it('scopes the retrieval to the requesting tenant files', async () => {
    const client = createFakeClient();
    client.listRagFiles
      .mockResolvedValueOnce({
        ragFiles: [
          ragFile('alice-1', ALICE_SESSION_1),
          ragFile('bob-1', BOB_SESSION),
        ],
        nextPageToken: 'page-2',
      })
      .mockResolvedValueOnce({
        ragFiles: [
          ragFile('alice-2', 'demo.alice.legacy-session'),
          ragFile('other-app-1', OTHER_APP_SESSION),
        ],
      });
    client.retrieveContexts.mockResolvedValue({
      contexts: {contexts: [ragContext(ALICE_SESSION_1, 'ALICE_MEMORY')]},
    });

    const response = await createService(client, {
      similarityTopK: 5,
    }).searchMemory(ALICE_REQUEST);

    expect(memoryTexts(response.memories)).toEqual(['ALICE_MEMORY']);
    expect(retrieveCall(client).vertexRagStore.ragResources).toEqual([
      {ragCorpus: CORPUS, ragFileIds: ['alice-1', 'alice-2']},
    ]);
    expect(client.listRagFiles).toHaveBeenCalledTimes(2);
    expect(client.listRagFiles.mock.calls[0][0]).toEqual({
      ragCorpus: CORPUS,
      pageSize: 100,
      pageToken: undefined,
    });
    expect(client.listRagFiles.mock.calls[1][0].pageToken).toBe('page-2');
  });

  it('skips the retrieval when the tenant owns no file', async () => {
    const client = createFakeClient();
    client.listRagFiles.mockResolvedValue({
      ragFiles: [ragFile('bob-1', BOB_SESSION)],
    });

    const response = await createService(client).searchMemory(ALICE_REQUEST);

    expect(response.memories).toEqual([]);
    expect(client.retrieveContexts).not.toHaveBeenCalled();
  });

  it('ignores a listed file that has no resource name', async () => {
    const client = createFakeClient();
    client.listRagFiles.mockResolvedValue({
      ragFiles: [{displayName: ALICE_SESSION_1}],
    });

    const response = await createService(client).searchMemory(ALICE_REQUEST);

    expect(response.memories).toEqual([]);
    expect(client.retrieveContexts).not.toHaveBeenCalled();
  });

  it('tolerates a listing page that carries no files', async () => {
    const client = createFakeClient();
    client.listRagFiles.mockResolvedValue({});

    const response = await createService(client).searchMemory(ALICE_REQUEST);

    expect(response.memories).toEqual([]);
    expect(client.retrieveContexts).not.toHaveBeenCalled();
  });

  it('retrieves unscoped when the listing fails', async () => {
    const warn = spyOnWarn();
    const client = createFakeClient();
    client.listRagFiles.mockRejectedValue(new Error('cannot list files'));
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          ragContext(ALICE_SESSION_1, 'ALICE_MEMORY'),
          ragContext(BOB_SESSION, 'BOB_MEMORY'),
        ],
      },
    });

    const response = await createService(client).searchMemory(ALICE_REQUEST);

    expect(memoryTexts(response.memories)).toEqual(['ALICE_MEMORY']);
    expect(
      retrieveCall(client).vertexRagStore.ragResources?.[0].ragFileIds,
    ).toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain('cannot list files');
  });

  it('retrieves unscoped when the corpus does not list within the page cap', async () => {
    const warn = spyOnWarn();
    const client = createFakeClient();
    client.listRagFiles.mockResolvedValue({
      ragFiles: [ragFile('alice-1', ALICE_SESSION_1)],
      nextPageToken: 'another-page',
    });

    await createService(client).searchMemory(ALICE_REQUEST);

    expect(client.listRagFiles).toHaveBeenCalledTimes(MAX_RAG_FILE_PAGES);
    expect(
      retrieveCall(client).vertexRagStore.ragResources?.[0].ragFileIds,
    ).toBeUndefined();
    expect(warn.mock.calls[0][0]).toContain(
      'not scoped to the requesting app and user',
    );
  });

  it('drops contexts whose display name does not resolve to the tenant', async () => {
    spyOnWarn();
    const client = createFakeClient();
    client.listRagFiles.mockRejectedValue(new Error('cannot list files'));
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          ragContext('demo.alice.smith.session_secret', 'SECRET_FROM_SMITH'),
          ragContext(ALICE_SESSION_1, 'NORMAL_ALICE_MEMORY'),
          ragContext('demo.alice.legacy_session', 'LEGACY_ALICE_MEMORY'),
          ragContext('demo.bob.session_other', 'BOB_MEMORY'),
          {text: 'a context with no display name'},
        ],
      },
    });

    const response = await createService(client).searchMemory({
      ...ALICE_REQUEST,
      query: 'secret',
    });

    expect(memoryTexts(response.memories)).toEqual([
      'NORMAL_ALICE_MEMORY',
      'LEGACY_ALICE_MEMORY',
    ]);
  });

  it('tolerates a retrieved context that carries no text', async () => {
    const client = createFakeClient();
    client.retrieveContexts.mockResolvedValue({
      contexts: {contexts: [{sourceDisplayName: ALICE_SESSION_1}]},
    });

    const response = await createService(client).searchMemory(ALICE_REQUEST);

    expect(response.memories).toEqual([]);
  });

  it('tolerates a retrieval response that carries no contexts', async () => {
    const client = createFakeClient();
    client.retrieveContexts.mockResolvedValue({});

    const response = await createService(client).searchMemory(ALICE_REQUEST);

    expect(response.memories).toEqual([]);
  });

  it('renders the event timestamp as an iso-8601 string', async () => {
    const client = createFakeClient();
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          {
            sourceDisplayName: ALICE_SESSION_1,
            text: JSON.stringify({
              author: 'model',
              timestamp: 1735689600000,
              text: 'happy new year',
            }),
          },
        ],
      },
    });

    const response = await createService(client).searchMemory(ALICE_REQUEST);

    expect(response.memories).toEqual([
      {
        author: 'model',
        content: {parts: [{text: 'happy new year'}]},
        timestamp: '2025-01-01T00:00:00.000Z',
      },
    ]);
  });

  it('merges overlapping chunks of one session and keeps sessions apart', async () => {
    const client = createFakeClient();
    const line = (timestamp: number, text: string) =>
      JSON.stringify({author: 'user', timestamp, text});
    client.listRagFiles.mockResolvedValue({
      ragFiles: [
        ragFile('alice-1', ALICE_SESSION_1),
        ragFile('alice-2', ALICE_SESSION_2),
      ],
    });
    client.retrieveContexts.mockResolvedValue({
      contexts: {
        contexts: [
          {
            sourceDisplayName: ALICE_SESSION_1,
            text: [line(2, 'B'), line(1, 'A')].join('\n'),
          },
          {sourceDisplayName: ALICE_SESSION_2, text: line(9, 'Z')},
          {
            sourceDisplayName: ALICE_SESSION_1,
            text: [line(2, 'B'), line(3, 'C')].join('\n'),
          },
        ],
      },
    });

    const response = await createService(client).searchMemory(ALICE_REQUEST);

    expect(memoryTexts(response.memories)).toEqual(['A', 'B', 'C', 'Z']);
  });

  it('leaves the instance store unscoped for a later search', async () => {
    spyOnWarn();
    const client = createFakeClient();
    client.listRagFiles
      .mockResolvedValueOnce({ragFiles: [ragFile('alice-1', ALICE_SESSION_1)]})
      .mockRejectedValueOnce(new Error('cannot list files'));
    const service = createService(client);

    await service.searchMemory(ALICE_REQUEST);
    await service.searchMemory(ALICE_REQUEST);

    expect(retrieveCall(client, 0).vertexRagStore.ragResources).toEqual([
      {ragCorpus: CORPUS, ragFileIds: ['alice-1']},
    ]);
    expect(retrieveCall(client, 1).vertexRagStore.ragResources).toEqual([
      {ragCorpus: CORPUS, ragFileIds: undefined},
    ]);
  });

  it('retrieves unscoped when the corpus name is empty', async () => {
    const client = createFakeClient();

    await createService(client, {
      ragCorpus: '',
      project: 'test-project',
      location: 'us-central1',
    }).searchMemory(ALICE_REQUEST);

    expect(client.listRagFiles).not.toHaveBeenCalled();
    expect(client.retrieveContexts).toHaveBeenCalledTimes(1);
  });
});

describe('VertexAiRagMemoryService.addSessionToMemory', () => {
  it('uploads the transcript under an unambiguous display name', async () => {
    const client = createFakeClient();

    await createService(client).addSessionToMemory(session());

    const upload = client.uploadRagFile.mock.calls[0][0];
    expect(upload.ragCorpus).toBe(CORPUS);
    expect(upload.displayName).not.toBe('demo.app.alice.smith.session.secret');
    expect(upload.displayName).toBe(
      buildSourceDisplayName({
        appName: 'demo.app',
        userId: 'alice.smith',
        sessionId: 'session.secret',
      }),
    );
    expect(upload.content).toBe(
      JSON.stringify({author: 'user', timestamp: 1, text: 'sensitive memory'}),
    );
  });

  it('round-trips a session whose identifiers contain dots', async () => {
    const client = createFakeClient();
    const service = createService(client);
    await service.addSessionToMemory(session());
    const displayName = client.uploadRagFile.mock.calls[0][0].displayName;
    client.listRagFiles.mockResolvedValue({
      ragFiles: [ragFile('alice-1', displayName)],
    });
    client.retrieveContexts.mockResolvedValue({
      contexts: {contexts: [ragContext(displayName, 'sensitive memory')]},
    });

    const response = await service.searchMemory({
      appName: 'demo.app',
      userId: 'alice.smith',
      query: 'sensitive',
    });

    expect(memoryTexts(response.memories)).toEqual(['sensitive memory']);
  });

  it('rejects a bare corpus id it cannot qualify, before uploading', async () => {
    const client = createFakeClient();

    await expect(
      createService(client, {ragCorpus: 'bare-id'}).addSessionToMemory(
        session(),
      ),
    ).rejects.toThrow('needs a project and a location');
    expect(client.uploadRagFile).not.toHaveBeenCalled();
  });

  it('rejects an empty corpus name before uploading', async () => {
    const client = createFakeClient();

    await expect(
      createService(client, {ragCorpus: ''}).addSessionToMemory(session()),
    ).rejects.toThrow('ragCorpus must be set.');
    expect(client.uploadRagFile).not.toHaveBeenCalled();
  });
});
