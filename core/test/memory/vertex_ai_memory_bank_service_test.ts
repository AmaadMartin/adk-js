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
import {Content, Part} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const clientConstructor = vi.hoisted(() => vi.fn());

// The service imports Client from the package root, so the mock must target it.
vi.mock('@google-cloud/vertexai', () => ({
  Client: class {
    readonly agentEnginesInternal = {memories: {}};

    constructor(options: {project?: string; location?: string}) {
      clientConstructor(options);
    }
  },
}));

afterEach(() => {
  vi.unstubAllEnvs();
  clientConstructor.mockClear();
});

describe('VertexAiMemoryBankService', () => {
  let service: VertexAiMemoryBankService;
  let mockMemories: {
    createInternal: ReturnType<typeof vi.fn>;
    generateInternal: ReturnType<typeof vi.fn>;
    ingestEventsInternal: ReturnType<typeof vi.fn>;
    retrieveInternal: ReturnType<typeof vi.fn>;
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
      ['an expressModeApiKey option', {expressModeApiKey: 'test-api-key'}],
      ['an API key from the environment', {}],
      ['an API key and only a project', {projectId: 'test-project'}],
    ])('throws for %s instead of dropping the key', (_, options) => {
      expect(
        () =>
          new VertexAiMemoryBankService({
            agentEngineId: 'test-engine-id',
            ...options,
          }),
      ).toThrow('Vertex AI Express Mode');
      expect(clientConstructor).not.toHaveBeenCalled();
    });

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

  describe('addSessionToMemory', () => {
    it('calls ingestEventsInternal with events', async () => {
      const session = createSession({
        id: 'test-session-id',
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        lastUpdateTime: Date.now(),
      });
      const event = createEvent({
        author: 'user',
        content: {parts: [{text: 'event 1'}]},
        timestamp: Date.now(),
      });
      session.events.push(event);

      await service.addSessionToMemory(session);

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'reasoningEngines/test-engine-id',
          scope: {app_name: 'test-app', user_id: 'test-user'},
          directContentsSource: {
            events: [
              expect.objectContaining({
                content: {parts: [{text: 'event 1'}]},
                eventId: event.id,
              }),
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

    it('sends nothing when the generate path filters out every event', async () => {
      const events = [{content: {parts: []} as Content} as Event];

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events,
        customMetadata: {ttl: '3600s'},
      });

      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
      expect(mockMemories.ingestEventsInternal).not.toHaveBeenCalled();
    });
  });

  describe('addEventsToMemory via ingest', () => {
    const ingestName = 'reasoningEngines/test-engine-id';
    const ingestScope = {app_name: 'test-app', user_id: 'test-user'};

    it('sends the event timestamp as an RFC 3339 event time', async () => {
      const event = createEvent({
        author: 'user',
        content: {parts: [{text: 'event 1'}]},
        timestamp: Date.UTC(2026, 3, 21, 12, 0, 0),
      });

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [event],
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: ingestName,
        scope: ingestScope,
        directContentsSource: {
          events: [
            {
              content: {parts: [{text: 'event 1'}]},
              eventId: event.id,
              eventTime: '2026-04-21T12:00:00.000Z',
            },
          ],
        },
      });
    });

    it('puts forceFlush in the config and the other ingest keys at the top level', async () => {
      const event = createEvent({
        author: 'user',
        content: {parts: [{text: 'event 1'}]},
        timestamp: Date.UTC(2026, 3, 21, 12, 0, 0),
      });

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [event],
        customMetadata: {
          streamId: 'stream-123',
          forceFlush: true,
          generationTriggerConfig: {generationRule: {idleDuration: '60s'}},
        },
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: ingestName,
        scope: ingestScope,
        directContentsSource: {
          events: [
            {
              content: {parts: [{text: 'event 1'}]},
              eventId: event.id,
              eventTime: '2026-04-21T12:00:00.000Z',
            },
          ],
        },
        streamId: 'stream-123',
        generationTriggerConfig: {generationRule: {idleDuration: '60s'}},
        config: {forceFlush: true},
      });
      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
    });

    it('ingests a trigger config update without events', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        customMetadata: {
          generationTriggerConfig: {generationRule: {eventCount: 10}},
        },
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: ingestName,
        scope: ingestScope,
        generationTriggerConfig: {generationRule: {eventCount: 10}},
      });
    });

    it('ingests an empty session with the name and the scope only', async () => {
      const session = createSession({
        id: 'test-session-id',
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        lastUpdateTime: Date.now(),
      });

      await service.addSessionToMemory(session);

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: ingestName,
        scope: ingestScope,
      });
    });

    it.each([
      ['ttl', {ttl: '6000s'}],
      ['revisionTtl', {revisionTtl: '100s'}],
      ['metadata', {metadata: {key: 'value'}}],
      ['waitForCompletion', {waitForCompletion: true}],
    ])('routes to generate for the generate-only key %s', async (_, meta) => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [{content: {parts: [{text: 'event 1'}]} as Content} as Event],
        customMetadata: meta,
      });

      expect(mockMemories.generateInternal).toHaveBeenCalled();
      expect(mockMemories.ingestEventsInternal).not.toHaveBeenCalled();
    });

    it('keeps an ingest key on the ingest path', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [{content: {parts: [{text: 'event 1'}]} as Content} as Event],
        customMetadata: {forceFlush: true},
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith(
        expect.objectContaining({config: {forceFlush: true}}),
      );
      expect(mockMemories.generateInternal).not.toHaveBeenCalled();
    });

    it('routes to generate when an ingest key and a generate-only key are mixed', async () => {
      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [{content: {parts: [{text: 'event 1'}]} as Content} as Event],
        customMetadata: {streamId: 'stream-123', ttl: '6000s'},
      });

      expect(mockMemories.generateInternal).toHaveBeenCalled();
      expect(mockMemories.ingestEventsInternal).not.toHaveBeenCalled();
    });

    it('drops an unrecognised key and still ingests', async () => {
      const event = createEvent({
        author: 'user',
        content: {parts: [{text: 'event 1'}]},
        timestamp: Date.UTC(2026, 3, 21, 12, 0, 0),
      });

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [event],
        customMetadata: {someAppKey: 'value'},
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: ingestName,
        scope: ingestScope,
        directContentsSource: {
          events: [
            {
              content: {parts: [{text: 'event 1'}]},
              eventId: event.id,
              eventTime: '2026-04-21T12:00:00.000Z',
            },
          ],
        },
      });
    });

    it('skips wrong-typed ingest metadata and warns', async () => {
      const loggerSpy = vi
        .spyOn(getLogger(), 'warn')
        .mockImplementation(() => {});

      await service.addEventsToMemory({
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        customMetadata: {
          streamId: 42,
          forceFlush: 'yes',
          generationTriggerConfig: 'nope',
        },
      });

      expect(mockMemories.ingestEventsInternal).toHaveBeenCalledWith({
        name: ingestName,
        scope: ingestScope,
      });
      expect(loggerSpy).toHaveBeenCalledWith(
        'Ignoring streamId because customMetadata["streamId"] is not a string.',
      );
      expect(loggerSpy).toHaveBeenCalledWith(
        'Ignoring forceFlush because customMetadata["forceFlush"] is not a boolean.',
      );
      expect(loggerSpy).toHaveBeenCalledWith(
        'Ignoring generationTriggerConfig because customMetadata["generationTriggerConfig"] is not an object.',
      );
      loggerSpy.mockRestore();
    });

    it('propagates a rejected ingest request', async () => {
      mockMemories.ingestEventsInternal.mockRejectedValue(new Error('boom'));
      const session = createSession({
        id: 'test-session-id',
        appName: 'test-app',
        userId: 'test-user',
        events: [],
        lastUpdateTime: Date.now(),
      });

      await expect(service.addSessionToMemory(session)).rejects.toThrow('boom');
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
          // ttl is generate-only, and keeps this case on the generate path.
          ttl: '6000s',
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
          // ttl is generate-only, and keeps this case on the generate path.
          ttl: '6000s',
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
          // ttl is generate-only, and keeps this case on the generate path.
          ttl: '6000s',
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
        } as unknown as MemoryEntry, // cast to pass customMetadata
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
  });
});
