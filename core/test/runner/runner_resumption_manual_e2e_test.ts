/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Event, InvocationContext} from '@google/adk';
import {
  BasePlugin,
  createEvent,
  InMemoryArtifactService,
  InMemorySessionService,
  LlmAgent,
  Runner,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

/**
 * Manual End-to-End Test verifying `determineAgentForResumption` optimization
 * across real unmocked agent trees and thousands of session events.
 */
describe('Manual E2E Test: determineAgentForResumption for Long Sessions', () => {
  it('should route seamlessly across an unmocked multi-agent tree with 5,000+ events without lag or excessive logging', async () => {
    // Instantiate real unmocked LlmAgent instances
    const rootAgent = new LlmAgent({
      name: 'root_coordinator',
      model: 'gemini-2.5-flash',
      subAgents: [],
    });

    const researchAgent = new LlmAgent({
      name: 'research_agent',
      model: 'gemini-2.5-flash',
      parentAgent: rootAgent,
    });

    const codeAgent = new LlmAgent({
      name: 'code_agent',
      model: 'gemini-2.5-flash',
      parentAgent: rootAgent,
    });

    const toolOnlyAgent = new LlmAgent({
      name: 'tool_only_agent',
      model: 'gemini-2.5-flash',
      parentAgent: rootAgent,
      disallowTransferToParent: true,
    });

    rootAgent.subAgents.push(researchAgent, codeAgent, toolOnlyAgent);

    // Track which agent was selected for resumption using a real plugin hook
    let resumedAgentName: string | undefined;
    class ResumptionTrackingPlugin extends BasePlugin {
      constructor() {
        super('resumption_tracking_plugin');
      }

      override async beforeRunCallback({
        invocationContext,
      }: {
        invocationContext: InvocationContext;
      }) {
        resumedAgentName = invocationContext.agent?.name;
        // Stop execution right after resumption determination to avoid live network calls
        return {stopExecution: true};
      }
    }

    const sessionService = new InMemorySessionService();
    const artifactService = new InMemoryArtifactService();
    const runner = new Runner({
      appName: 'manual_e2e_resumption_app',
      agent: rootAgent,
      sessionService,
      artifactService,
      plugins: [new ResumptionTrackingPlugin()],
    });

    // Create real session and populate with 5,000+ unmocked events
    const session = await sessionService.createSession({
      appName: 'manual_e2e_resumption_app',
      userId: 'e2e_user',
      sessionId: 'e2e_long_session',
    });

    // Append early event from researchAgent (the target resumed agent)
    await sessionService.appendEvent({
      session,
      event: createEvent({
        invocationId: 'inv-early-research',
        author: 'research_agent',
        content: {role: 'model', parts: [{text: 'Initial research notes.'}]},
      }),
    });

    // Append 5,000 subsequent events from non-transferable, unknown, and user authors
    for (let i = 0; i < 5000; i++) {
      const author =
        i % 3 === 0
          ? 'tool_only_agent'
          : i % 3 === 1
            ? 'unknown_external_agent'
            : 'user';
      await sessionService.appendEvent({
        session,
        event: createEvent({
          invocationId: `inv-history-${i}`,
          author,
          content: {
            role: author === 'user' ? 'user' : 'model',
            parts: [{text: `History entry ${i}`}],
          },
        }),
      });
    }

    const consoleInfoSpy = vi.spyOn(console, 'info');
    const startTime = Date.now();

    // Execute real runner flow with a new user message
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {
        role: 'user',
        parts: [{text: 'Please continue the research.'}],
      },
    })) {
      events.push(event);
    }
    const durationMs = Date.now() - startTime;

    // Verify correct routing to research_agent despite 5,000+ intervening non-routable events
    expect(resumedAgentName).toBe('research_agent');
    expect(durationMs).toBeLessThan(1500); // Sub-second resumption

    // Verify zero excessive event stringify logs were printed during scanning
    const eventLogCalls = consoleInfoSpy.mock.calls.filter(
      (call) => typeof call[0] === 'string' && call[0].includes('event:'),
    );
    expect(eventLogCalls.length).toBe(0);
  });
});
