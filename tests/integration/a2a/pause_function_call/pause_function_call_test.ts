/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard, TaskState} from '@a2a-js/sdk';
import {
  AgentExecutor,
  DefaultRequestHandler,
  ExecutionEventBus,
  InMemoryTaskStore,
  RequestContext,
} from '@a2a-js/sdk/server';
import {
  agentCardHandler,
  jsonRpcHandler,
  UserBuilder,
} from '@a2a-js/sdk/server/express';
import {
  Event as AdkEvent,
  InMemoryRunner,
  isFinalResponse,
  RemoteA2AAgent,
} from '@google/adk';
import {createUserContent} from '@google/genai';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {Server} from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const PROMPT = 'Which region should I deploy to?';

/**
 * A remote that is not an ADK agent: it pauses with a bare text part and never
 * emits a long-running function call of its own. `pauseState` selects the
 * state it pauses in.
 */
class PlainTextRemote implements AgentExecutor {
  pauseState: TaskState = 'input-required';

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    bus.publish({
      kind: 'task',
      id: ctx.taskId,
      contextId: ctx.contextId,
      status: {state: 'submitted'},
    });
    bus.publish({
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: {
        state: this.pauseState,
        message: {
          kind: 'message',
          messageId: randomUUID(),
          role: 'agent',
          parts: [{kind: 'text', text: PROMPT}],
        },
      },
      final: true,
    });
    bus.finished();
  }

  async cancelTask(): Promise<void> {}
}

describe('A2A: pause function call from a non-ADK remote', () => {
  const remote = new PlainTextRemote();
  let server: Server;
  let card: AgentCard;

  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
      expect.fail('the test server did not bind a TCP port');
    }
    const {port} = address;

    card = {
      protocolVersion: '0.3.0',
      name: 'plain_text_remote',
      description: 'A remote that pauses with plain text.',
      version: '1.0.0',
      url: `http://127.0.0.1:${port}/jsonrpc`,
      preferredTransport: 'JSONRPC',
      capabilities: {streaming: true},
      defaultInputModes: ['text/plain'],
      defaultOutputModes: ['text/plain'],
      skills: [],
    };

    const handler = new DefaultRequestHandler(
      card,
      new InMemoryTaskStore(),
      remote,
    );
    app.use(
      '/.well-known/agent-card.json',
      agentCardHandler({agentCardProvider: handler}),
    );
    app.use(
      '/jsonrpc',
      jsonRpcHandler({
        requestHandler: handler,
        userBuilder: UserBuilder.noAuthentication,
      }),
    );
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  async function callRemote(): Promise<AdkEvent> {
    const runner = new InMemoryRunner({
      agent: new RemoteA2AAgent({name: 'caller_agent', agentCard: card}),
      appName: 'caller',
    });
    const session = await runner.sessionService.createSession({
      appName: 'caller',
      userId: 'caller-user',
    });

    const events: AdkEvent[] = [];
    for await (const event of runner.runAsync({
      userId: 'caller-user',
      sessionId: session.id,
      newMessage: createUserContent('deploy the service'),
    })) {
      events.push(event);
    }

    const last = events.at(-1);
    if (!last) {
      expect.fail('the remote produced no events');
    }
    return last;
  }

  it('pauses the caller on an input-required remote', async () => {
    remote.pauseState = 'input-required';

    const event = await callRemote();

    const functionCall = event.content?.parts?.[0].functionCall;
    expect(functionCall?.name).toBe(
      'mock_function_call_for_required_user_input',
    );
    expect(functionCall?.args).toEqual({'input_required': PROMPT});
    expect(event.longRunningToolIds).toEqual([functionCall?.id]);
    expect(isFinalResponse(event)).toBe(true);
  });

  it('pauses the caller on an auth-required remote', async () => {
    remote.pauseState = 'auth-required';

    const event = await callRemote();

    const functionCall = event.content?.parts?.[0].functionCall;
    expect(functionCall?.name).toBe(
      'mock_function_call_for_required_user_auth',
    );
    expect(functionCall?.args).toEqual({'auth_required': PROMPT});
    expect(event.longRunningToolIds).toEqual([functionCall?.id]);
    expect(isFinalResponse(event)).toBe(true);
  });

  it('leaves a completed remote response as plain text', async () => {
    remote.pauseState = 'completed';

    const event = await callRemote();

    expect(event.content?.parts).toEqual([{text: PROMPT, thought: false}]);
    expect(event.longRunningToolIds).toEqual([]);
  });
});
