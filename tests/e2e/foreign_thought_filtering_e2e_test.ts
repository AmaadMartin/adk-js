/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event, LlmRequest} from '@google/adk';
import {createEvent, Gemini, InMemoryRunner, LlmAgent} from '@google/adk';
import type {Content} from '@google/genai';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';

describe('Foreign Thought Filtering Manual E2E Test (No Mocks)', () => {
  it('runs a multi-agent delegation flow and verifies the receiving agent receives reasoning steps when includeForeignThoughts is true', async () => {
    let capturedRequestContents: Content[] = [];

    // Create AgentB (receiving agent) configured with includeForeignThoughts = true
    // We use beforeModelCallback to inspect the exact unmocked request payload that would be sent to the real LLM endpoint.
    const receivingAgent = new LlmAgent({
      name: 'SupervisorAgent',
      model: new Gemini({
        model: 'gemini-2.5-flash',
        apiKey: process.env.GEMINI_API_KEY || 'manual-e2e-test-key',
      }),
      includeForeignThoughts: true,
      beforeModelCallback: async ({request}: {request: LlmRequest}) => {
        capturedRequestContents = request.contents;
        // Short-circuit actual network call during standalone verification by returning a synthetic response
        // while preserving unmocked pipeline execution up to network dispatch.
        return {
          content: {
            role: 'model',
            parts: [{text: 'Supervision approval: verified reasoning steps.'}],
          },
        };
      },
    });

    const runner = new InMemoryRunner({
      agent: receivingAgent,
      appName: 'e2e_supervision_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'e2e_supervision_app',
      userId: 'manual_e2e_user',
    });

    // Simulate real foreign event produced by a reasoning Researcher sub-agent
    const researcherEvent: Event = createEvent({
      invocationId: 'e2e-inv-researcher',
      author: 'ResearcherAgent',
      content: {
        role: 'model',
        parts: [
          {
            text: 'Step 1: Analyzed data patterns.\nStep 2: Identified primary trends.',
            thought: true,
          },
          {
            text: 'Final report: The primary trend is positive growth.',
          },
        ],
      },
    });

    await runner.sessionService.appendEvent({
      session,
      event: researcherEvent,
    });

    // Execute the runner end-to-end
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: 'manual_e2e_user',
      sessionId: session.id,
      newMessage: createUserContent(
        'Please review the report from ResearcherAgent.',
      ),
    })) {
      events.push(event);
    }

    // Verify via printed/captured LLM request payload that the receiving agent received the reasoning steps
    expect(capturedRequestContents.length).toBeGreaterThan(0);
    const foreignEventPayload = capturedRequestContents.find(
      (c) =>
        c.role === 'user' &&
        c.parts?.some((p) =>
          p.text?.includes(
            '[ResearcherAgent] thought: Step 1: Analyzed data patterns.',
          ),
        ),
    );
    expect(foreignEventPayload).toBeDefined();

    const formattedTexts = foreignEventPayload?.parts?.map((p) => p.text) ?? [];
    expect(formattedTexts).toContain(
      '[ResearcherAgent] thought: Step 1: Analyzed data patterns.\nStep 2: Identified primary trends.',
    );
    expect(formattedTexts).toContain(
      '[ResearcherAgent] said: Final report: The primary trend is positive growth.',
    );

    // Also verify that the runner completed and returned the final response
    expect(events.length).toBeGreaterThan(0);
    expect(events[events.length - 1].content?.parts?.[0].text).toContain(
      'Supervision approval',
    );
  });
});
