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
      retrieveProfiles: vi.fn().mockResolvedValue({}),
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
          // waitForCompletion routes this write to memories.generate, which
          // is the path this test exercises.
          waitForCompletion: false,
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
          // waitForCompletion routes this write to memories.generate, which
          // is the path this test exercises.
          waitForCompletion: false,
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
          // waitForCompletion routes this write to memories.generate, which
          // is the path this test exercises.
          waitForCompletion: false,
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
});
