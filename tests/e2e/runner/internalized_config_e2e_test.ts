/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {InMemoryRunner, LlmAgent} from '@google/adk';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {fileURLToPath} from 'url';
import {describe, expect, it} from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Try to load .env from tests/e2e or root.
const envPaths = [
  path.resolve(__dirname, '../.env'),
  path.resolve(__dirname, '../../.env'),
  path.resolve(__dirname, '.env'),
];

for (const envPath of envPaths) {
  if (fs.existsSync(envPath)) {
    dotenv.config({path: envPath});
    break;
  }
}

const hasAKey =
  !!process.env.GEMINI_API_KEY ||
  !!process.env.GOOGLE_GENAI_API_KEY ||
  !!process.env.GOOGLE_CLOUD_PROJECT;

describe('E2E Runner Internalized Config', () => {
  it.skipIf(!hasAKey)(
    'should execute multi-turn conversation end-to-end using internalized userId and sessionId',
    async () => {
      const agent = new LlmAgent({
        name: 'e2e_internalized_agent',
        description: 'An assistant for testing internalized config.',
        instruction:
          'You are a helpful assistant. Keep your responses very brief (1 sentence).',
        model: 'gemini-2.5-flash',
      });

      const userId = 'e2e-user-789';
      const sessionId = 'e2e-session-012';

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_internalized_app',
        userId,
        sessionId,
      });

      await runner.sessionService.createSession({
        appName: runner.appName,
        userId,
        sessionId,
      });

      let turn1Response = '';
      for await (const event of runner.runAsync({
        newMessage: {
          role: 'user',
          parts: [{text: 'Remember the secret code: BLUE-99.'}],
        },
      })) {
        if (event.author === agent.name && event.content?.parts?.[0]?.text) {
          turn1Response += event.content.parts[0].text;
        }
      }
      expect(turn1Response.length).toBeGreaterThan(0);

      let turn2Response = '';
      for await (const event of runner.runAsync({
        newMessage: {
          role: 'user',
          parts: [
            {text: 'What was the secret code I told you in the previous turn?'},
          ],
        },
      })) {
        if (event.author === agent.name && event.content?.parts?.[0]?.text) {
          turn2Response += event.content.parts[0].text;
        }
      }
      expect(turn2Response.length).toBeGreaterThan(0);
      expect(turn2Response.toUpperCase()).toContain('BLUE-99');
    },
    30000,
  );
});
