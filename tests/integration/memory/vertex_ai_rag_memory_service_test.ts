/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import {
  createEvent,
  InMemorySessionService,
  LlmAgent,
  LOAD_MEMORY,
  Runner,
  VertexAiRagMemoryService,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

const SOURCE_DISPLAY_NAME_PREFIX = 'adk-memory-v1.';

function buildDisplayName(
  appName: string,
  userId: string,
  sessionId: string,
): string {
  const encode = (value: string) =>
    Buffer.from(value, 'utf-8').toString('base64url');
  return (
    SOURCE_DISPLAY_NAME_PREFIX +
    [encode(appName), encode(userId), encode(sessionId)].join('.')
  );
}

describe('VertexAiRagMemoryService Integration', () => {
  const appName = 'test_memory_app';
  const userId = 'test_user';
  let mockRag: {
    uploadFile: ReturnType<typeof vi.fn>;
    retrieveContexts: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockRag = {
      uploadFile: vi.fn().mockResolvedValue(undefined),
      retrieveContexts: vi.fn().mockResolvedValue({
        contexts: {
          contexts: [
            {
              sourceDisplayName: buildDisplayName(
                appName,
                userId,
                'memory_session',
              ),
              text: JSON.stringify({
                author: 'user',
                timestamp: 1000,
                text: 'Your favorite color is green.',
              }),
            },
          ],
        },
      }),
    };
  });

  it('recalls a stored memory end-to-end via the LOAD_MEMORY tool', async () => {
    const agent = new LlmAgent({
      name: 'memory_agent',
      description: 'Answers questions from memory.',
      instruction: 'Answer questions about the user using memory.',
      tools: [LOAD_MEMORY],
    });

    agent.model = new GeminiWithMockResponses([
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

    const memoryService = new VertexAiRagMemoryService({
      ragCorpus: 'projects/test/locations/us-central1/ragCorpora/test-corpus',
      client: {rag: mockRag} as unknown as Client,
    });

    const runner = new Runner({
      appName,
      agent,
      sessionService: new InMemorySessionService(),
      memoryService,
    });

    const memorySession = await runner.sessionService.createSession({
      appName,
      userId,
    });
    await runner.sessionService.appendEvent({
      session: memorySession,
      event: createEvent({
        author: 'user',
        content: createUserContent('My favorite color is green.'),
      }),
    });

    await runner.memoryService!.addSessionToMemory(memorySession);
    expect(mockRag.uploadFile).toHaveBeenCalledTimes(1);

    const session = await runner.sessionService.createSession({
      appName,
      userId,
    });

    let finalResponse = '';
    let memoryLoaded = false;
    for await (const event of runner.runAsync({
      userId,
      sessionId: session.id,
      newMessage: createUserContent('What is my favorite color?'),
    })) {
      if (event.author === 'memory_agent') {
        const text = event.content?.parts?.[0]?.text;
        if (text) finalResponse += text;
      }
      const functionResponse = event.content?.parts?.[0]?.functionResponse;
      if (functionResponse?.name === 'load_memory') {
        memoryLoaded = true;
      }
    }

    expect(memoryLoaded).toBe(true);
    expect(finalResponse).toContain('Your favorite color is green.');
    expect(mockRag.retrieveContexts).toHaveBeenCalledWith(
      expect.objectContaining({
        query: expect.objectContaining({text: 'favorite color'}),
      }),
    );
  });
});
