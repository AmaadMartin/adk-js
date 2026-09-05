/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  Event,
  FINISH_TASK_TOOL_NAME,
  InMemoryRunner,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  Session,
} from '@google/adk';
import {Content, Schema, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

const APP_NAME = 'task_app';
const USER_ID = 'u1';

/** Finishes the task immediately, with the arguments it was configured with. */
class FinishingLlm extends BaseLlm {
  static override readonly supportedModels = [/finishing-.*/];

  constructor(
    model: string,
    private readonly args: Record<string, unknown>,
  ) {
    super({model});
  }

  static create(args: Record<string, unknown>): (model: string) => BaseLlm {
    return (model: string) => new FinishingLlm(model, args);
  }

  override async *generateContentAsync(): AsyncGenerator<LlmResponse, void> {
    yield {
      content: {
        role: 'model',
        parts: [{functionCall: {name: FINISH_TASK_TOOL_NAME, args: this.args}}],
      },
    } as LlmResponse;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}

/** Answers with plain text, and reports every request it was asked to make. */
class EchoLlm extends BaseLlm {
  static override readonly supportedModels = [/echo-.*/];
  static readonly seenBy: string[] = [];

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    EchoLlm.seenBy.push(request.model ?? this.model);
    yield {
      content: {role: 'model', parts: [{text: 'echo'}]},
    } as LlmResponse;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}

/** Asks a question on the first turn, then finishes once the user answered. */
class AskThenFinishLlm extends BaseLlm {
  static override readonly supportedModels = [/ask-then-finish-.*/];

  override async *generateContentAsync(
    request: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    const heardAnswer = (request.contents ?? []).some((content) =>
      (content.parts ?? []).some((part) => part.text?.includes('Paris')),
    );
    yield {
      content: heardAnswer
        ? {
            role: 'model',
            parts: [
              {
                functionCall: {
                  name: FINISH_TASK_TOOL_NAME,
                  args: {result: 'booked to Paris'},
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

LLMRegistry.register(EchoLlm);
LLMRegistry.register(AskThenFinishLlm);

function objectSchema(): Schema {
  return {
    type: Type.OBJECT,
    properties: {city: {type: Type.STRING}},
    required: ['city'],
  };
}

async function runOnce(
  runner: InMemoryRunner,
  session: Session,
  text: string,
): Promise<Event[]> {
  const events: Event[] = [];
  const newMessage: Content = {role: 'user', parts: [{text}]};
  for await (const event of runner.runAsync({
    userId: USER_ID,
    sessionId: session.id,
    newMessage,
  })) {
    events.push(event);
  }
  return events;
}

async function newSession(runner: InMemoryRunner): Promise<Session> {
  return runner.sessionService.createSession({
    appName: APP_NAME,
    userId: USER_ID,
  });
}

describe('Runner with a task-mode root agent', () => {
  it('promotes the finish_task arguments onto an event', async () => {
    const agent = new LlmAgent({
      name: 'task_agent',
      model: FinishingLlm.create({city: 'Paris'})('finishing-object'),
      mode: 'task',
      outputSchema: objectSchema(),
    });
    const runner = new InMemoryRunner({agent, appName: APP_NAME});

    const events = await runOnce(runner, await newSession(runner), 'book it');

    const outputs = events
      .map((event) => event.output)
      .filter((output) => output !== undefined);
    expect(outputs).toEqual([{city: 'Paris'}]);
  });

  it('unwraps a primitive output schema on promotion', async () => {
    const agent = new LlmAgent({
      name: 'task_agent',
      model: FinishingLlm.create({result: 'all done'})('finishing-primitive'),
      mode: 'task',
      outputSchema: {type: Type.STRING},
    });
    const runner = new InMemoryRunner({agent, appName: APP_NAME});

    const events = await runOnce(runner, await newSession(runner), 'go');

    expect(events.map((e) => e.output).filter((o) => o !== undefined)).toEqual([
      'all done',
    ]);
  });

  it('writes the outputKey into session state', async () => {
    const agent = new LlmAgent({
      name: 'task_agent',
      model: FinishingLlm.create({city: 'Paris'})('finishing-output-key'),
      mode: 'task',
      outputSchema: objectSchema(),
      outputKey: 'booking',
    });
    const runner = new InMemoryRunner({agent, appName: APP_NAME});
    const session = await newSession(runner);

    await runOnce(runner, session, 'book it');

    const stored = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    expect(stored?.state['booking']).toEqual({city: 'Paris'});
  });

  it('refuses a root agent in single_turn mode', async () => {
    const agent = new LlmAgent({
      name: 'task_agent',
      model: 'echo-1',
      mode: 'single_turn',
    });
    const runner = new InMemoryRunner({agent, appName: APP_NAME});
    const session = await newSession(runner);

    await expect(runOnce(runner, session, 'hi')).rejects.toThrow(
      "LlmAgent as root agent must have mode='chat' or 'task', but got " +
        "mode='single_turn'.",
    );
  });

  it('defaults a root agent with no mode to chat', async () => {
    const agent = new LlmAgent({name: 'chat_agent', model: 'echo-1'});
    const runner = new InMemoryRunner({agent, appName: APP_NAME});

    const events = await runOnce(runner, await newSession(runner), 'hi');

    expect(agent.mode).toBe('chat');
    expect(events.map((e) => e.author)).toContain('chat_agent');
  });

  it('runs the coordinator, not its task-mode sub-agent', async () => {
    const taskAgent = new LlmAgent({
      name: 'task_agent',
      model: 'ask-then-finish-1',
      mode: 'task',
    });
    const coordinator = new LlmAgent({
      name: 'coordinator',
      model: 'echo-1',
      subAgents: [taskAgent],
    });
    const runner = new InMemoryRunner({agent: coordinator, appName: APP_NAME});
    const session = await newSession(runner);

    // A prior turn authored by the sub-agent is what would otherwise make the
    // resumption picker choose it for the next turn.
    await runner.sessionService.appendEvent({
      session,
      event: {
        ...(await runOnce(runner, session, 'first'))[0],
        author: 'task_agent',
      },
    });

    const events = await runOnce(runner, session, 'second');

    expect(events.map((e) => e.author)).toContain('coordinator');
    expect(events.map((e) => e.author)).not.toContain('task_agent');
  });
});

describe('Runner joining a paused task', () => {
  async function pausedTaskRunner(): Promise<{
    runner: InMemoryRunner;
    session: Session;
  }> {
    const agent = new LlmAgent({
      name: 'task_agent',
      model: 'ask-then-finish-1',
      mode: 'task',
      isolationScope: true,
    });
    const runner = new InMemoryRunner({agent, appName: APP_NAME});
    return {runner, session: await newSession(runner)};
  }

  it('appends the follow-up under the paused invocation and scope', async () => {
    const {runner, session} = await pausedTaskRunner();
    const first = await runOnce(runner, session, 'book a flight');
    const pausedInvocationId = first[0].invocationId;

    await runOnce(runner, session, 'Paris');

    const stored = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    const followUp = stored?.events.filter(
      (event) =>
        event.author === 'user' && event.content?.parts?.[0].text === 'Paris',
    );
    expect(followUp).toHaveLength(1);
    expect(followUp?.[0].invocationId).toBe(pausedInvocationId);
    expect(followUp?.[0].isolationScope).toBeDefined();
  });

  it('delivers the follow-up to the task agent, which then finishes', async () => {
    const {runner, session} = await pausedTaskRunner();
    await runOnce(runner, session, 'book a flight');

    const events = await runOnce(runner, session, 'Paris');

    // No outputSchema, so finish_task uses its default object schema and the
    // arguments are promoted whole.
    expect(events.map((e) => e.output).filter((o) => o !== undefined)).toEqual([
      {result: 'booked to Paris'},
    ]);
  });

  it('starts a new invocation once the task closed its scope', async () => {
    const {runner, session} = await pausedTaskRunner();
    const first = await runOnce(runner, session, 'book a flight');
    await runOnce(runner, session, 'Paris');

    const third = await runOnce(runner, session, 'thanks');

    const stored = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    const last = stored?.events.filter(
      (event) =>
        event.author === 'user' && event.content?.parts?.[0].text === 'thanks',
    );
    expect(last).toHaveLength(1);
    expect(last?.[0].invocationId).not.toBe(first[0].invocationId);
    expect(last?.[0].isolationScope).toBeUndefined();
    expect(third.length).toBeGreaterThan(0);
  });
});
