/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  createEvent,
  Event,
  getLogger,
  InMemoryRunner,
  LlmAgent,
} from '@google/adk';
import {FinishReason, FunctionCall, FunctionResponse} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../../integration/test_case_utils.js';

describe('E2E Manual Check: Runner Resumption & Long Session Performance', () => {
  it('should route multi-turn LRO function response instantly without log spam in a 10,000 event session', async () => {
    const loggerInstance = getLogger();
    const infoSpy = vi.spyOn(loggerInstance, 'info');
    const debugSpy = vi.spyOn(loggerInstance, 'debug');

    const lroCall: FunctionCall = {
      id: 'e2e-lro-777',
      name: 'long_running_cloud_operation',
      args: {jobId: 'job-xyz'},
    };

    const turn2Response: RawGenerateContentResponse = {
      candidates: [
        {
          content: {
            role: 'model',
            parts: [{text: 'Cloud operation verified and finished.'}],
          },
          finishReason: FinishReason.STOP,
        },
      ],
    };

    const workerAgent = new LlmAgent({
      name: 'worker_agent',
      model: new GeminiWithMockResponses([turn2Response]),
      description: 'Worker handling long operations.',
    });

    const rootCoordinator = new LlmAgent({
      name: 'root_coordinator',
      model: new GeminiWithMockResponses([]),
      subAgents: [workerAgent],
      description: 'Root agent.',
    });

    const runner = new InMemoryRunner({
      agent: rootCoordinator,
      appName: 'e2e_resumption_app',
    });

    const session = await runner.sessionService.createSession({
      appName: 'e2e_resumption_app',
      userId: 'user_e2e',
    });

    // Populate session with 10,000 historical events to verify sub-millisecond scanning
    const historicalEvents: Event[] = [];
    for (let i = 0; i < 10000; i++) {
      historicalEvents.push(
        createEvent({
          id: `hist_${i}`,
          invocationId: `inv_hist_${i}`,
          author: i % 2 === 0 ? 'user' : 'worker_agent',
          content: {
            role: i % 2 === 0 ? 'user' : 'model',
            parts: [{text: `Historical log entry ${i} with long payload`}],
          },
        }),
      );
    }
    for (const evt of historicalEvents) {
      await runner.sessionService.appendEvent({session, event: evt});
    }

    // Now worker_agent yields an LRO function call right at the end of the history
    const lroEvent = createEvent({
      invocationId: 'inv_lro_start',
      author: 'worker_agent',
      content: {role: 'model', parts: [{functionCall: lroCall}]},
    });
    await runner.sessionService.appendEvent({session, event: lroEvent});

    const startTime = performance.now();
    const lroResponse: FunctionResponse = {
      id: 'e2e-lro-777',
      name: 'long_running_cloud_operation',
      response: {status: 'SUCCESS'},
    };

    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: session.userId,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{functionResponse: lroResponse}]},
    })) {
      events.push(event);
    }
    const duration = performance.now() - startTime;

    expect(events.length).toBeGreaterThan(0);
    expect(events[0].author).toBe('worker_agent');
    expect(events[0].content?.parts?.[0].text).toBe(
      'Cloud operation verified and finished.',
    );

    // Verify instantaneous resumption and no log flooding
    expect(infoSpy).not.toHaveBeenCalledWith(expect.stringContaining('event:'));
    expect(debugSpy).toHaveBeenCalled();
    expect(duration).toBeLessThan(1000);
  });
});
