/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  InMemoryRunner,
  LlmAgent,
  PRELOAD_MEMORY,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {hasModelCredentials} from '../utils/model_credentials.js';

describe('E2E PreloadMemoryTool', () => {
  const hasAKey = hasModelCredentials();

  it.skipIf(!hasAKey)(
    'should use Gemini API and rely on preloaded memory to answer',
    async () => {
      const agent = new LlmAgent({
        name: 'e2e_preload_memory_agent',
        description: 'An agent that answers based on memory.',
        instruction: 'Give a short answer based solely on the memory contents.',
        model: 'gemini-2.5-flash',
        tools: [PRELOAD_MEMORY],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_preload_memory_test',
      });

      const session1 = await runner.sessionService.createSession({
        appName: 'e2e_preload_memory_test',
        userId: 'test_user',
      });

      // Save a piece of memory
      await runner.sessionService.appendEvent({
        session: session1,
        event: createEvent({
          author: 'user',
          content: createUserContent('Hi! My cat is named Whiskers.'),
        }),
      });

      await runner.memoryService!.addSessionToMemory(session1);

      const session2 = await runner.sessionService.createSession({
        appName: 'e2e_preload_memory_test',
        userId: 'test_user',
      });

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session2.id,
        newMessage: createUserContent(
          'Please answer: What is the name of my cat?',
        ),
      })) {
        const text = event.content?.parts?.[0]?.text;
        if (event.author === 'e2e_preload_memory_agent' && text) {
          finalResponse += text;
        }
      }

      // Check the output
      expect(finalResponse.toLowerCase()).toContain('whiskers');
    },
    30000,
  );
});
