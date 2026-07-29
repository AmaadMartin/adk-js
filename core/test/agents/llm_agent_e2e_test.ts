/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  DEFAULT_REQUEST_PROCESSORS,
  DEFAULT_RESPONSE_PROCESSORS,
  Event,
  FunctionTool,
  InMemorySessionService,
  InvocationContext,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  PluginManager,
} from '@google/adk';
import {Content, Blob as GenaiBlob} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {z as z3} from 'zod/v3';

class MockE2eLlmConnection implements BaseLlmConnection {
  async sendHistory(_history: Content[]): Promise<void> {}
  async sendContent(_content: Content): Promise<void> {}
  async sendRealtime(_blob: GenaiBlob): Promise<void> {}
  async *receive(): AsyncGenerator<LlmResponse, void, void> {}
  async close(): Promise<void> {}
}

class MockE2eLlm extends BaseLlm {
  constructor() {
    super({model: 'mock-e2e-llm'});
  }

  override async *generateContentAsync(
    _request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    // Return a mock response where the LLM calls set_model_response with structured output
    yield {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              name: 'set_model_response',
              args: {answer: 42},
            },
          },
        ],
      },
    };
  }

  override async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    return new MockE2eLlmConnection();
  }
}

describe('Manual E2E Test: LlmAgent Processor Arrays & Tool Preprocessors', () => {
  it('runs E2E workflow verifying default processor copies, canonicalTools, and structured output tool preprocessing', async () => {
    const addNumbersTool = new FunctionTool({
      name: 'add_numbers',
      description: 'Adds two numbers together',
      parameters: z3.object({
        a: z3.number(),
        b: z3.number(),
      }),
      execute: async (args) => {
        return args.a + args.b;
      },
    });

    const outputSchema = z3.object({
      answer: z3.number(),
    });

    const agent = new LlmAgent({
      name: 'e2e_agent',
      model: new MockE2eLlm(),
      instruction: 'You are a math helper agent.',
      tools: [addNumbersTool],
      outputSchema,
      outputKey: 'math_answer',
      disallowTransferToParent: true,
      disallowTransferToPeers: true,
    });

    // 1. Verify clean top-level processor array assignment & isolation
    expect(agent.requestProcessors).not.toBe(DEFAULT_REQUEST_PROCESSORS);
    expect(agent.responseProcessors).not.toBe(DEFAULT_RESPONSE_PROCESSORS);
    expect(agent.requestProcessors).toHaveLength(
      DEFAULT_REQUEST_PROCESSORS.length,
    );

    // 2. Verify canonicalTools pre-resolving both add_numbers and set_model_response during run
    const sessionService = new InMemorySessionService();
    const session = await sessionService.createSession({
      appName: 'e2e_app',
      userId: 'e2e_user',
    });

    const invocationContext = new InvocationContext({
      invocationId: 'e2e_inv_001',
      session,
      agent,
      pluginManager: new PluginManager(),
    });

    const events: Event[] = [];
    for await (const event of agent.runAsync(invocationContext)) {
      await sessionService.appendEvent({session, event});
      events.push(event);
    }

    // Verify that the run produced events and processed structured output cleanly
    expect(events.length).toBeGreaterThan(0);
    const lastEvent = events[events.length - 1];
    expect(lastEvent.actions?.stateDelta?.['math_answer']).toEqual({
      answer: 42,
    });
    expect(session.state['math_answer']).toEqual({answer: 42});
  });
});
