/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Client} from '@google-cloud/vertexai';
import type {Event} from '@google/adk';
import {AgentEngineSandboxCodeExecutor, LlmAgent} from '@google/adk';
import {FinishReason, Outcome} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';
import {
  createRunner,
  GeminiWithMockResponses,
  RawGenerateContentResponse,
} from '../test_case_utils.js';

const MOCK_RESPONSES: RawGenerateContentResponse[] = [
  {
    candidates: [
      {
        content: {
          parts: [
            {
              text: 'Here is the code to print hello:\n```python\nprint("hello")\n```',
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
          parts: [{text: 'Execution was successful.'}],
          role: 'model',
        },
        finishReason: FinishReason.STOP,
      },
    ],
  },
];

function createSandboxFixture() {
  const mockClient = {
    agentEnginesInternal: {
      createInternal: vi.fn().mockResolvedValue({
        name: 'operations/create-engine-op',
        done: true,
        response: {
          name: 'projects/test-project/locations/us-central1/reasoningEngines/123',
        },
      }),
      sandboxes: {
        getInternal: vi.fn().mockResolvedValue({
          state: 'STATE_RUNNING',
        }),
        createInternal: vi.fn().mockResolvedValue({
          name: 'operations/create-sandbox-op',
          done: true,
          response: {
            name: 'projects/test-project/locations/us-central1/reasoningEngines/123/sandboxEnvironments/456',
          },
        }),
        executeCodeInternal: vi.fn().mockResolvedValue({
          outputs: [
            {
              mimeType: 'application/json',
              data: Buffer.from(
                JSON.stringify({msg_out: 'hello', msg_err: ''}),
              ).toString('base64'),
            },
          ],
        }),
      },
    },
  };

  return {
    mockClient,
    executor: new AgentEngineSandboxCodeExecutor({
      projectId: 'test-project',
      client: mockClient as unknown as Client,
    }),
  };
}

describe('Agent with AgentEngineSandboxCodeExecutor', () => {
  it('does not execute code when responseProcessors is overridden', async () => {
    const {mockClient, executor} = createSandboxFixture();

    const model = new GeminiWithMockResponses(MOCK_RESPONSES);
    const agent = new LlmAgent({
      model,
      name: 'coderAgent',
      description: 'An agent that writes and runs code',
      instruction: 'Write code to solve the user request.',
      codeExecutor: executor,
      responseProcessors: [],
    });

    const {run} = await createRunner(agent);

    const events: Event[] = [];
    for await (const event of run('Print hello')) {
      events.push(event);
    }

    expect(
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal,
    ).not.toHaveBeenCalled();

    const resultParts = events.flatMap(
      (e) => e.content?.parts?.filter((p) => p.codeExecutionResult) ?? [],
    );
    expect(resultParts).toHaveLength(0);

    expect(events.at(-1)?.content?.parts?.[0]?.text).toContain(
      'print("hello")',
    );
  });

  it('executes code with no explicit responseProcessors', async () => {
    const {mockClient, executor} = createSandboxFixture();

    const model = new GeminiWithMockResponses(MOCK_RESPONSES);
    const agent = new LlmAgent({
      model,
      name: 'coderAgent',
      description: 'An agent that writes and runs code',
      instruction: 'Write code to solve the user request.',
      codeExecutor: executor,
    });

    const {run} = await createRunner(agent);

    const events: Event[] = [];
    for await (const event of run('Print hello')) {
      events.push(event);
    }

    expect(
      mockClient.agentEnginesInternal.sandboxes.executeCodeInternal,
    ).toHaveBeenCalledTimes(1);

    const resultParts = events.flatMap(
      (e) => e.content?.parts?.filter((p) => p.codeExecutionResult) ?? [],
    );
    expect(resultParts).toHaveLength(1);
    expect(resultParts[0].codeExecutionResult?.outcome).toBe(
      Outcome.OUTCOME_OK,
    );
    expect(resultParts[0].text).toContain('hello');

    expect(events.at(-1)?.content?.parts?.[0]?.text).toBe(
      'Execution was successful.',
    );
  });
});
