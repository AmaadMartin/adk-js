/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseLlm,
  BaseLlmConnection,
  createEvent,
  Event,
  FINISH_TASK_TOOL_NAME,
  InMemoryRunner,
  LlmAgent,
  LLMRegistry,
  LlmRequest,
  LlmResponse,
  node,
  Session,
  Workflow,
} from '@google/adk';
import {Part, Schema, Type} from '@google/genai';
import {beforeEach, describe, expect, it} from 'vitest';

const APP_NAME = 'task_mode_app';
const USER_ID = 'task_user';

const OBJECT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {city: {type: Type.STRING}},
  required: ['city'],
};

const PRIMITIVE_SCHEMA: Schema = {type: Type.STRING};

/** The arguments the fake model passes to `finish_task`. */
let FINISH_ARGS: Record<string, unknown> = {city: 'Paris'};

/** Calls `finish_task` on the first turn with a fixed set of arguments. */
class FinishingLlm extends BaseLlm {
  static override readonly supportedModels = [/finishing-.*/];

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield {
      content: {
        role: 'model',
        parts: [
          {
            functionCall: {
              id: 'fc-finish',
              name: FINISH_TASK_TOOL_NAME,
              args: FINISH_ARGS,
            },
          },
        ],
      },
    } as LlmResponse;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}
LLMRegistry.register(FinishingLlm);

/** Records the contents of every request it is given, and replies. */
class RecordingLlm extends BaseLlm {
  static override readonly supportedModels = [/recording-.*/];
  readonly requests: string[][] = [];

  override async *generateContentAsync(
    llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    this.requests.push(
      (llmRequest.contents ?? []).flatMap((content) =>
        (content.parts ?? []).map((part) => part.text ?? ''),
      ),
    );
    yield {
      content: {role: 'model', parts: [{text: 'reply'}]},
    } as LlmResponse;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}
LLMRegistry.register(RecordingLlm);

/** Replies with plain text and never calls a tool. */
class TalkingLlm extends BaseLlm {
  static override readonly supportedModels = [/talking-.*/];

  override async *generateContentAsync(
    _llmRequest: LlmRequest,
  ): AsyncGenerator<LlmResponse, void> {
    yield {
      content: {role: 'model', parts: [{text: 'plain reply'}]},
    } as LlmResponse;
  }

  override connect(): Promise<BaseLlmConnection> {
    throw new Error('not supported');
  }
}
LLMRegistry.register(TalkingLlm);

function scopedEvent(params: {
  invocationId: string;
  isolationScope?: string;
  finishResult?: unknown;
  finishError?: string;
  text?: string;
}): Event {
  const parts: Part[] = [];
  if (params.finishResult !== undefined) {
    parts.push({
      functionResponse: {
        id: 'fc-finish',
        name: FINISH_TASK_TOOL_NAME,
        response: {result: params.finishResult},
      },
    });
  }
  if (params.finishError !== undefined) {
    parts.push({
      functionResponse: {
        id: 'fc-finish',
        name: FINISH_TASK_TOOL_NAME,
        response: {error: params.finishError},
      },
    });
  }
  if (params.text !== undefined) {
    parts.push({text: params.text});
  }
  const event = createEvent({
    invocationId: params.invocationId,
    author: 'task_agent',
    content: {role: 'model', parts},
  });
  event.isolationScope = params.isolationScope;
  return event;
}

describe('Runner user event scoping', () => {
  let runner: InMemoryRunner;
  let session: Session;

  beforeEach(async () => {
    runner = new InMemoryRunner({
      appName: APP_NAME,
      // The task-mode sub-agent is what makes 'task_agent' a scope owner.
      agent: new LlmAgent({
        name: 'chat_agent',
        model: 'talking-1',
        subAgents: [
          new LlmAgent({
            name: 'task_agent',
            model: 'finishing-6',
            mode: 'task',
            disallowTransferToParent: true,
          }),
        ],
      }),
    });
    session = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
  });

  async function run(): Promise<void> {
    for await (const _ of runner.runAsync({
      userId: USER_ID,
      sessionId: session.id,
      newMessage: {role: 'user', parts: [{text: 'hello'}]},
    })) {
      // Drain the stream; the assertions read the persisted session.
    }
  }

  async function persistedUserEvent(): Promise<Event> {
    const reloaded = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: session.id,
    });
    const userEvent = reloaded?.events.find(
      (e) => e.author === 'user' && e.content?.parts?.[0].text === 'hello',
    );
    if (!userEvent) {
      expect.fail('the user event was not persisted');
    }
    return userEvent;
  }

  it('stamps the user event with the scope of a task still in flight', async () => {
    await runner.sessionService.appendEvent({
      session,
      event: scopedEvent({
        invocationId: 'inv-1',
        isolationScope: 'scope-a',
        text: 'what city?',
      }),
    });

    await run();

    expect((await persistedUserEvent()).isolationScope).toBe('scope-a');
  });

  it('leaves the user event unscoped when no task is in flight', async () => {
    await run();

    expect((await persistedUserEvent()).isolationScope).toBeUndefined();
  });

  it('leaves the user event unscoped after a plain isolated node ran', async () => {
    // Regression: any node may declare `isolationScope`, and stamping the
    // reply with a plain node's scope hides it from the root agent forever.
    await runner.sessionService.appendEvent({
      session,
      event: (() => {
        const event = createEvent({
          invocationId: 'inv-1',
          author: 'isolated',
          content: {role: 'model', parts: [{text: 'node output'}]},
        });
        event.isolationScope = 'flow.isolated@isolated';
        return event;
      })(),
    });

    await run();

    expect((await persistedUserEvent()).isolationScope).toBeUndefined();
  });
});

describe('Runner over a workflow with a plain isolated node', () => {
  it('keeps the second turn visible to the agent', async () => {
    // Regression: a node that declares `isolationScope` never emits
    // finish_task, so its scope stays open. Stamping the next user message
    // with it hid that message from every reader outside the scope.
    const llm = new RecordingLlm({model: 'recording-1'});
    const workflow = new Workflow({
      name: 'probe_wf',
      edges: [
        [
          'START',
          node(() => 'done', {name: 'isolated', isolationScope: true}),
          new LlmAgent({
            name: 'answerer',
            model: llm,
            includeContents: 'default',
          }),
        ],
      ],
    });
    const runner = new InMemoryRunner({appName: APP_NAME, agent: workflow});
    const session = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });

    for (const text of ['turn one', 'turn two']) {
      for await (const _ of runner.runAsync({
        userId: USER_ID,
        sessionId: session.id,
        newMessage: {role: 'user', parts: [{text}]},
      })) {
        // Drain the stream; the assertion reads what the model was asked.
      }
    }

    expect(llm.requests.at(-1)).toContain('turn two');
  }, 30000);
});

describe('Runner with a task-mode root agent', () => {
  beforeEach(() => {
    FINISH_ARGS = {city: 'Paris'};
  });

  async function runRoot(agent: LlmAgent): Promise<{
    events: Event[];
    session: Session;
  }> {
    const runner = new InMemoryRunner({appName: APP_NAME, agent});
    const created = await runner.sessionService.createSession({
      appName: APP_NAME,
      userId: USER_ID,
    });
    const events: Event[] = [];
    for await (const event of runner.runAsync({
      userId: USER_ID,
      sessionId: created.id,
      newMessage: {role: 'user', parts: [{text: 'go'}]},
    })) {
      events.push(event);
    }
    const session = await runner.sessionService.getSession({
      appName: APP_NAME,
      userId: USER_ID,
      sessionId: created.id,
    });
    if (!session) {
      expect.fail('the session disappeared');
    }
    return {events, session};
  }

  it('promotes the finish_task arguments onto the terminal event', async () => {
    const {events} = await runRoot(
      new LlmAgent({
        name: 'task_agent',
        model: 'finishing-1',
        mode: 'task',
        outputSchema: OBJECT_SCHEMA,
      }),
    );

    const terminal = events.filter((e) => e.output !== undefined).at(-1);
    expect(terminal?.output).toEqual({city: 'Paris'});
    expect(terminal?.nodeInfo?.messageAsOutput).toBe(true);
  }, 30000);

  it('unwraps the wrapper key of a primitive output schema', async () => {
    FINISH_ARGS = {result: 'Paris'};

    const {events} = await runRoot(
      new LlmAgent({
        name: 'task_agent',
        model: 'finishing-2',
        mode: 'task',
        outputSchema: PRIMITIVE_SCHEMA,
      }),
    );

    expect(events.filter((e) => e.output !== undefined).at(-1)?.output).toBe(
      'Paris',
    );
  }, 30000);

  it('writes the task output to the configured output key', async () => {
    const {session} = await runRoot(
      new LlmAgent({
        name: 'task_agent',
        model: 'finishing-3',
        mode: 'task',
        outputSchema: OBJECT_SCHEMA,
        outputKey: 'trip',
      }),
    );

    expect(session.state['trip']).toEqual({city: 'Paris'});
  }, 30000);

  it('keeps a default-mode root agent on the plain agent path', async () => {
    const {events} = await runRoot(
      new LlmAgent({name: 'chat_agent', model: 'talking-2'}),
    );

    expect(events.some((e) => e.nodeInfo !== undefined)).toBe(false);
    expect(
      events.flatMap((e) => e.content?.parts ?? []).map((p) => p.text),
    ).toContain('plain reply');
  }, 30000);
});
