/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {
  createEvent,
  createSession,
  Event,
  getLogger,
  MemoryEntry,
  VertexAiMemoryBankService,
  VertexAiMemoryBankServiceOptions,
} from '@google/adk';
import {Content, Language, Outcome, Part} from '@google/genai';
import {ApiClient, ApiClientInitOptions} from '@google/genai/vertex_internal';
import {OAuth2Client} from 'google-auth-library';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const TEXT_EVENT = {content: {parts: [{text: 'event 1'}]} as Content} as Event;

const clientConstructor = vi.hoisted(() => vi.fn());
const apiClientOptions = vi.hoisted(() =>
  vi.fn<(options: ApiClientInitOptions) => void>(),
);
const memoriesConstructor = vi.hoisted(() =>
  vi.fn<(apiClient: ApiClient) => void>(),
);

/** An event that survives the memory event filter. */
function eventWithText(): Event {
  return createEvent({
    id: 'event-1',
    author: 'user',
    content: {parts: [{text: 'event 1'}]},
    timestamp: 12345000,
  });
}

// The service imports Client from the package root, so the mock must target it.
vi.mock('@google-cloud/vertexai', () => ({
  Client: class {
    readonly agentEnginesInternal = {memories: {}};

    constructor(options: {project?: string; location?: string}) {
      clientConstructor(options);
    }
  },
}));

// Records how the service configures an ApiClient, which is the only place the
// Express Mode key and the caller's credentials are observable.
vi.mock('@google/genai/vertex_internal', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@google/genai/vertex_internal')>();
  return {
    ...actual,
    ApiClient: class extends actual.ApiClient {
      constructor(options: ApiClientInitOptions) {
        super(options);
        apiClientOptions(options);
      }
    },
  };
});

// The credentialed path builds Memories itself instead of going through Client.
vi.mock('@google-cloud/vertexai/build/src/genai/memories.js', () => ({
  Memories: class {
    constructor(apiClient: ApiClient) {
      memoriesConstructor(apiClient);
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  clientConstructor.mockClear();
  apiClientOptions.mockClear();
  memoriesConstructor.mockClear();
});

describe('VertexAiMemoryBankService', () => {
  let service: VertexAiMemoryBankService;
  let mockMemories: {
    createInternal: ReturnType<typeof vi.fn>;
    generateInternal: ReturnType<typeof vi.fn>;
    ingestEventsInternal: ReturnType<typeof vi.fn>;
    retrieveInternal: ReturnType<typeof vi.fn>;
    retrieveProfiles: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockMemories = {
      createInternal: vi
        .fn()
        .mockResolvedValue({name: 'operations/create-op', done: true}),
      generateInternal: vi
        .fn()
        .mockResolvedValue({name: 'operations/generate-op', done: true}),
      ingestEventsInternal: vi
        .fn()
        .mockResolvedValue({name: 'operations/ingest-op', done: true}),
      retrieveProfiles: vi.fn().mockResolvedValue({profiles: {}}),
      retrieveInternal: vi.fn().mockResolvedValue({
        retrievedMemories: [
          {
            memory: {
              fact: 'user likes blue',
              updateTime: '2026-04-21T12:00:00Z',
            },
            distance: 0.1,
          },
        ],
      }),
    };

    const mockClient = {
      agentEnginesInternal: {
        memories: mockMemories,
      },
    };

    service = new VertexAiMemoryBankService({
      agentEngineId: 'test-engine-id',
      client: mockClient as unknown as Client,
    });
  });

  it('initializes correctly', () => {
    expect(service).toBeDefined();
  });

  it('throws error if agentEngineId is missing', () => {
    expect(
      () =>
        new VertexAiMemoryBankService(
          {} as unknown as VertexAiMemoryBankServiceOptions,
        ),
    ).toThrow('agentEngineId is required for VertexAiMemoryBankService.');
  });

  it('warns if agentEngineId looks like a full path', () => {
    const loggerSpy = vi
      .spyOn(getLogger(), 'warn')
      .mockImplementation(() => {});
    new VertexAiMemoryBankService({
      agentEngineId: 'projects/p/locations/l/reasoningEngines/456',
      client: {
        agentEnginesInternal: {memories: mockMemories},
      } as unknown as Client,
    });
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        'agentEngineId appears to be a full resource path',
      ),
    );
    loggerSpy.mockRestore();
  });

  describe('express mode', () => {
    beforeEach(() => {
      vi.stubEnv('GOOGLE_GENAI_USE_VERTEXAI', 'true');
      vi.stubEnv('GOOGLE_API_KEY', 'env-api-key');
    });

    it.each([
      [
        'an expressModeApiKey option',
        {expressModeApiKey: 'test-api-key'},
        'test-api-key',
      ],
      ['an API key from the environment', {}, 'env-api-key'],
    ])('authenticates with %s', (_, options, expectedKey) => {
      new VertexAiMemoryBankService({
        agentEngineId: 'test-engine-id',
        ...options,
      });

      expect(apiClientOptions).toHaveBeenCalledWith(
        expect.objectContaining({apiKey: expectedKey, vertexai: true}),
      );
      expect(clientConstructor).not.toHaveBeenCalled();
    });

    it.each<[string, {projectId?: string; location?: string}]>([
      ['a project', {projectId: 'test-project'}],
      ['a location', {location: 'us-central1'}],
    ])(
      'throws for an API key and only %s, rather than addressing the key owner project',
      (_, options) => {
        expect(
          () =>
            new VertexAiMemoryBankService({
              agentEngineId: 'test-engine-id',
              ...options,
            }),
        ).toThrow('cannot be combined with a partial project configuration');
        expect(apiClientOptions).not.toHaveBeenCalled();
        expect(clientConstructor).not.toHaveBeenCalled();
      },
    );

    it('keeps using project and location when an API key is also in the environment', () => {
      new VertexAiMemoryBankService({
        agentEngineId: 'test-engine-id',
        projectId: 'test-project',
        location: 'us-central1',
      });

      expect(clientConstructor).toHaveBeenCalledWith({
        project: 'test-project',
        location: 'us-central1',
      });
      expect(apiClientOptions).not.toHaveBeenCalled();
    });

    it('never builds a client when one is injected', () => {
      new VertexAiMemoryBankService({
        agentEngineId: 'test-engine-id',
        client: {
          agentEnginesInternal: {memories: mockMemories},
        } as unknown as Client,
      });

      expect(clientConstructor).not.toHaveBeenCalled();
    });
  });

  describe('credentials', () => {
    it('authenticates the Memory Bank API with the given credentials', () => {
      new VertexAiMemoryBankService({
        agentEngineId: 'test-engine-id',
        projectId: 'test-project',
        location: 'us-central1',
        credentials: {authClient: new OAuth2Client()},
      });

      expect(apiClientOptions).toHaveBeenCalledWith(
        expect.objectContaining({
          project: 'test-project',
          location: 'us-central1',
          vertexai: true,
        }),
      );
      expect(clientConstructor).not.toHaveBeenCalled();
    });

    it('signs a request with the given credentials', async () => {
      const authClient = new OAuth2Client();
      authClient.credentials = {access_token: 'token-from-caller'};
      new VertexAiMemoryBankService({
        agentEngineId: 'test-engine-id',
        projectId: 'test-project',
        location: 'us-central1',
        credentials: {authClient},
      });
      const headers = new Headers();

      const options = apiClientOptions.mock.calls[0][0];
      await options.auth.addAuthHeaders(headers);

      expect(headers.get('Authorization')).toBe('Bearer token-from-caller');
    });

    it('uses Application Default Credentials when none are given', () => {
      new VertexAiMemoryBankService({
        agentEngineId: 'test-engine-id',
        projectId: 'test-project',
        location: 'us-central1',
      });

      expect(clientConstructor).toHaveBeenCalledWith({
        project: 'test-project',
        location: 'us-central1',
      });
      expect(apiClientOptions).not.toHaveBeenCalled();
    });

    it('honours credentials given with only a project', () => {
      new VertexAiMemoryBankService({
        agentEngineId: 'test-engine-id',
        projectId: 'test-project',
        credentials: {authClient: new OAuth2Client()},
      });

      expect(apiClientOptions).toHaveBeenCalledWith(
        expect.objectContaining({project: 'test-project', vertexai: true}),
      );
      expect(clientConstructor).not.toHaveBeenCalled();
    });

    it('reports the missing project instead of falling back to the host identity', () => {
      expect(
        () =>
          new VertexAiMemoryBankService({
            agentEngineId: 'test-engine-id',
            credentials: {authClient: new OAuth2Client()},
          }),
      ).toThrow('Authentication is not set up');
      expect(clientConstructor).not.toHaveBeenCalled();
    });
  });

  describe('addSessionToMemory', () => {
    it('calls ingestEventsInternal with events', async () => {
      const session = createSession({
        id: 'test-session-id',
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        lastUpdateTime: Date.now(),
      });
      session.events.push(
        createEvent({
          author: 'user',
          content: {parts: [{text: 'event 1'}]},
          timestamp: Date.now(),
        }),
      );

      await service.addSessionToMemory(session);

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'reasoningEngines/test-engine-id',
          scope: {app_name: 'test-app', user_id: 'test-user'},
          directContentsSource: {
            events: [
              expect.objectContaining({content: {parts: [{text: 'event 1'}]}}),
            ],
          },
        }),
      );
      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
    });

    it('filters out events without text or data', async () => {
      const session = createSession({
        id: 'test-session-id',
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        lastUpdateTime: Date.now(),
      });
      session.events.push(
        createEvent({
          author: 'user',
          content: {parts: []},
          timestamp: Date.now(),
        }),
      );

      await service.addSessionToMemory(session);

      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith(
        expect.not.objectContaining({directContentsSource: expect.anything()}),
      );
    });
  });

  describe('addEventsToMemory', () => {
    it('calls generateInternal with provided events and metadata', async () => {
      const events = [
        {
          content: {parts: [{text: 'event 1'}]} as Content,
        } as Event,
      ];

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events,
        customMetadata: {ttl: '3600s'},
      });

      expect(mockMemories.generateInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            revisionTtl: '3600s',
          }),
        }),
      );
    });
  });

  describe('addEventsToMemory via ingestEvents', () => {
    it('sends the events, the stream id, the flush flag and the trigger rule', async () => {
      const events = [
        createEvent({
          id: 'event-1',
          author: 'user',
          content: {parts: [{text: 'event 1'}]},
          timestamp: Date.parse('2026-04-21T12:00:00Z'),
        }),
      ];

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events,
        customMetadata: {
          streamId: 'stream-123',
          forceFlush: true,
          generationTriggerConfig: {generationRule: {idleDuration: '60s'}},
        },
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/test-engine-id',
        scope: {app_name: 'test-app', user_id: 'test-user'},
        streamId: 'stream-123',
        config: {forceFlush: true},
        generationTriggerConfig: {generationRule: {idleDuration: '60s'}},
        directContentsSource: {
          events: [
            {
              content: {parts: [{text: 'event 1'}]},
              eventId: 'event-1',
              eventTime: '2026-04-21T12:00:00.000Z',
            },
          ],
        },
      });
      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
    });

    it('sends an event-less request that only updates the trigger rule', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        customMetadata: {
          generationTriggerConfig: {generationRule: {eventCount: 10}},
        },
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/test-engine-id',
        scope: {app_name: 'test-app', user_id: 'test-user'},
        generationTriggerConfig: {generationRule: {eventCount: 10}},
      });
    });

    it('omits the event time when the event has no timestamp', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [TEXT_EVENT],
      });

      const [params] = mockMemories.ingestEventsInternal.mock.calls[0];
      expect(params.directContentsSource.events[0]).not.toHaveProperty(
        'eventTime',
      );
    });

    it('resolves before the ingest request completes', async () => {
      mockMemories.ingestEventsInternal.mockReturnValue(
        new Promise(() => {
          // Never settles: the caller must not wait for the ingest request.
        }),
      );

      await expect(
        service.addEventsToMemory({
          appName: 'test-app',
          userId: 'test-user',
          events: [TEXT_EVENT],
        }),
      ).resolves.toBeUndefined();
    });

    it('logs a rejected ingest request without rejecting the caller', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'error')
        .mockImplementation(() => {});
      mockMemories.ingestEventsInternal.mockRejectedValue(
        new Error('ingest boom'),
      );

      await expect(
        service.addEventsToMemory({
          appName: 'test-app',
          userId: 'test-user',
          events: [TEXT_EVENT],
        }),
      ).resolves.toBeUndefined();

      await vi.waitFor(() =>
        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining(
            'Background ingestEvents request failed: Error: ingest boom',
          ),
        ),
      );
      loggerSpy.mockRestore();
    });

    it('ingests a session, dropping only the event without content', async () => {
      const session = createSession({
        id: 'test-session-id',
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        lastUpdateTime: Date.now(),
      });
      session.events.push(
        createEvent({
          id: 'event-text',
          author: 'user',
          content: {parts: [{text: 'event 1'}]},
          timestamp: Date.parse('2026-04-21T12:00:00Z'),
        }),
        createEvent({id: 'event-empty', author: 'user'}),
        createEvent({
          id: 'event-call',
          author: 'model',
          content: {parts: [{functionCall: {name: 'get_weather', args: {}}}]},
          timestamp: Date.parse('2026-04-21T12:00:01Z'),
        }),
      );

      await service.addSessionToMemory(session);

      const [params] = mockMemories.ingestEventsInternal.mock.calls[0];
      expect(params.directContentsSource.events).toEqual([
        {
          content: {parts: [{text: 'event 1'}]},
          eventId: 'event-text',
          eventTime: '2026-04-21T12:00:00.000Z',
        },
        {
          content: {parts: [{functionCall: {name: 'get_weather', args: {}}}]},
          eventId: 'event-call',
          eventTime: '2026-04-21T12:00:01.000Z',
        },
      ]);
    });

    it('ingests an event-less session', async () => {
      const session = createSession({
        id: 'test-session-id',
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        lastUpdateTime: Date.now(),
      });

      await service.addSessionToMemory(session);

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/test-engine-id',
        scope: {app_name: 'test-app', user_id: 'test-user'},
      });
    });
  });

  describe('write path routing', () => {
    it.each([
      ['a stream id', {streamId: 'stream-123'}],
      ['an unrecognised key', {source: 'agent'}],
    ])('routes %s to ingestEvents', async (_, customMetadata) => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [TEXT_EVENT],
        customMetadata,
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalled();
      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
    });

    it('routes allowedTopics to generate', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [TEXT_EVENT],
        customMetadata: {allowedTopics: ['USER_PREFERENCES']},
      });

      expect(mockMemories.generateInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            allowedTopics: ['USER_PREFERENCES'],
          }),
        }),
      );
      expect(mockMemories.ingestEventsInternal).not.toHaveBeenCalled();
    });

    it('issues no request when the generate path has no event left', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [
          createEvent({author: 'user', content: {parts: [{thought: true}]}}),
        ],
        customMetadata: {revisionTtl: '3600s'},
      });

      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
      expect(mockMemories.ingestEventsInternal).not.toHaveBeenCalled();
    });
  });

  describe('event content filter', () => {
    it.each([
      ['a functionCall', {functionCall: {name: 'get_weather', args: {}}}],
      [
        'a functionResponse',
        {functionResponse: {name: 'get_weather', response: {}}},
      ],
      [
        'executableCode',
        {executableCode: {code: 'print(1)', language: Language.PYTHON}},
      ],
      [
        'a codeExecutionResult',
        {codeExecutionResult: {outcome: Outcome.OUTCOME_OK, output: '1'}},
      ],
      ['a toolCall', {toolCall: {id: 'call-1', args: {}}}],
      ['a toolResponse', {toolResponse: {id: 'call-1', response: {}}}],
    ])('keeps an event whose only part is %s', async (_, part: Part) => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [createEvent({author: 'user', content: {parts: [part]}})],
      });

      const [params] = mockMemories.ingestEventsInternal.mock.calls[0];
      expect(params.directContentsSource.events).toEqual([
        expect.objectContaining({content: {parts: [part]}}),
      ]);
    });

    it('drops an event whose part carries no recognised field', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [
          createEvent({author: 'user', content: {parts: [{thought: true}]}}),
        ],
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith(
        expect.not.objectContaining({directContentsSource: expect.anything()}),
      );
    });
  });

  describe('retrieveProfiles', () => {
    it('returns the profiles of the scope', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'debug')
        .mockImplementation(() => {});
      mockMemories.retrieveProfiles.mockResolvedValue({
        profiles: {
          'user-preferences': {
            schemaId: 'user-preferences',
            profile: {favouriteColour: 'blue'},
          },
        },
      });

      const profiles = await service.retrieveProfiles({
        appName: 'test-app',
        userId: 'test-user',
      });

      expect(mockMemories.retrieveProfiles).toHaveBeenCalledWith({
        name: 'reasoningEngines/test-engine-id',
        scope: {app_name: 'test-app', user_id: 'test-user'},
      });
      expect(profiles).toEqual([
        {schemaId: 'user-preferences', profile: {favouriteColour: 'blue'}},
      ]);
      expect(loggerSpy).toHaveBeenCalledWith('Retrieved 1 memory profiles.');
      loggerSpy.mockRestore();
    });

    it('returns an empty list when the scope has no profile', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'debug')
        .mockImplementation(() => {});
      mockMemories.retrieveProfiles.mockResolvedValue({});

      const profiles = await service.retrieveProfiles({
        appName: 'test-app',
        userId: 'test-user',
      });

      expect(profiles).toEqual([]);
      expect(loggerSpy).toHaveBeenCalledWith('Retrieved no memory profiles.');
      loggerSpy.mockRestore();
    });
  });

  describe('addMemory', () => {
    it('calls createInternal by default', async () => {
      const memories = [
        {
          content: {parts: [{text: 'fact 1'}]} as Content,
        },
      ];

      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          fact: 'fact 1',
          scope: {app_name: 'test-app', user_id: 'test-user'},
        }),
      );
    });

    it('calls generateInternal if consolidation is enabled', async () => {
      const memories = [
        {
          content: {parts: [{text: 'fact 1'}]} as Content,
        },
      ];

      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
        customMetadata: {enable_consolidation: true},
      });

      expect(mockMemories.generateInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          directMemoriesSource: {
            directMemories: [{fact: 'fact 1'}],
          },
        }),
      );
    });

    it('forwards the entry id as the memoryId create-config key', async () => {
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories: [
          {id: 'mem-123', content: {parts: [{text: 'fact 1'}]} as Content},
        ],
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({memoryId: 'mem-123'}),
        }),
      );
    });

    it('lets customMetadata.memoryId override the entry id', async () => {
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories: [
          {
            id: 'from-entry',
            content: {parts: [{text: 'fact 1'}]} as Content,
            customMetadata: {memoryId: 'explicit'},
          },
        ],
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({memoryId: 'explicit'}),
        }),
      );
    });

    it('omits memoryId when the entry has no id', async () => {
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories: [{content: {parts: [{text: 'fact 1'}]} as Content}],
      });

      const config = mockMemories.createInternal.mock.calls[0][0].config;
      expect(config).not.toHaveProperty('memoryId');
    });

    it.each([
      ['a number', 123],
      ['a bare Content', {parts: [{text: 'fact 1'}]}],
    ])('throws if the entry is %s', async (_, entry) => {
      await expect(
        service.addMemory({
          appName: 'test-app',
          userId: 'test-user',
          memories: [entry as unknown as MemoryEntry],
        }),
      ).rejects.toThrow('memories[0] must be a MemoryEntry.');
    });

    it('throws error if memories list is empty', async () => {
      await expect(
        service.addMemory({
          appName: 'test-app',
          userId: 'test-user',
          memories: [],
        }),
      ).rejects.toThrow('memories must contain at least one entry.');
    });

    it('throws error if memory does not include text', async () => {
      await expect(
        service.addMemory({
          appName: 'test-app',
          userId: 'test-user',
          memories: [{content: {parts: []} as unknown as Content}],
        }),
      ).rejects.toThrow('memories[0] must include non-whitespace text.');
    });

    it('throws error if memory includes inlineData', async () => {
      await expect(
        service.addMemory({
          appName: 'test-app',
          userId: 'test-user',
          memories: [
            {
              content: {
                parts: [{inlineData: {data: '...'}}] as unknown as Part[],
              } as Content,
            },
          ],
        }),
      ).rejects.toThrow(
        'must include text only; inlineData and fileData are not supported.',
      );
    });

    it('throws error if memory includes only whitespace text', async () => {
      await expect(
        service.addMemory({
          appName: 'test-app',
          userId: 'test-user',
          memories: [{content: {parts: [{text: '   '}]} as Content}],
        }),
      ).rejects.toThrow('must include non-whitespace text.');
    });
  });

  describe('searchMemory', () => {
    it('calls retrieveInternal and returns mapped memories', async () => {
      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(mockMemories.retrieveInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'reasoningEngines/test-engine-id',
          scope: {app_name: 'test-app', user_id: 'test-user'},
          similaritySearchParams: {searchQuery: 'find blue'},
        }),
      );

      expect(response.memories).toHaveLength(1);
      expect(response.memories[0].content.parts?.[0].text).toBe(
        'user likes blue',
      );
      expect(response.memories[0].customMetadata).toEqual({});
    });

    it('converts every metadata value kind back to a plain value', async () => {
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [
          {
            memory: {
              fact: 'user likes blue',
              updateTime: '2026-04-21T12:00:00Z',
              metadata: {
                flag: {boolValue: true},
                score: {doubleValue: 1.5},
                label: {stringValue: 'blue'},
                seenAt: {timestampValue: '2026-04-21T12:00:00Z'},
                unknownKind: {someFutureValue: 'kept'},
              },
            },
          },
        ],
      });

      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(response.memories[0].customMetadata).toEqual({
        flag: true,
        score: 1.5,
        label: 'blue',
        seenAt: '2026-04-21T12:00:00Z',
        unknownKind: {someFutureValue: 'kept'},
      });
    });

    it('skips an entry with no memory object', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'warn')
        .mockImplementation(() => {});
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [{}, {memory: {fact: 'user likes blue'}}],
      });

      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(response.memories).toHaveLength(1);
      expect(loggerSpy).toHaveBeenCalledWith(
        'Skipping memory entry with missing memory object.',
      );
      loggerSpy.mockRestore();
    });

    it.each([
      ['a missing fact', {}],
      ['an empty fact', {fact: ''}],
    ])('skips an entry with %s', async (_, memory) => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'warn')
        .mockImplementation(() => {});
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [{memory}],
      });

      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(response.memories).toEqual([]);
      expect(loggerSpy).toHaveBeenCalledWith(
        'Skipping memory entry with empty or missing fact.',
      );
      loggerSpy.mockRestore();
    });

    it('leaves the timestamp unset when the memory has no update time', async () => {
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [{memory: {fact: 'user likes blue'}}],
      });

      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(response.memories[0].timestamp).toBeUndefined();
    });

    it('keeps a null metadata value instead of throwing on it', async () => {
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [
          {memory: {fact: 'user likes blue', metadata: {broken: null}}},
        ],
      });

      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(response.memories[0].customMetadata).toEqual({broken: null});
    });

    it.each([
      ['an empty result list', {retrievedMemories: []}],
      ['no result list at all', {}],
    ])('returns an empty list for %s', async (_, retrieveResponse) => {
      mockMemories.retrieveInternal.mockResolvedValue(retrieveResponse);

      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(response.memories).toEqual([]);
    });

    it('defaults customMetadata to {} when the memory has no metadata', async () => {
      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(response.memories[0].customMetadata).toEqual({});
    });

    it('converts Vertex metadata back into customMetadata', async () => {
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [
          {
            memory: {
              fact: 'user likes blue',
              updateTime: '2026-04-21T12:00:00Z',
              metadata: {
                aBool: {boolValue: true},
                aDouble: {doubleValue: 1.5},
                aString: {stringValue: 'record-123'},
                aTimestamp: {timestampValue: '2024-12-12T12:12:12.123Z'},
              },
            },
          },
        ],
      });

      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(response.memories[0].customMetadata).toEqual({
        aBool: true,
        aDouble: 1.5,
        aString: 'record-123',
        aTimestamp: '2024-12-12T12:12:12.123Z',
      });
    });

    it('keeps falsy metadata values instead of falling through', async () => {
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [
          {
            memory: {
              fact: 'user likes blue',
              updateTime: '2026-04-21T12:00:00Z',
              metadata: {
                aBool: {boolValue: false},
                aDouble: {doubleValue: 0},
                aString: {stringValue: ''},
              },
            },
          },
        ],
      });

      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(response.memories[0].customMetadata).toEqual({
        aBool: false,
        aDouble: 0,
        aString: '',
      });
    });

    it('returns an unrecognised metadata value unchanged', async () => {
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [
          {
            memory: {
              fact: 'user likes blue',
              updateTime: '2026-04-21T12:00:00Z',
              metadata: {unknownShape: {}},
            },
          },
        ],
      });

      const response = await service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

      expect(response.memories[0].customMetadata).toEqual({unknownShape: {}});
    });
  });

  describe('metadata conversion', () => {
    it('converts various types in customMetadata', async () => {
      const events = [
        {
          content: {parts: [{text: 'event 1'}]} as Content,
        } as Event,
      ];

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events,
        customMetadata: {
          // revisionTtl routes this write to memories.generate.
          revisionTtl: '3600s',
          myBool: true,
          myNumber: 42,
          myString: 'hello',
          myDate: new Date('2026-04-21T12:00:00Z'),
          myObject: {foo: 'bar'},
          myNull: null,
        },
      });

      expect(mockMemories.generateInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            metadata: {
              myBool: {boolValue: true},
              myNumber: {doubleValue: 42},
              myString: {stringValue: 'hello'},
              myDate: {timestampValue: '2026-04-21T12:00:00.000Z'},
              myObject: {stringValue: '{"foo":"bar"}'},
            },
          }),
        }),
      );
    });

    it('throws error if enable_consolidation is not boolean', async () => {
      await expect(
        service.addMemory({
          appName: 'test-app',
          userId: 'test-user',
          memories: [{content: {parts: [{text: 'fact'}]} as Content}],
          customMetadata: {enable_consolidation: 'true'}, // string instead of boolean
        }),
      ).rejects.toThrow(
        'customMetadata["enable_consolidation"] must be a bool.',
      );
    });

    it('passes through pre-formatted metadata values', async () => {
      const events = [
        {
          content: {parts: [{text: 'event 1'}]} as Content,
        } as Event,
      ];

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events,
        customMetadata: {
          // revisionTtl routes this write to memories.generate.
          revisionTtl: '3600s',
          myPreFormatted: {stringValue: 'already converted'},
        },
      });

      expect(mockMemories.generateInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            metadata: {
              myPreFormatted: {stringValue: 'already converted'},
            },
          }),
        }),
      );
    });

    it('returns false for consolidation if not provided but other metadata exists', async () => {
      const memories = [{content: {parts: [{text: 'fact'}]} as Content}];
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
        customMetadata: {otherKey: 'value'},
      });
      // Should call createInternal, not generateInternal
      expect(mockMemories.createInternal).toHaveBeenCalled();
    });

    it('fallback to string conversion for unhandled types', async () => {
      const events = [
        {content: {parts: [{text: 'event 1'}]} as Content} as Event,
      ];
      const mySymbol = Symbol('test');

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events,
        customMetadata: {
          // revisionTtl routes this write to memories.generate.
          revisionTtl: '3600s',
          mySymbol: mySymbol,
        },
      });

      expect(mockMemories.generateInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            metadata: {
              mySymbol: {stringValue: 'Symbol(test)'},
            },
          }),
        }),
      );
    });

    it('extracts revision labels from customMetadata', async () => {
      const memories = [{content: {parts: [{text: 'fact'}]} as Content}];
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
        customMetadata: {
          revisionLabels: {label1: 'value1', label2: 'value2'},
        },
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            revisionLabels: {label1: 'value1', label2: 'value2'},
          }),
        }),
      );
    });

    it('builds revision labels from memory entry author and timestamp', async () => {
      const memories = [
        {
          content: {parts: [{text: 'fact 1'}]} as Content,
          author: 'test-author',
          timestamp: '2026-04-21T12:00:00Z',
        },
      ];

      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            revisionLabels: {
              author: 'test-author',
              timestamp: '2026-04-21T12:00:00Z',
            },
          }),
        }),
      );
    });

    it('ignores non-string revision labels and logs warning', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'warn')
        .mockImplementation(() => {});
      const memories = [{content: {parts: [{text: 'fact'}]} as Content}];
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
        customMetadata: {
          revisionLabels: {label1: 'value1', label2: 42 as unknown as string},
        },
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            revisionLabels: {label1: 'value1'},
          }),
        }),
      );
      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('Ignoring revision label label2'),
      );
      loggerSpy.mockRestore();
    });

    it('returns undefined if all revision labels are invalid', async () => {
      const memories = [{content: {parts: [{text: 'fact'}]} as Content}];
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
        customMetadata: {
          revisionLabels: {label1: 42 as unknown as string},
        },
      });

      const calls = mockMemories.createInternal.mock.calls;
      expect(calls[0][0].config.revisionLabels).toBeUndefined();
    });

    it('merges customMetadata from memory entry', async () => {
      const memories = [
        {
          content: {parts: [{text: 'fact 1'}]} as Content,
          customMetadata: {entryKey: 'entryValue'},
        },
      ];

      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
        customMetadata: {overrideKey: 'overrideValue'},
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            metadata: expect.objectContaining({
              entryKey: {stringValue: 'entryValue'},
              overrideKey: {stringValue: 'overrideValue'},
            }),
          }),
        }),
      );
    });

    it('warns and returns undefined if revisionLabels is not an object', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'warn')
        .mockImplementation(() => {});
      const memories = [{content: {parts: [{text: 'fact'}]} as Content}];
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
        customMetadata: {
          revisionLabels: 'invalid' as unknown as Record<string, string>,
        },
      });

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining('because it is not an object'),
      );
      loggerSpy.mockRestore();
    });

    it('merges existing metadata with new metadata in create config', async () => {
      const memories = [{content: {parts: [{text: 'fact'}]} as Content}];
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
        customMetadata: {
          metadata: {existingKey: {stringValue: 'existingValue'}},
          newKey: 'newValue',
        },
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            metadata: {
              existingKey: {stringValue: 'existingValue'},
              newKey: {stringValue: 'newValue'},
            },
          }),
        }),
      );
    });

    it('throws TypeError if memories is not an array in create', async () => {
      await expect(
        service.addMemory({
          appName: 'test-app',
          userId: 'test-user',
          memories: 'not an array' as unknown as MemoryEntry[],
        }),
      ).rejects.toThrow('memories must be a sequence of memory items.');
    });

    it('warns if metadata is not an object in create config', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'warn')
        .mockImplementation(() => {});
      const memories = [{content: {parts: [{text: 'fact'}]} as Content}];
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
        customMetadata: {
          metadata: 'invalid' as unknown as Record<string, unknown>,
        },
      });

      expect(loggerSpy).toHaveBeenCalledWith(
        expect.stringContaining(
          'Ignoring metadata because customMetadata["metadata"] is not an object',
        ),
      );
      loggerSpy.mockRestore();
    });

    it('passes known fields to create config', async () => {
      const memories = [{content: {parts: [{text: 'fact'}]} as Content}];
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories,
        customMetadata: {
          displayName: 'my memory',
          description: 'my description',
        },
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            displayName: 'my memory',
            description: 'my description',
          }),
        }),
      );
    });

    it('admits httpOptions into the generate config', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [eventWithText()],
        customMetadata: {
          allowedTopics: ['USER_PREFERENCES'],
          httpOptions: {timeout: 5000},
        },
      });

      expect(mockMemories.generateInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({httpOptions: {timeout: 5000}}),
        }),
      );
    });

    it('admits httpOptions into the create config', async () => {
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories: [{content: {parts: [{text: 'fact'}]} as Content}],
        customMetadata: {httpOptions: {timeout: 5000}},
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({httpOptions: {timeout: 5000}}),
        }),
      );
    });
  });

  describe('ingest events', () => {
    it('sends the stream, the flush and the trigger rule with each event', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [eventWithText()],
        customMetadata: {
          streamId: 'stream-123',
          forceFlush: true,
          generationTriggerConfig: {generationRule: {idleDuration: '60s'}},
        },
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/test-engine-id',
        scope: {app_name: 'test-app', user_id: 'test-user'},
        directContentsSource: {
          events: [
            {
              content: {parts: [{text: 'event 1'}]},
              eventId: 'event-1',
              eventTime: '1970-01-01T03:25:45.000Z',
            },
          ],
        },
        streamId: 'stream-123',
        config: {forceFlush: true},
        generationTriggerConfig: {generationRule: {idleDuration: '60s'}},
      });
      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
    });

    it('ingests an event-less request without a direct contents source', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        customMetadata: {
          generationTriggerConfig: {generationRule: {idleDuration: '60s'}},
        },
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/test-engine-id',
        scope: {app_name: 'test-app', user_id: 'test-user'},
        generationTriggerConfig: {generationRule: {idleDuration: '60s'}},
      });
    });

    it('routes a generate-only key to generateInternal', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [eventWithText()],
        customMetadata: {allowedTopics: ['USER_PREFERENCES']},
      });

      expect(mockMemories.generateInternal).toHaveBeenCalled();
      expect(mockMemories.ingestEventsInternal).not.toHaveBeenCalled();
    });

    it('routes an unrecognised metadata key to ingestEventsInternal', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [eventWithText()],
        customMetadata: {someArbitraryKey: 'value'},
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalled();
      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
    });

    it('drops a stream, a flush and a trigger rule of the wrong type', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        customMetadata: {
          streamId: '',
          forceFlush: 'yes',
          generationTriggerConfig: ['not an object'],
        },
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: 'reasoningEngines/test-engine-id',
        scope: {app_name: 'test-app', user_id: 'test-user'},
      });
    });

    it('filters out an event that carries no content at all', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [createEvent({id: 'event-1', author: 'user'})],
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith(
        expect.not.objectContaining({directContentsSource: expect.anything()}),
      );
    });

    it('skips generate when a generate-only write has no surviving event', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [
          createEvent({
            id: 'event-1',
            author: 'user',
            content: {parts: [{}]},
            timestamp: 12345000,
          }),
        ],
        customMetadata: {allowedTopics: ['USER_PREFERENCES']},
      });

      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
      expect(mockMemories.ingestEventsInternal).not.toHaveBeenCalled();
    });

    it('omits eventTime when the event timestamp is not a finite number', async () => {
      const event = createEvent({
        id: 'event-1',
        author: 'user',
        content: {parts: [{text: 'event 1'}]},
      });
      event.timestamp = Number.NaN;

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [event],
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          directContentsSource: {
            events: [
              {content: {parts: [{text: 'event 1'}]}, eventId: 'event-1'},
            ],
          },
        }),
      );
    });

    it('logs a failed ingest request without rejecting the caller', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'error')
        .mockImplementation(() => {});
      mockMemories.ingestEventsInternal.mockRejectedValue(
        new Error('ingest exploded'),
      );

      await expect(
        service.addEventsToMemory({
          appName: 'test-app',
          userId: 'test-user',
          events: [eventWithText()],
        }),
      ).resolves.toBeUndefined();

      await vi.waitFor(() => {
        expect(loggerSpy).toHaveBeenCalledWith(
          expect.stringContaining('ingest exploded'),
        );
      });
      loggerSpy.mockRestore();
    });

    it.each<[string, Part]>([
      ['functionCall', {functionCall: {name: 'do_it', args: {}}}],
      ['functionResponse', {functionResponse: {name: 'do_it', response: {}}}],
      ['executableCode', {executableCode: {code: 'print(1)'}}],
      ['codeExecutionResult', {codeExecutionResult: {output: '1'}}],
      ['toolCall', {toolCall: {id: 'tool-1'}}],
      ['toolResponse', {toolResponse: {id: 'tool-1'}}],
    ])('keeps an event whose only part is a %s', async (_, part) => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [
          createEvent({
            id: 'event-1',
            author: 'user',
            content: {parts: [part]},
            timestamp: 12345000,
          }),
        ],
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          directContentsSource: {
            events: [expect.objectContaining({content: {parts: [part]}})],
          },
        }),
      );
    });
  });

  describe('memoryId', () => {
    it('forwards the memory entry id as the created memory id', async () => {
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories: [
          {id: 'entry-id', content: {parts: [{text: 'fact 1'}]} as Content},
        ],
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({memoryId: 'entry-id'}),
        }),
      );
    });

    it('prefers an explicit customMetadata memoryId over the entry id', async () => {
      await service.addMemory({
        appName: 'test-app',
        userId: 'test-user',
        memories: [
          {id: 'entry-id', content: {parts: [{text: 'fact 1'}]} as Content},
        ],
        customMetadata: {memoryId: 'metadata-id'},
      });

      expect(mockMemories.createInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({memoryId: 'metadata-id'}),
        }),
      );
    });
  });

  describe('retrieveProfiles', () => {
    it('returns the profiles of the scope and logs the count', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'debug')
        .mockImplementation(() => {});
      const profile = {schemaId: 'user-profile', profile: {name: 'Kim'}};
      mockMemories.retrieveProfiles.mockResolvedValue({
        profiles: {'user-profile': profile},
      });

      const profiles = await service.retrieveProfiles({
        appName: 'test-app',
        userId: 'test-user',
      });

      expect(mockMemories.retrieveProfiles).toHaveBeenCalledWith({
        name: 'reasoningEngines/test-engine-id',
        scope: {app_name: 'test-app', user_id: 'test-user'},
      });
      expect(profiles).toEqual([profile]);
      expect(loggerSpy).toHaveBeenCalledWith('Retrieved 1 memory profiles.');
      loggerSpy.mockRestore();
    });

    it('returns an empty list when the scope has no profiles', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'debug')
        .mockImplementation(() => {});
      mockMemories.retrieveProfiles.mockResolvedValue({profiles: undefined});

      const profiles = await service.retrieveProfiles({
        appName: 'test-app',
        userId: 'test-user',
      });

      expect(profiles).toEqual([]);
      expect(loggerSpy).toHaveBeenCalledWith('Retrieved no memory profiles.');
      loggerSpy.mockRestore();
    });
  });

  describe('searchMemory hardening', () => {
    const search = () =>
      service.searchMemory({
        appName: 'test-app',
        userId: 'test-user',
        query: 'find blue',
      });

    it('skips an entry with no memory object and warns', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'warn')
        .mockImplementation(() => {});
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [{}, {memory: {fact: 'user likes blue'}}],
      });

      const response = await search();

      expect(response.memories).toHaveLength(1);
      expect(loggerSpy).toHaveBeenCalledWith(
        'Skipping memory entry with missing memory object.',
      );
      loggerSpy.mockRestore();
    });

    it('skips an entry with an empty fact and warns', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'warn')
        .mockImplementation(() => {});
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [{memory: {fact: ''}}],
      });

      const response = await search();

      expect(response.memories).toHaveLength(0);
      expect(loggerSpy).toHaveBeenCalledWith(
        'Skipping memory entry with empty or missing fact.',
      );
      loggerSpy.mockRestore();
    });

    it('leaves the timestamp unset when the memory has no update time', async () => {
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [{memory: {fact: 'user likes blue'}}],
      });

      const response = await search();

      expect(response.memories[0].timestamp).toBeUndefined();
    });

    it('returns no memories when the response carries none', async () => {
      mockMemories.retrieveInternal.mockResolvedValue({});

      const response = await search();

      expect(response.memories).toEqual([]);
    });

    it('maps Vertex metadata values back onto customMetadata', async () => {
      mockMemories.retrieveInternal.mockResolvedValue({
        retrievedMemories: [
          {
            memory: {
              fact: 'user likes blue',
              metadata: {
                aBool: {boolValue: true},
                aDouble: {doubleValue: 1.5},
                aString: {stringValue: 'record-123'},
                aTimestamp: {timestampValue: '2026-04-21T12:00:00Z'},
                anUnknownShape: {somethingElse: 'kept'},
              },
            },
          },
        ],
      });

      const response = await search();

      expect(response.memories[0].customMetadata).toEqual({
        aBool: true,
        aDouble: 1.5,
        aString: 'record-123',
        aTimestamp: '2026-04-21T12:00:00Z',
        anUnknownShape: {somethingElse: 'kept'},
      });
    });

    it('returns an empty customMetadata when the memory has none', async () => {
      const response = await search();

      expect(response.memories[0].customMetadata).toEqual({});
    });
  });

  describe('credentials', () => {
    it('builds the memories client from the given credentials', () => {
      new VertexAiMemoryBankService({
        agentEngineId: 'test-engine-id',
        projectId: 'test-project',
        location: 'us-central1',
        credentials: {credentials: {client_email: 'a@b.c', private_key: 'k'}},
      });

      expect(clientConstructor).not.toHaveBeenCalled();
      expect(memoriesConstructor).toHaveBeenCalledTimes(1);
      const apiClient = memoriesConstructor.mock.calls[0][0];
      expect(apiClient.isVertexAI()).toBe(true);
      expect(apiClient.getProject()).toBe('test-project');
      expect(apiClient.getLocation()).toBe('us-central1');
    });

    it('falls back to the default client when no credentials are given', () => {
      new VertexAiMemoryBankService({
        agentEngineId: 'test-engine-id',
        projectId: 'test-project',
        location: 'us-central1',
      });

      expect(clientConstructor).toHaveBeenCalledWith({
        project: 'test-project',
        location: 'us-central1',
      });
      expect(memoriesConstructor).not.toHaveBeenCalled();
    });
  });
});

describe('VertexAiMemoryBankService.retrieveProfiles', () => {
  function createService() {
    const retrieveProfiles = vi.fn();
    const client = new Client({});
    Object.assign(client.agentEnginesInternal.memories, {retrieveProfiles});
    const service = new VertexAiMemoryBankService({
      agentEngineId: 'test-engine-id',
      client,
    });
    return {service, retrieveProfiles};
  }

  it('asks the memory bank for the scope and returns the profiles', async () => {
    const {service, retrieveProfiles} = createService();
    retrieveProfiles.mockResolvedValue({
      profiles: {
        'user-profile': {schemaId: 'user-profile', profile: {name: 'Kim'}},
      },
    });

    const profiles = await service.retrieveProfiles({
      appName: 'test-app',
      userId: 'test-user',
    });

    expect(retrieveProfiles).toHaveBeenCalledWith({
      name: 'reasoningEngines/test-engine-id',
      scope: {app_name: 'test-app', user_id: 'test-user'},
    });
    expect(profiles).toEqual([
      {schemaId: 'user-profile', profile: {name: 'Kim'}},
    ]);
  });

  it('returns no profiles when the response carries none', async () => {
    const {service, retrieveProfiles} = createService();
    retrieveProfiles.mockResolvedValue({});

    await expect(
      service.retrieveProfiles({appName: 'test-app', userId: 'test-user'}),
    ).resolves.toEqual([]);
  });
});
