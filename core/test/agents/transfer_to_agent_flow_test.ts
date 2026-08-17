/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  InMemorySessionService,
  LlmAgent,
  LlmRequest,
  LlmResponse,
  Runner,
} from '@google/adk';
import {Part} from '@google/genai';
import {describe, expect, it} from 'vitest';

/** A model that answers from a script and keeps the requests it was sent. */
class RecordingLlm extends BaseLlm {
  readonly requests: LlmRequest[] = [];
  private turn = 0;

  constructor(private readonly replies: Part[]) {
    super({model: 'recording-llm'});
  }

  async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void, void> {
    this.requests.push(request);
    const reply =
      this.replies[Math.min(this.turn++, this.replies.length - 1)] ?? {};
    yield {content: {role: 'model', parts: [reply]}};
  }

  async connect(_request: LlmRequest): Promise<BaseLlmConnection> {
    throw new Error('RecordingLlm does not support live mode.');
  }
}

function transferDeclarationEnum(llmRequest: LlmRequest): string[] | undefined {
  const tool = llmRequest.config?.tools?.find(
    (candidate) => 'functionDeclarations' in candidate,
  );
  if (!tool || !('functionDeclarations' in tool)) {
    return expect.fail('the request declares no function tool');
  }
  const declaration = tool.functionDeclarations?.find(
    (candidate) => candidate.name === 'transfer_to_agent',
  );
  return declaration?.parameters?.properties?.['agentName'].enum;
}

async function runAgent(agent: LlmAgent): Promise<Event[]> {
  const sessionService = new InMemorySessionService();
  const session = await sessionService.createSession({
    appName: 'transfer_app',
    userId: 'test_user',
  });
  const runner = new Runner({appName: 'transfer_app', agent, sessionService});

  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: session.userId,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text: 'I have a billing question'}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('transfer_to_agent through a full agent run', () => {
  it('offers the model only the agents in the tree', async () => {
    const rootModel = new RecordingLlm([
      {
        functionCall: {
          id: 'fc-1',
          name: 'transfer_to_agent',
          args: {agentName: 'billing_agent'},
        },
      },
    ]);
    const agent = new LlmAgent({
      name: 'root_agent',
      model: rootModel,
      subAgents: [
        new LlmAgent({
          name: 'billing_agent',
          model: new RecordingLlm([{text: 'billing-answer'}]),
          description: 'Answers billing questions',
        }),
        new LlmAgent({
          name: 'support_agent',
          model: new RecordingLlm([{text: 'support-answer'}]),
          description: 'Answers support questions',
        }),
      ],
    });

    const events = await runAgent(agent);

    expect(transferDeclarationEnum(rootModel.requests[0])).toEqual([
      'billing_agent',
      'support_agent',
    ]);
    expect(rootModel.requests[0].config?.systemInstruction).toContain(
      '**NOTE**: the only available agents for `transfer_to_agent` function are\n' +
        '`billing_agent`, `support_agent`.',
    );
    expect(
      events.some(
        (event) => event.actions?.transferToAgent === 'billing_agent',
      ),
    ).toBe(true);
    expect(events.some((event) => event.author === 'billing_agent')).toBe(true);
  });

  it('offers each agent its own targets in one run', async () => {
    const billingModel = new RecordingLlm([{text: 'billing-answer'}]);
    const agent = new LlmAgent({
      name: 'root_agent',
      model: new RecordingLlm([
        {
          functionCall: {
            id: 'fc-1',
            name: 'transfer_to_agent',
            args: {agentName: 'billing_agent'},
          },
        },
      ]),
      subAgents: [
        new LlmAgent({
          name: 'billing_agent',
          model: billingModel,
          description: 'Answers billing questions',
          subAgents: [
            new LlmAgent({
              name: 'refund_agent',
              model: new RecordingLlm([{text: 'refund-answer'}]),
              description: 'Handles refunds',
            }),
          ],
        }),
        new LlmAgent({
          name: 'support_agent',
          model: new RecordingLlm([{text: 'support-answer'}]),
          description: 'Answers support questions',
        }),
      ],
    });

    await runAgent(agent);

    expect(transferDeclarationEnum(billingModel.requests[0])).toEqual([
      'refund_agent',
      'root_agent',
      'support_agent',
    ]);
  });
});
