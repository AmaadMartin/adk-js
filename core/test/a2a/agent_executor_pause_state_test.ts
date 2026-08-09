/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DataPart, TaskStatusUpdateEvent} from '@a2a-js/sdk';
import {
  AgentExecutionEvent,
  DefaultExecutionEventBus,
  RequestContext,
} from '@a2a-js/sdk/server';
import {
  A2AAgentExecutor,
  Event as AdkEvent,
  BaseAgent,
  createEvent,
  InMemorySessionService,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/**
 * Pauses on the credential request the ADK auth flow emits.
 */
class CredentialRequestingAgent extends BaseAgent {
  protected async *runAsyncImpl(): AsyncGenerator<AdkEvent, void, void> {
    yield createEvent({
      author: this.name,
      longRunningToolIds: ['call_1'],
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'call_1',
              name: 'adk_request_credential',
              args: {'function_call_id': 'call_0'},
            },
          },
        ],
      },
    });
  }

  protected async *runLiveImpl(): AsyncGenerator<AdkEvent, void, void> {}
}

/**
 * Pauses on an ordinary long-running call.
 */
class QuestionAskingAgent extends BaseAgent {
  protected async *runAsyncImpl(): AsyncGenerator<AdkEvent, void, void> {
    yield createEvent({
      author: this.name,
      longRunningToolIds: ['call_1'],
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'call_1', name: 'askUser', args: {}}}],
      },
    });
  }

  protected async *runLiveImpl(): AsyncGenerator<AdkEvent, void, void> {}
}

async function runExecutor(agent: BaseAgent): Promise<AgentExecutionEvent[]> {
  const executor = new A2AAgentExecutor({
    runner: {
      appName: 'pause-state-app',
      agent,
      sessionService: new InMemorySessionService(),
    },
  });

  const eventBus = new DefaultExecutionEventBus();
  const published: AgentExecutionEvent[] = [];
  eventBus.on('event', (event) => published.push(event));

  const requestContext = {
    contextId: 'test-context',
    taskId: 'test-task',
    userMessage: {
      kind: 'message',
      messageId: 'msg1',
      role: 'user',
      parts: [{kind: 'text', text: 'what is the weather?'}],
    },
  } as RequestContext;

  await executor.execute(requestContext, eventBus);

  return published;
}

function finalStatusUpdate(
  events: AgentExecutionEvent[],
): TaskStatusUpdateEvent {
  const final = events.at(-1);
  if (final?.kind !== 'status-update') {
    expect.fail(`last published event is not a status update: ${final?.kind}`);
  }
  return final;
}

describe('A2AAgentExecutor pause state', () => {
  it('publishes auth-required when the agent requests end-user credentials', async () => {
    const events = await runExecutor(
      new CredentialRequestingAgent({name: 'credential_agent'}),
    );

    const final = finalStatusUpdate(events);
    expect(final.status.state).toBe('auth-required');
    expect(final.final).toBe(true);

    const parts = final.status.message?.parts ?? [];
    expect((parts[0] as DataPart).data['name']).toBe('adk_request_credential');
  });

  it('publishes input-required when the agent asks the user a question', async () => {
    const events = await runExecutor(
      new QuestionAskingAgent({name: 'question_agent'}),
    );

    const final = finalStatusUpdate(events);
    expect(final.status.state).toBe('input-required');
    expect(final.final).toBe(true);
  });
});
