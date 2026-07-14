/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  createEvent,
  Event,
  InMemoryArtifactService,
  InMemoryRunner,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LOAD_ARTIFACTS,
  Runner,
} from '@google/adk';
import {Content} from '@google/genai';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';
import {describe, expect, it} from 'vitest';

describe('E2E Internalize InvocationContext & RunConfig', () => {
  const envPath = path.resolve(__dirname, '.env');
  const envExists = fs.existsSync(envPath);

  if (envExists) {
    dotenv.config({path: envPath});
  }

  const hasAKey =
    !!process.env.GEMINI_API_KEY ||
    !!process.env.GOOGLE_GENAI_API_KEY ||
    !!process.env.GOOGLE_CLOUD_PROJECT;

  it('should internalize session identification and runConfig without mock overrides (manual e2e verification)', async () => {
    let capturedCtx: InvocationContext | undefined;

    class InspectionAgent extends BaseAgent {
      constructor() {
        super({
          name: 'inspection_agent',
          description: 'Inspects real InvocationContext during run',
        });
      }

      protected override async *runAsyncImpl(
        context: InvocationContext,
      ): AsyncGenerator<Event, void, void> {
        capturedCtx = context;
        yield createEvent({
          invocationId: context.invocationId,
          author: this.name,
          content: {role: 'model', parts: [{text: 'Inspection Complete'}]},
        });
      }
    }

    const sessionService = new InMemorySessionService();
    const artifactService = new InMemoryArtifactService();
    const agent = new InspectionAgent();
    const runner = new Runner({
      appName: 'e2e_app',
      agent,
      sessionService,
      artifactService,
    });

    const session = await sessionService.createSession({
      sessionId: 'e2e_session_456',
      appName: 'e2e_app',
      userId: 'e2e_user_123',
      state: {step: 'init'},
    });

    const blobBytes = Buffer.from(
      'id,value\n1,alpha\n2,beta\n',
      'utf8',
    ).toString('base64');
    const newMessage: Content = {
      role: 'user',
      parts: [
        {
          inlineData: {
            data: blobBytes,
            mimeType: 'application/csv',
          },
        },
        {
          text: 'Process this CSV',
        },
      ],
    };

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'e2e_user_123',
      sessionId: session.id,
      newMessage,
      runConfig: {
        saveInputBlobsAsArtifacts: true,
        maxLlmCalls: 10,
      },
    })) {
      events.push(event);
    }

    // 1. Verify InvocationContext internalization of session id, user id, app name, and state
    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.sessionId).toBe('e2e_session_456');
    expect(capturedCtx!.userId).toBe('e2e_user_123');
    expect(capturedCtx!.appName).toBe('e2e_app');
    expect(capturedCtx!.state).toEqual({step: 'init'});
    expect(capturedCtx!.runConfig?.saveInputBlobsAsArtifacts).toBe(true);

    // 2. Verify user message event in session had inline data replaced with placeholder
    const updatedSession = await sessionService.getSession({
      appName: 'e2e_app',
      userId: 'e2e_user_123',
      sessionId: 'e2e_session_456',
    });
    expect(updatedSession).toBeDefined();
    const userEvent = updatedSession!.events.find((e) => e.author === 'user');
    expect(userEvent).toBeDefined();
    expect(userEvent!.content?.parts?.[0].text).toMatch(
      /^Uploaded file: artifact_e-[a-z0-9-]+_0\. It is saved into artifacts$/,
    );
    expect(userEvent!.content?.parts?.[1].text).toBe('Process this CSV');

    // 3. Verify ScopedArtifactService cleanly persisted artifact using internalized appName, userId, sessionId
    const keys = await artifactService.listArtifactKeys({
      appName: 'e2e_app',
      userId: 'e2e_user_123',
      sessionId: 'e2e_session_456',
    });
    expect(keys.length).toBe(1);
    expect(keys[0]).toMatch(/^artifact_e-[a-z0-9-]+_0$/);
  });

  it.skipIf(!hasAKey)(
    'should internalize runConfig and load saved artifacts against live Gemini API',
    async () => {
      const agent = new LlmAgent({
        name: 'e2e_live_blob_agent',
        description: 'An agent that reads artifacts.',
        instruction:
          'You have tools to load artifacts. Use them to read artifacts if the user asks about them, and give a short answer based solely on the artifact content.',
        model: 'gemini-2.5-flash',
        tools: [LOAD_ARTIFACTS],
      });

      const runner = new InMemoryRunner({
        agent,
        appName: 'e2e_live_app',
      });
      const session = await runner.sessionService.createSession({
        appName: 'e2e_live_app',
        userId: 'test_live_user',
      });

      const csvBytes = Buffer.from(
        'item,price\nApple,2\nOrange,3\n',
        'utf8',
      ).toString('base64');
      const newMessage: Content = {
        role: 'user',
        parts: [
          {
            inlineData: {
              data: csvBytes,
              mimeType: 'application/csv',
            },
          },
          {
            text: 'What is the price of Orange according to the uploaded artifact?',
          },
        ],
      };

      let finalResponse = '';
      for await (const event of runner.runAsync({
        userId: 'test_live_user',
        sessionId: session.id,
        newMessage,
        runConfig: {
          saveInputBlobsAsArtifacts: true,
        },
      })) {
        if (
          event.author === 'e2e_live_blob_agent' &&
          event.content?.parts?.[0]?.text
        ) {
          finalResponse += event.content.parts[0].text;
        }
      }

      expect(finalResponse.toLowerCase()).toContain('3');
    },
    60000,
  );
});
