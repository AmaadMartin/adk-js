/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event, LlmRequest} from '@google/adk';
import {createEvent, InMemoryRunner, LlmAgent} from '@google/adk';
import type {Content} from '@google/genai';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {GeminiWithMockResponses} from '../test_case_utils.js';

describe('Foreign Thought Filtering Integration', () => {
  it('includes foreign agent thoughts in LlmRequest when includeForeignThoughts is true', async () => {
    let capturedContents: Content[] = [];

    const agentB = new LlmAgent({
      name: 'AgentB',
      model: new GeminiWithMockResponses([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{text: 'I see AgentA reasoning'}],
              },
            },
          ],
        },
      ]),
      includeForeignThoughts: true,
      beforeModelCallback: async ({request}: {request: LlmRequest}) => {
        capturedContents = request.contents;
      },
    });

    const runner = new InMemoryRunner({
      agent: agentB,
      appName: 'test_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
    });

    // Simulate AgentA (sub-agent) producing an event in the session
    const agentAEvent: Event = createEvent({
      invocationId: 'inv-agentA',
      author: 'AgentA',
      content: {
        role: 'model',
        parts: [
          {
            text: 'thinking...',
            thought: true,
          },
          {
            text: 'done',
          },
        ],
      },
    });

    await runner.sessionService.appendEvent({
      session,
      event: agentAEvent,
    });

    // Run AgentB on the session
    for await (const _ of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('supervise'),
    })) {
      // iterate through stream
    }

    expect(capturedContents.length).toBeGreaterThan(0);
    const foreignEventContent = capturedContents.find(
      (c) =>
        c.role === 'user' &&
        c.parts?.some((p) => p.text?.includes('[AgentA] thought: thinking...')),
    );
    expect(foreignEventContent).toBeDefined();

    const textParts = foreignEventContent?.parts?.map((p) => p.text) ?? [];
    expect(textParts).toContain('[AgentA] thought: thinking...');
    expect(textParts).toContain('[AgentA] said: done');
  });

  it('excludes foreign agent thoughts in LlmRequest when includeForeignThoughts is false by default', async () => {
    let capturedContents: Content[] = [];

    const agentB = new LlmAgent({
      name: 'AgentB',
      model: new GeminiWithMockResponses([
        {
          candidates: [
            {
              content: {
                role: 'model',
                parts: [{text: 'I only see final response'}],
              },
            },
          ],
        },
      ]),
      // includeForeignThoughts defaults to false
      beforeModelCallback: async ({request}: {request: LlmRequest}) => {
        capturedContents = request.contents;
      },
    });

    const runner = new InMemoryRunner({
      agent: agentB,
      appName: 'test_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'test_app',
      userId: 'test_user',
    });

    // Simulate AgentA producing thought + text
    const agentAEvent: Event = createEvent({
      invocationId: 'inv-agentA',
      author: 'AgentA',
      content: {
        role: 'model',
        parts: [
          {
            text: 'thinking...',
            thought: true,
          },
          {
            text: 'done',
          },
        ],
      },
    });

    await runner.sessionService.appendEvent({
      session,
      event: agentAEvent,
    });

    // Run AgentB on the session
    for await (const _ of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('supervise'),
    })) {
      // iterate through stream
    }

    expect(capturedContents.length).toBeGreaterThan(0);
    const foreignEventContent = capturedContents.find(
      (c) =>
        c.role === 'user' &&
        c.parts?.some((p) => p.text?.includes('[AgentA] said: done')),
    );
    expect(foreignEventContent).toBeDefined();

    const textParts = foreignEventContent?.parts?.map((p) => p.text) ?? [];
    expect(textParts).not.toContain('[AgentA] thought: thinking...');
    expect(textParts).toContain('[AgentA] said: done');
  });
});
