/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai/build/src/genai/client.js';
import {
  createEvent,
  InMemorySessionService,
  LlmAgent,
  LOAD_MEMORY,
  Runner,
  VertexAiMemoryBankService,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

describe('VertexAiMemoryBankService Integration', () => {
  let mockMemories: {
    createInternal: ReturnType<typeof vi.fn>;
    generateInternal: ReturnType<typeof vi.fn>;
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
      retrieveInternal: vi.fn().mockResolvedValue({
        retrievedMemories: [
          {
            memory: {
              fact: 'Your favorite color is green.',
              updateTime: '2026-04-21T12:00:00Z',
            },
            distance: 0.1,
          },
        ],
      }),
    };
  });

  it('should work with Runner and LOAD_MEMORY tool', async () => {
    const agent = new LlmAgent({
      name: 'memory_agent',
      description: 'Answers questions from memory.',
      instruction: 'Answer questions about the user using memory.',
      tools: [LOAD_MEMORY],
    });

    agent.model = new GeminiWithMockResponses([
      // First model response requests to load memory
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [
                {
                  functionCall: {
                    name: 'load_memory',
                    args: {query: 'favorite color'},
                  },
                },
              ],
            },
          },
        ],
      },
      // Second model response happens after the tool provides the content
      {
        candidates: [
          {
            content: {
              role: 'model',
              parts: [{text: 'Your favorite color is green.'}],
            },
          },
        ],
      },
    ]);

    const mockClient = {
      agentEnginesInternal: {
        memories: mockMemories,
      },
    };

    const runner = new Runner({
      appName: 'test_memory_app',
      agent,
      sessionService: new InMemorySessionService(),
      memoryService: new VertexAiMemoryBankService({
        agentEngineId: 'test-engine-id',
        client: mockClient as unknown as Client,
      }),
    });

    // Define a mock memory session
    const memorySession = await runner.sessionService.createSession({
      appName: 'test_memory_app',
      userId: 'test_user',
    });
    await runner.sessionService.appendEvent({
      session: memorySession,
      event: createEvent({
        author: 'user',
        content: createUserContent('My favorite color is green.'),
      }),
    });

    // Add the session context to memory
    await runner.memoryService!.addSessionToMemory(memorySession);

    // Verify that generateInternal was called
    expect(mockMemories.generateInternal).toHaveBeenCalled();

    const session = await runner.sessionService.createSession({
      appName: 'test_memory_app',
      userId: 'test_user',
    });

    let finalResponse = '';
    let memoryLoaded = false;

    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('What is my favorite color?'),
    })) {
      if (event.author === 'memory_agent') {
        const text = event.content?.parts?.[0]?.text;
        if (text) finalResponse += text;
      }

      // Look for the framework's functionResponse message
      if (event.content?.parts?.[0]?.functionResponse) {
        const functionResponse = event.content.parts[0].functionResponse;
        if (functionResponse.name === 'load_memory') {
          memoryLoaded = true;
        }
      }
    }

    expect(memoryLoaded).toBe(true);
    expect(finalResponse).toContain('Your favorite color is green.');

    // Verify that retrieveInternal was called by the tool
    expect(mockMemories.retrieveInternal).toHaveBeenCalledWith(
      expect.objectContaining({
        similaritySearchParams: {
          searchQuery: 'favorite color',
        },
      }),
    );
  });
});

describe('VertexAiMemoryBankService Express Mode Integration', () => {
  const FAKE_API_KEY = 'fake-express-key';
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = {...originalEnv, GOOGLE_GENAI_USE_VERTEXAI: 'true'};
    delete process.env['GOOGLE_API_KEY'];
  });

  afterEach(() => {
    process.env = originalEnv;
    vi.restoreAllMocks();
  });

  it('should search memory over a real express mode client', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          retrievedMemories: [
            {
              memory: {
                fact: 'Your favorite color is green.',
                updateTime: '2026-04-21T12:00:00Z',
              },
              distance: 0.1,
            },
          ],
        }),
        {status: 200, headers: {'content-type': 'application/json'}},
      ),
    );
    const service = new VertexAiMemoryBankService({
      agentEngineId: 'test-engine-id',
      expressModeApiKey: FAKE_API_KEY,
    });

    const response = await service.searchMemory({
      appName: 'test_memory_app',
      userId: 'test_user',
      query: 'favorite color',
    });

    expect(response.memories[0].content?.parts?.[0]?.text).toBe(
      'Your favorite color is green.',
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(String(url)).toBe(
      'https://aiplatform.googleapis.com/v1beta1/reasoningEngines/test-engine-id/memories:retrieve',
    );
    expect(new Headers(init?.headers).get('x-goog-api-key')).toBe(FAKE_API_KEY);
  });
});
