/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Gemma, InMemoryRunner, LlmAgent} from '@google/adk';
import {createUserContent} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

describe('E2E Gemma LLM', () => {
  const envPath = path.resolve(__dirname, '../.env');
  const envExists = fs.existsSync(envPath);

  if (envExists) {
    dotenv.config({path: envPath});
  }

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!process.env.GOOGLE_CLOUD_PROJECT;

  it('should always pass (dummy test for vitest)', () => {
    expect(true).toBe(true);
  });

  it.skipIf(!hasAKey)(
    'should generate content successfully using Gemma model',
    async () => {
      const gemma = new Gemma({
        model: process.env.GEMMA_E2E_MODEL || 'gemma-3-27b-it',
      });
      const agent = new LlmAgent({
        name: 'gemma_agent',
        description: 'An agent using Gemma.',
        instruction: 'You are a helpful assistant.',
        model: gemma,
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_gemma_test',
      });

      const session = await runner.sessionService.createSession({
        appName: 'e2e_gemma_test',
        userId: 'test_user',
      });

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_user',
        sessionId: session.id,
        newMessage: createUserContent('Say Hello!'),
      })) {
        console.log('EVENT:', JSON.stringify(event));
        if (event.content?.parts?.[0]?.text) {
          finalResponse += event.content.parts[0].text;
        }
      }

      expect(finalResponse).toBeTruthy();
    },
    30000,
  );
});
