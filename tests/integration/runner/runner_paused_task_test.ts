/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A reply sent while a task agent is paused must reach that agent.
 *
 * Three pieces have to agree for that to happen: the runner stamps the reply
 * with the paused task's isolation scope and reuses its invocation, the node
 * runtime keeps driving the same task agent, and the content builder lets a
 * scoped event through to the agent that owns the scope. No unit test covers
 * the combination.
 */

import {
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  Event,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
  InMemoryRunner,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  Session,
} from '@google/adk';
import {Type} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'paused_task_app';
const USER_ID = 'u1';

/** Records every request, asks once, then finishes when the city arrives. */
class BookingLlm extends BaseLlm {
  static override readonly supportedModels = [/booking-.*/];
  static requests: LlmRequest[] = [];

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    BookingLlm.requests.push(request);
    const heardCity = textOf(request).includes('Paris');
    yield {
      content: heardCity
        ? {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: FINISH_TASK_TOOL_NAME,
                  args: {city: 'Paris'},
                },
              },
            ],
          }
        : {role: 'model', parts: [{text: 'Which city?'}]},
    } as LlmResponse;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}
LLMRegistry.register(BookingLlm);

function textOf(request: LlmRequest): string {
  return (request.contents ?? [])
    .flatMap((content) => content.parts ?? [])
    .map((part) => part.text ?? '')
    .join(' ');
}

async function drain(
  runner: InMemoryRunner,
  session: Session,
  text: string,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: session.id,
    newMessage: {role: 'user', parts: [{text}]},
  })) {
    events.push(event);
  }
  return events;
}

describe('a reply to a paused task agent', () => {
  let runner: InMemoryRunner;
  let session: Session;

  beforeEach(async () => {
    BookingLlm.requests = [];
    const taskAgent = new LlmAgent({
      name: 'booking_agent',
      model: 'booking-1',
      mode: 'task',
      isolationScope: true,
      outputSchema: {
        type: Type.OBJECT,
        properties: {city: {type: Type.STRING}},
        required: ['city'],
      },
    });
    runner = new InMemoryRunner({agent: taskAgent, appName: APP_NAME});
    session = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
  });

  it('joins the paused invocation and finishes the task', async () => {
    const first = await drain(runner, session, 'book me a flight');
    expect(first.some((e) => e.isolationScope)).toBe(true);

    const second = await drain(runner, session, 'Paris');

    const stored = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    const reply = stored?.events.find(
      (event) =>
        event.author === 'user' && event.content?.parts?.[0].text === 'Paris',
    );
    if (!reply) {
      expect.fail('the reply was not appended to the session');
    }
    // The runner: same invocation, stamped with the task's scope.
    expect(reply.invocationId).toBe(first[0].invocationId);
    expect(reply.isolationScope).toBeDefined();
    // The content builder: the task agent actually saw the reply.
    expect(
      textOf(BookingLlm.requests[BookingLlm.requests.length - 1]),
    ).toContain('Paris');
    // The node runtime: the task finished and its result reached the caller.
    expect(second.map((e) => e.output).filter((o) => o !== undefined)).toEqual([
      {city: 'Paris'},
    ]);
  });

  it('withholds the turns of a task that already finished', async () => {
    for (const event of finishedTaskEvents('some-other-task')) {
      await runner.sessionService.appendEvent({session, event});
    }

    await drain(runner, session, 'book me a flight');
    await drain(runner, session, 'Paris');

    const lastRequest = BookingLlm.requests[BookingLlm.requests.length - 1];
    // The closed scope neither captured the reply nor leaked its own turns.
    expect(textOf(lastRequest)).toContain('Paris');
    expect(textOf(lastRequest)).not.toContain('Lisbon');
  });
});

/** A completed task's turns: one message, then its terminal finish_task. */
function finishedTaskEvents(scope: string): Event[] {
  const turn = createEvent({
    invocationId: 'inv-foreign',
    author: 'user',
    content: {role: 'user', parts: [{text: 'Lisbon'}]},
  });
  const finished = createEvent({
    invocationId: 'inv-foreign',
    author: 'other_agent',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'fr-foreign',
            name: FINISH_TASK_TOOL_NAME,
            response: {result: FINISH_TASK_SUCCESS_RESULT},
          },
        },
      ],
    },
  });
  turn.isolationScope = scope;
  finished.isolationScope = scope;
  return [turn, finished];
}
