/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Part as A2APart, AgentCard, TaskState} from '@a2a-js/sdk';
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
import {Content, createUserContent} from '@google/genai';
import express from 'express';
import {randomUUID} from 'node:crypto';
import {Server} from 'node:http';
import {afterAll, beforeAll, describe, expect, it} from 'vitest';

const PROMPT = 'Which region should I deploy to?';

function firstText(parts: A2APart[]): string {
  const part = parts.find((candidate) => candidate.kind === 'text');
  return part ? part.text : '';
}

/**
 * A remote that is not an ADK agent: it pauses with a bare text part and never
 * emits a long-running function call of its own. `pauseState` selects the
 * state it pauses in. A follow-up message on an existing task completes it.
 */
class PlainTextRemote implements AgentExecutor {
  pauseState: TaskState = 'input-required';

  /** The parts of the most recent message this remote received. */
  received: A2APart[] = [];

  async execute(ctx: RequestContext, bus: ExecutionEventBus): Promise<void> {
    this.received = ctx.userMessage.parts;
    const isFollowUp = ctx.task !== undefined;

    if (!isFollowUp) {
      bus.publish({
        kind: 'task',
        id: ctx.taskId,
        contextId: ctx.contextId,
        status: {state: 'submitted'},
      });
    }

    bus.publish({
      kind: 'status-update',
      taskId: ctx.taskId,
      contextId: ctx.contextId,
      status: {
        state: isFollowUp ? 'completed' : this.pauseState,
        message: {
          kind: 'message',
          messageId: randomUUID(),
          role: 'agent',
          parts: [
            {
              kind: 'text',
              text: isFollowUp
                ? `Deploying to ${firstText(ctx.userMessage.parts)}`
                : PROMPT,
            },
          ],
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

  async function createCaller(): Promise<{
    run: (message: Content) => Promise<AdkEvent>;
  }> {
    const runner = new InMemoryRunner({
      agent: new RemoteA2AAgent({name: 'caller_agent', agentCard: card}),
      appName: 'caller',
    });
    const session = await runner.sessionService.createSession({
      appName: 'caller',
      userId: 'caller-user',
    });

    return {
      run: async (message: Content) => {
        const events: AdkEvent[] = [];
        for await (const event of runner.runAsync({
          userId: 'caller-user',
          sessionId: session.id,
          newMessage: message,
        })) {
          events.push(event);
        }

        const last = events.at(-1);
        if (!last) {
          expect.fail('the remote produced no events');
        }
        return last;
      },
    };
  }

  it('pauses the caller on an input-required remote', async () => {
    remote.pauseState = 'input-required';
    const caller = await createCaller();

    const event = await caller.run(createUserContent('deploy the service'));

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
    const caller = await createCaller();

    const event = await caller.run(createUserContent('deploy the service'));

    const functionCall = event.content?.parts?.[0].functionCall;
    expect(functionCall?.name).toBe(
      'mock_function_call_for_required_user_auth',
    );
    expect(functionCall?.args).toEqual({'auth_required': PROMPT});
    expect(event.longRunningToolIds).toEqual([functionCall?.id]);
    expect(isFinalResponse(event)).toBe(true);
  });

  it('sends the answer back to the remote as plain text', async () => {
    remote.pauseState = 'input-required';
    const caller = await createCaller();

    const paused = await caller.run(createUserContent('deploy the service'));
    const functionCall = paused.content?.parts?.[0].functionCall;
    if (!functionCall?.id) {
      expect.fail('the caller did not pause on a function call');
    }

    const resumed = await caller.run({
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: functionCall.id,
            name: functionCall.name,
            response: {'result': 'us-central1'},
          },
        },
      ],
    });

    expect(remote.received).toHaveLength(1);
    const [answer] = remote.received;
    if (answer.kind !== 'text') {
      expect.fail(`the remote received a ${answer.kind} part, not text`);
    }
    expect(answer.text).toBe('us-central1');
    expect(resumed.content?.parts).toEqual([
      {text: 'Deploying to us-central1', thought: false},
    ]);
  });

  it('leaves a completed remote response as plain text', async () => {
    remote.pauseState = 'completed';
    const caller = await createCaller();

    const event = await caller.run(createUserContent('deploy the service'));

    expect(event.content?.parts).toEqual([{text: PROMPT, thought: false}]);
    expect(event.longRunningToolIds).toEqual([]);
  });
});
