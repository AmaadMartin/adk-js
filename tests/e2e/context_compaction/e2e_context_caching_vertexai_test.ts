/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createContextCacheConfig,
  Gemini,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

describe('E2E Context Caching and Content Assembly (Vertex AI)', () => {
  const envPath = path.resolve(__dirname, '.env');
  const envExists = fs.existsSync(envPath);

  if (envExists) {
    dotenv.config({path: envPath});
  }

  const hasRequiredEnv = !!process.env.GOOGLE_CLOUD_PROJECT;

  it.skipIf(!hasRequiredEnv)(
    'should pass contextCacheConfig down to model requests across turns in live execution',
    async () => {
      const capturedRequests: LlmRequest[] = [];

      const agentModel = new Gemini({
        model: 'gemini-2.5-flash',
        vertexai: true,
      });

      const agent = new LlmAgent({
        name: 'caching_e2e_agent',
        description: 'An agent configured to test live context caching.',
        instruction:
          'You are a helpful conversational AI. Please provide short, single-sentence answers.',
        model: agentModel,
        contextCacheConfig: createContextCacheConfig({
          ttlSeconds: 1800,
          minTokens: 32768,
        }),
        beforeModelCallback: ({request}) => {
          capturedRequests.push({
            ...request,
            cacheConfig: request.cacheConfig
              ? {...request.cacheConfig}
              : undefined,
            cacheMetadata: request.cacheMetadata
              ? {...request.cacheMetadata}
              : undefined,
          });
          return undefined;
        },
      });

      const runner = new InMemoryRunner({
        appName: 'e2e_caching_test',
        agent,
      });

      const session = await runner.sessionService.createSession({
        appName: 'e2e_caching_test',
        userId: 'test_user',
      });

      const turns = [
        'Hello, can you give me a 1 sentence fact about space?',
        'Can you give me another 1 sentence fact about oceans?',
      ];

      for (const prompt of turns) {
        const responseGen = runner.runAsync({
          userId: 'test_user',
          sessionId: session.id,
          newMessage: createUserContent(prompt),
        });

        for await (const _ of responseGen) {
          // Consume the live model events.
        }
      }

      expect(capturedRequests.length).toBe(2);
      expect(capturedRequests[0].cacheConfig).toEqual({
        cacheIntervals: 10,
        ttlSeconds: 1800,
        minTokens: 32768,
      });
      expect(capturedRequests[1].cacheConfig).toEqual({
        cacheIntervals: 10,
        ttlSeconds: 1800,
        minTokens: 32768,
      });
    },
    60000,
  );
});
