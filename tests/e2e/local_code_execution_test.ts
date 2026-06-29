/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  InMemoryArtifactService,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../integration/test_case_utils.js';

describe('LlmAgent with UnsafeLocalCodeExecutor E2E', () => {
  it('should execute code locally and return the result to the model', async () => {
    const executor = new UnsafeLocalCodeExecutor();
    const responses: RawGenerateContentResponse[] = [
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: 'I will run a python script to print hello.\n```python\nprint("Hello from local execution!")\n```',
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
      {
        candidates: [
          {
            content: {
              parts: [
                {
                  text: 'I saw the output "Hello from local execution!". I am finished.',
                },
              ],
              role: 'model',
            },
            finishReason: FinishReason.STOP,
          },
        ],
      },
    ];
    const mockModel = new GeminiWithMockResponses(responses);
    const agent = new LlmAgent({
      name: 'code_runner_agent',
      codeExecutor: executor,
      model: mockModel,
    });

    const mockState = {
      hasDelta: () => false,
      get: () => undefined,
      set: () => {},
    };

    const artifactService = new InMemoryArtifactService();
    const invocationContext = new InvocationContext({
      invocationId: 'inv_123',
      session: {
        id: 'sess_123',
        state: mockState,
        events: [],
      } as unknown as Session,
      agent: agent,
      pluginManager: new PluginManager(),
      artifactService,
    });

    const generator = agent.runAsync(invocationContext);
    const events: Event[] = [];
    for await (const event of generator) {
      events.push(event);
    }

    // Verify events
    expect(events.length).toBe(3);

    // Event 0: Code generation
    expect(events[0].content?.parts?.[0].text).toContain(
      'I will run a python script',
    );
    expect(events[0].content?.parts?.[1].text).toContain(
      'print("Hello from local execution!")',
    );

    // Event 1: Code execution result
    expect(events[1].content?.parts?.[0].codeExecutionResult).toBeDefined();
    expect(events[1].content?.parts?.[0].text).toContain(
      'Hello from local execution!',
    );

    // Event 2: Final response
    expect(events[2].content?.parts?.[0].text).toBe(
      'I saw the output "Hello from local execution!". I am finished.',
    );
  });
});
