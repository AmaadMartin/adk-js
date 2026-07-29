/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  InMemoryRunner,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  UnsafeLocalCodeExecutor,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import {describe, expect, it} from 'vitest';

class MockLlmConnection implements BaseLlmConnection {
  sendHistory(): Promise<void> {
    return Promise.resolve();
  }
  sendContent(): Promise<void> {
    return Promise.resolve();
  }
  sendRealtime(): Promise<void> {
    return Promise.resolve();
  }
  async *receive(): AsyncGenerator<LlmResponse, void, void> {
    // No-op.
  }
  close(): Promise<void> {
    return Promise.resolve();
  }
}

class MultiResponseMockLlm extends BaseLlm {
  private responseIndex = 0;
  constructor(private responses: LlmResponse[]) {
    super({model: 'multi-response-mock-llm'});
  }

  async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    const response = this.responses[this.responseIndex];
    if (response) {
      this.responseIndex = Math.min(
        this.responseIndex + 1,
        this.responses.length - 1,
      );
      yield response;
    }
  }

  async connect(_llmRequest: LlmRequest): Promise<BaseLlmConnection> {
    return new MockLlmConnection();
  }
}

describe('E2E Code Execution with UnsafeLocalCodeExecutor', () => {
  it('should execute python code and return result', async () => {
    const responses: LlmResponse[] = [
      {
        content: {
          parts: [
            {
              text: 'Here is the code to run:\n```python\nprint("Hello from python E2E")\n```',
            },
          ],
        },
      },
      {
        content: {
          parts: [{text: 'The execution was successful.'}],
        },
      },
    ];

    const mockModel = new MultiResponseMockLlm(responses);
    const executor = new UnsafeLocalCodeExecutor();
    const agent = new LlmAgent({
      name: 'code_execution_agent',
      instruction: 'Run the code and report back.',
      model: mockModel,
      codeExecutor: executor,
    });

    const runner = new InMemoryRunner({
      agent,
      appName: 'e2e_code_execution_test',
    });

    const session = await runner.sessionService.createSession({
      appName: 'e2e_code_execution_test',
      userId: 'test_user',
    });

    const events = [];
    for await (const event of runner.runAsync({
      userId: 'test_user',
      sessionId: session.id,
      newMessage: createUserContent('Please run the python code.'),
    })) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0].content?.parts?.[0].text).toContain(
      'Here is the code to run',
    );
    expect(events[1].content?.parts?.[0].text).toContain(
      'Hello from python E2E',
    );
    expect(events[2].content?.parts?.[0].text).toContain(
      'The execution was successful',
    );
  });
});
