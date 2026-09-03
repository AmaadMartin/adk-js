/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message, Task} from '@a2a-js/sdk';
import {Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {createTaskFailedEvent, TaskState} from '../../src/a2a/a2a_event.js';
import {RemoteA2AAgent} from '../../src/a2a/a2a_remote_agent.js';
import {findFinishTaskArgsFromHistory} from '../../src/a2a/a2a_remote_agent_task_utils.js';
import {AdkMetadataKeys} from '../../src/a2a/metadata_converter_utils.js';
import {Event as AdkEvent, createEvent} from '../../src/events/event.js';
import {createSession} from '../../src/sessions/session.js';
import {
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
} from '../../src/tools/finish_task_tool.js';
import {SchemaLike} from '../../src/utils/schema.js';
import {
  A2AChunk,
  fakeClient,
  FakeTransport,
  invocationContext,
  peerAgentCard,
} from './test_helpers.js';

const SCOPE = 'fc-delegate';

/** The coordinator's call that delegated the task; its id is the scope. */
function triggerEvent(args: Record<string, unknown> = {}): AdkEvent {
  return createEvent({
    author: 'coordinator',
    content: {
      role: 'model',
      parts: [{functionCall: {id: SCOPE, name: 'research_worker', args}}],
    },
  });
}

/** An in-scope event authored by `author`. */
function scopedEvent(
  author: string,
  parts: AdkEvent['content'] extends undefined
    ? never
    : NonNullable<NonNullable<AdkEvent['content']>['parts']>,
): AdkEvent {
  return createEvent({
    author,
    isolationScope: SCOPE,
    content: {role: author === 'user' ? 'user' : 'model', parts},
  });
}

/** The peer's `finish_task` reply, as the remote sends it back. */
function finishTaskReply(id?: string): A2AChunk {
  return {
    kind: 'message',
    messageId: 'm-finish',
    role: 'agent',
    parts: [
      {
        kind: 'data',
        data: {
          name: FINISH_TASK_TOOL_NAME,
          ...(id ? {id} : {}),
          response: {result: FINISH_TASK_SUCCESS_RESULT},
        },
        metadata: {adk_type: 'function_response'},
      },
    ],
  };
}

/** The failure shape adk-js's own A2A server emits: an incremental update. */
function failedStatusUpdate(state: TaskState, text?: string): A2AChunk {
  return {
    kind: 'status-update',
    taskId: 'task-1',
    contextId: 'ctx-1',
    final: true,
    status: {
      state,
      ...(text
        ? {
            message: {
              kind: 'message',
              messageId: 'm-status',
              role: 'agent',
              parts: [{kind: 'text', text}],
            },
          }
        : {}),
    },
  };
}

function failedTask(state: TaskState, text?: string): Task {
  return {
    kind: 'task',
    id: 'task-1',
    contextId: 'ctx-1',
    status: {
      state,
      ...(text
        ? {
            message: {
              kind: 'message',
              messageId: 'm-status',
              role: 'agent',
              parts: [{kind: 'text', text}],
            },
          }
        : {}),
    },
  };
}

async function collect(
  events: AsyncGenerator<AdkEvent, void, void>,
): Promise<AdkEvent[]> {
  const collected: AdkEvent[] = [];
  for await (const event of events) {
    collected.push(event);
  }
  return collected;
}

function taskAgent(
  transport: FakeTransport,
  outputSchema?: SchemaLike,
): RemoteA2AAgent {
  return new RemoteA2AAgent({
    name: 'research_worker',
    agentCard: peerAgentCard(),
    client: fakeClient(transport),
    mode: 'task',
    ...(outputSchema ? {outputSchema} : {}),
  });
}

describe('RemoteA2AAgent task-mode history', () => {
  it('sends only the scope plus the triggering call', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'other task talk'}]},
        }),
        triggerEvent({topic: 'quantum'}),
        scopedEvent('user', [{text: 'in scope'}]),
      ],
    });

    await collect(agent.runAsync(ctx));

    const message = transport.sends[0].params.message as Message;
    const dumped = JSON.stringify(message.parts);
    expect(dumped).toContain('in scope');
    expect(dumped).toContain('quantum');
    expect(dumped).not.toContain('other task talk');
  });

  it('marks the user parts as user input', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent(), scopedEvent('user', [{text: 'hello'}])],
    });

    await collect(agent.runAsync(ctx));

    const message = transport.sends[0].params.message as Message;
    const userPart = message.parts.find(
      (part) => part.kind === 'text' && part.text === 'hello',
    );
    expect(userPart?.metadata).toMatchObject({is_user_input: true});
  });

  it('skips a sibling call aimed at another tool', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [
        triggerEvent(),
        // A user-authored event is forwarded as-is, so the per-part filter is
        // what decides which of its calls the peer may see.
        scopedEvent('user', [
          {functionCall: {id: 'fc-other', name: 'weather', args: {}}},
          {text: 'and a question'},
        ]),
      ],
    });

    await collect(agent.runAsync(ctx));

    const dumped = JSON.stringify(
      (transport.sends[0].params.message as Message).parts,
    );
    expect(dumped).toContain('and a question');
    expect(dumped).not.toContain('weather');
  });

  it('flattens a function response answering a call the peer never made', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [
        triggerEvent(),
        scopedEvent('user', [
          {
            functionResponse: {
              id: 'fc-other',
              name: 'weather',
              response: {temp: 21},
            },
          },
        ]),
      ],
    });

    await collect(agent.runAsync(ctx));

    const dumped = JSON.stringify(
      (transport.sends[0].params.message as Message).parts,
    );
    expect(dumped).toContain('Tool weather returned: {\\"temp\\":21}');
  });

  it('keeps a function response answering the peer own call as data', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [
        triggerEvent(),
        scopedEvent('research_worker', [
          {functionCall: {id: 'fc-mine', name: 'search', args: {q: 'x'}}},
        ]),
        scopedEvent('user', [
          {
            functionResponse: {
              id: 'fc-mine',
              name: 'search',
              response: {hits: 3},
            },
          },
        ]),
      ],
    });

    await collect(agent.runAsync(ctx));

    const parts = (transport.sends[0].params.message as Message).parts;
    expect(parts.some((part) => part.kind === 'data')).toBe(true);
    expect(JSON.stringify(parts)).not.toContain('Tool search returned');
  });

  it('fails when the isolation scope names no triggering call', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: 'workflow/path/node',
      events: [
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'hello'}]},
        }),
      ],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(events[0].errorMessage).toMatch(
      /could not find the triggering FunctionCall for isolation scope/,
    );
    expect(transport.sends).toHaveLength(0);
  });

  it('stops at the peer own previous reply once it reports a context id', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport);
    const previous = createEvent({
      author: 'research_worker',
      isolationScope: SCOPE,
      content: {role: 'model', parts: [{text: 'earlier reply'}]},
      customMetadata: {
        [AdkMetadataKeys.RESPONSE]: {kind: 'message'},
        [AdkMetadataKeys.CONTEXT_ID]: 'ctx-9',
      },
    });
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [
        triggerEvent(),
        scopedEvent('user', [{text: 'older turn'}]),
        previous,
        scopedEvent('user', [{text: 'newest turn'}]),
      ],
    });

    await collect(agent.runAsync(ctx));

    const message = transport.sends[0].params.message as Message;
    expect(message.contextId).toBe('ctx-9');
    const dumped = JSON.stringify(message.parts);
    expect(dumped).toContain('newest turn');
    expect(dumped).not.toContain('older turn');
  });

  it('resends the whole scope to a peer that reports no context id', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport);
    const previous = createEvent({
      author: 'research_worker',
      isolationScope: SCOPE,
      content: {role: 'model', parts: [{text: 'earlier reply'}]},
      customMetadata: {[AdkMetadataKeys.RESPONSE]: {kind: 'message'}},
    });
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [
        triggerEvent(),
        scopedEvent('user', [{text: 'older turn'}]),
        previous,
        scopedEvent('user', [{text: 'newest turn'}]),
      ],
    });

    await collect(agent.runAsync(ctx));

    const dumped = JSON.stringify(
      (transport.sends[0].params.message as Message).parts,
    );
    expect(dumped).toContain('older turn');
    expect(dumped).toContain('newest turn');
  });
});

describe('RemoteA2AAgent task-mode completion', () => {
  it('promotes the finish_task arguments and releases control', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport, {
      type: Type.OBJECT,
      properties: {summary: {type: Type.STRING}},
    });
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [
        triggerEvent(),
        scopedEvent('research_worker', [
          {
            functionCall: {
              id: 'fc-finish',
              name: FINISH_TASK_TOOL_NAME,
              args: {summary: 'all done'},
            },
          },
        ]),
      ],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(events[events.length - 1].actions.endOfAgent).toBe(true);
    const terminal = events.find((event) => event.output !== undefined);
    expect(terminal?.output).toEqual({summary: 'all done'});
  });

  it('unwraps the result key for a non-object output schema', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport, {type: Type.STRING});
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [
        triggerEvent(),
        scopedEvent('research_worker', [
          {
            functionCall: {
              id: 'fc-finish',
              name: FINISH_TASK_TOOL_NAME,
              args: {result: 'plain text'},
            },
          },
        ]),
      ],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(events.find((event) => event.output !== undefined)?.output).toBe(
      'plain text',
    );
  });

  it('sets no output when the history holds no finish_task call', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(events.every((event) => event.output === undefined)).toBe(true);
    expect(events[events.length - 1].actions.endOfAgent).toBe(true);
  });

  it('reports a failed remote task and releases control', async () => {
    const transport = new FakeTransport([failedTask(TaskState.FAILED, 'oops')]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    const error = events.find((event) =>
      event.errorMessage?.startsWith('Remote A2A task failed:'),
    );
    expect(error?.errorMessage).toBe('Remote A2A task failed: oops');
    expect(error?.customMetadata?.[AdkMetadataKeys.TASK_ID]).toBe('task-1');
    expect(events[events.length - 1].actions.endOfAgent).toBe(true);
  });

  it('reports a canceled remote task with the fixed reason', async () => {
    const transport = new FakeTransport([failedTask(TaskState.CANCELED)]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(
      events.some(
        (event) =>
          event.errorMessage === 'Remote A2A task failed: Task canceled',
      ),
    ).toBe(true);
  });

  it('releases control for a failure sent as a status update', async () => {
    const transport = new FakeTransport([
      failedStatusUpdate(TaskState.FAILED, 'oops'),
    ]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    const error = events.find((event) =>
      event.errorMessage?.startsWith('Remote A2A task failed:'),
    );
    expect(error?.errorMessage).toBe('Remote A2A task failed: oops');
    expect(error?.customMetadata?.[AdkMetadataKeys.TASK_ID]).toBe('task-1');
    expect(
      events.find((event) => event.content?.parts?.[0].functionResponse)
        ?.content?.parts?.[0].functionResponse?.response,
    ).toEqual({result: 'Task failed.'});
    expect(events[events.length - 1].actions.endOfAgent).toBe(true);
  });

  it('releases control for a cancellation sent as a status update', async () => {
    const transport = new FakeTransport([
      failedStatusUpdate(TaskState.CANCELED),
    ]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(
      events.some(
        (event) =>
          event.errorMessage === 'Remote A2A task failed: Task canceled',
      ),
    ).toBe(true);
    expect(events[events.length - 1].actions.endOfAgent).toBe(true);
  });

  it('releases control for the event the ADK A2A server emits on failure', async () => {
    const transport = new FakeTransport([
      createTaskFailedEvent({
        taskId: 'task-1',
        contextId: 'ctx-1',
        error: new Error('remote blew up'),
      }),
    ]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(
      events.some(
        (event) =>
          event.errorMessage === 'Remote A2A task failed: remote blew up',
      ),
    ).toBe(true);
    expect(events[events.length - 1].actions.endOfAgent).toBe(true);
  });

  it('does not release control for a non-terminal status update', async () => {
    const transport = new FakeTransport([
      failedStatusUpdate(TaskState.WORKING, 'still going'),
    ]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(
      events.some((event) =>
        event.errorMessage?.startsWith('Remote A2A task failed:'),
      ),
    ).toBe(false);
  });

  it('reports Unknown error when a failed task carries no text', async () => {
    const transport = new FakeTransport([failedTask(TaskState.FAILED)]);
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(
      events.some(
        (event) =>
          event.errorMessage === 'Remote A2A task failed: Unknown error',
      ),
    ).toBe(true);
  });
});

describe('RemoteA2AAgent task-mode control release', () => {
  it('releases control when the peer cannot be reached', async () => {
    const transport = new FakeTransport([], new Error('boom'));
    const agent = taskAgent(transport);
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(events[0].errorMessage).toMatch(/^A2A request failed: /);
    expect(events[1].content?.parts?.[0].functionResponse?.response).toEqual({
      result: 'Task failed.',
    });
    expect(events[2].actions.endOfAgent).toBe(true);
  });

  it('releases control when there is nothing to send', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = new RemoteA2AAgent({
      name: 'research_worker',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      mode: 'task',
      // Every part is dropped, so the request has nothing left to carry.
      genaiPartConverter: () => undefined,
    });
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(transport.sends).toHaveLength(0);
    expect(events[events.length - 1].actions.endOfAgent).toBe(true);
  });

  it('releases control when an interceptor aborts the request', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = new RemoteA2AAgent({
      name: 'research_worker',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      mode: 'task',
      requestInterceptors: [
        {
          beforeRequest: async (_ctx, _request, params) => [
            createEvent({author: 'research_worker', errorMessage: 'blocked'}),
            params,
          ],
        },
      ],
    });
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent({topic: 'x'})],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(events[0].errorMessage).toBe('blocked');
    expect(events[events.length - 1].actions.endOfAgent).toBe(true);
    expect(transport.sends).toHaveLength(0);
  });

  it('keeps control while it waits for a credential', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = new RemoteA2AAgent({
      name: 'research_worker',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      mode: 'task',
      authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
    });
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(events).toHaveLength(1);
    expect(events[0].content?.parts?.[0].functionCall?.name).toBe(
      'adk_request_credential',
    );
    expect(events.some((event) => event.actions.endOfAgent)).toBe(false);
  });

  it('releases control when authentication fails', async () => {
    const transport = new FakeTransport([finishTaskReply()]);
    const agent = new RemoteA2AAgent({
      name: 'research_worker',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
      mode: 'task',
      authScheme: {type: 'oauth2', flows: {}},
    });
    const ctx = invocationContext({
      agent,
      isolationScope: SCOPE,
      events: [triggerEvent()],
    });

    const events = await collect(agent.runAsync(ctx));

    expect(events[0].errorMessage).toMatch(
      /^Failed to authenticate remote A2A agent: /,
    );
    expect(events[events.length - 1].actions.endOfAgent).toBe(true);
  });

  it('emits no end-of-agent event outside task mode', async () => {
    const transport = new FakeTransport([], new Error('boom'));
    const agent = new RemoteA2AAgent({
      name: 'research_worker',
      agentCard: peerAgentCard(),
      client: fakeClient(transport),
    });

    const events = await collect(agent.runAsync(invocationContext({agent})));

    expect(events).toHaveLength(1);
    expect(events[0].actions.endOfAgent).toBeUndefined();
  });
});

describe('findFinishTaskArgsFromHistory', () => {
  const finishCall = (id: string, args: Record<string, unknown>) =>
    createEvent({
      author: 'research_worker',
      isolationScope: SCOPE,
      content: {
        role: 'model',
        parts: [{functionCall: {id, name: FINISH_TASK_TOOL_NAME, args}}],
      },
    });

  it('returns the newest call when nothing pins an id', () => {
    const session = createSession({
      id: 's',
      appName: 'a',
      userId: 'u',
      events: [finishCall('fc-1', {n: 1}), finishCall('fc-2', {n: 2})],
    });
    expect(findFinishTaskArgsFromHistory(session, SCOPE)).toEqual({n: 2});
  });

  it('matches the call the terminal response answers', () => {
    const session = createSession({
      id: 's',
      appName: 'a',
      userId: 'u',
      events: [finishCall('fc-1', {n: 1}), finishCall('fc-2', {n: 2})],
    });
    const completed = createEvent({
      author: 'research_worker',
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              id: 'fc-1',
              name: FINISH_TASK_TOOL_NAME,
              response: {result: FINISH_TASK_SUCCESS_RESULT},
            },
          },
        ],
      },
    });
    expect(findFinishTaskArgsFromHistory(session, SCOPE, completed)).toEqual({
      n: 1,
    });
  });

  it('ignores calls outside the isolation scope', () => {
    const outOfScope = createEvent({
      author: 'research_worker',
      isolationScope: 'other',
      content: {
        role: 'model',
        parts: [
          {functionCall: {id: 'x', name: FINISH_TASK_TOOL_NAME, args: {n: 9}}},
        ],
      },
    });
    const session = createSession({
      id: 's',
      appName: 'a',
      userId: 'u',
      events: [outOfScope],
    });
    expect(findFinishTaskArgsFromHistory(session, SCOPE)).toBeUndefined();
  });

  it('ignores a call to another tool', () => {
    const other = createEvent({
      author: 'research_worker',
      isolationScope: SCOPE,
      content: {
        role: 'model',
        parts: [{functionCall: {id: 'x', name: 'search', args: {n: 9}}}],
      },
    });
    const session = createSession({
      id: 's',
      appName: 'a',
      userId: 'u',
      events: [other],
    });
    expect(findFinishTaskArgsFromHistory(session, SCOPE)).toBeUndefined();
  });
});
