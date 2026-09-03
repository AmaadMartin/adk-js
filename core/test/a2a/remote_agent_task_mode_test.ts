/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {Client, ClientFactory} from '@a2a-js/sdk/client';
import {
  Event as AdkEvent,
  createEvent,
  createSession,
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  getFunctionResponses,
  InvocationContext,
  PluginManager,
  RemoteA2AAgent,
  RemoteA2AAgentConfig,
} from '@google/adk';
import {Type} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const AGENT_NAME = 'peer_agent';
const TASK_SCOPE = 'coordinator-call-1';

const CARD: AgentCard = {
  name: 'peer',
  description: 'the peer',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  url: 'https://peer.example.com/a2a',
  skills: [],
  capabilities: {streaming: true},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
};

interface Harness {
  client: Client;
  clientFactory: ClientFactory;
  sent: Array<Record<string, unknown>>;
}

function harnessYielding(...chunks: Array<Record<string, unknown>>): Harness {
  const sent: Array<Record<string, unknown>> = [];
  const client = {
    sendMessageStream: vi.fn((params: {message: Record<string, unknown>}) => {
      sent.push(params.message);
      return (async function* () {
        for (const chunk of chunks) {
          yield chunk;
        }
      })();
    }),
    sendMessage: vi.fn(),
  } as unknown as Client;
  const clientFactory = {
    createFromAgentCard: vi.fn().mockResolvedValue(client),
  } as unknown as ClientFactory;
  return {client, clientFactory, sent};
}

/** The peer's terminal `finish_task` reply, as an A2A message. */
function finishTaskMessage(result: string) {
  return {
    kind: 'message',
    messageId: 'm-finish',
    role: 'agent',
    parts: [
      {
        kind: 'data',
        data: {name: 'finish_task', response: {result}, id: 'peer-fc-1'},
        metadata: {adk_type: 'function_response'},
      },
    ],
  };
}

/** The peer's own `finish_task` call, recorded in the session by an earlier turn. */
function finishTaskCall(args: Record<string, unknown>): AdkEvent {
  return createEvent({
    author: AGENT_NAME,
    isolationScope: TASK_SCOPE,
    content: {
      role: 'model',
      parts: [{functionCall: {id: 'peer-fc-1', name: 'finish_task', args}}],
    },
  });
}

/** The coordinator's delegating call, whose id opens the task scope. */
function triggerCall(): AdkEvent {
  return createEvent({
    author: 'coordinator',
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: TASK_SCOPE,
            name: AGENT_NAME,
            args: {request: 'book a table'},
          },
        },
      ],
    },
  });
}

function createContext(
  events: AdkEvent[],
  isolationScope?: string,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    isolationScope,
    pluginManager: new PluginManager([]),
    session: createSession({id: 's-1', appName: 'app-1', events}),
  });
}

function taskAgent(
  harness: Harness,
  overrides: Partial<RemoteA2AAgentConfig> = {},
): RemoteA2AAgent {
  return new RemoteA2AAgent({
    name: AGENT_NAME,
    agentCard: CARD,
    clientFactory: harness.clientFactory,
    mode: 'task',
    ...overrides,
  });
}

async function collect(
  agent: RemoteA2AAgent,
  ctx: InvocationContext,
): Promise<AdkEvent[]> {
  const events: AdkEvent[] = [];
  for await (const event of agent.runAsync(ctx)) {
    events.push(event);
  }
  return events;
}

function finishTaskResult(event: AdkEvent): unknown {
  return (
    getFunctionResponses(event).find((fr) => fr.name === 'finish_task')
      ?.response as {result?: unknown} | undefined
  )?.result;
}

describe('RemoteA2AAgent task mode', () => {
  let harness: Harness;

  beforeEach(() => {
    harness = harnessYielding(finishTaskMessage(FINISH_TASK_SUCCESS_RESULT));
  });

  it('promotes the finish_task arguments to the task output', async () => {
    const ctx = createContext(
      [triggerCall(), finishTaskCall({table: 'window', time: '19:00'})],
      TASK_SCOPE,
    );

    const events = await collect(taskAgent(harness), ctx);

    const output = events.find((event) => event.output !== undefined);
    expect(output?.output).toEqual({table: 'window', time: '19:00'});
  });

  it('unwraps the output when the schema is not an object', async () => {
    const ctx = createContext(
      [triggerCall(), finishTaskCall({result: 'booked'})],
      TASK_SCOPE,
    );

    const events = await collect(
      taskAgent(harness, {outputSchema: {type: Type.STRING}}),
      ctx,
    );

    expect(events.find((event) => event.output !== undefined)?.output).toBe(
      'booked',
    );
  });

  it('leaves the output unset when no finish_task call is in history', async () => {
    const ctx = createContext([triggerCall()], TASK_SCOPE);

    const events = await collect(taskAgent(harness), ctx);

    expect(events.every((event) => event.output === undefined)).toBe(true);
  });

  it('hands control back once the task completes', async () => {
    const ctx = createContext(
      [triggerCall(), finishTaskCall({table: 'window'})],
      TASK_SCOPE,
    );

    const events = await collect(taskAgent(harness), ctx);

    expect(events.at(-1)?.actions.endOfAgent).toBe(true);
    // A completed task reports no error, so no failure response is written.
    expect(
      events.some((e) => finishTaskResult(e) === FINISH_TASK_ERROR_RESULT),
    ).toBe(false);
  });

  it('ignores a duplicate finish_task response after the first', async () => {
    const duplicating = harnessYielding(
      finishTaskMessage(FINISH_TASK_SUCCESS_RESULT),
      {
        kind: 'message',
        messageId: 'm-late',
        role: 'agent',
        parts: [{kind: 'text', text: 'LATE_CHATTER'}],
      },
    );
    const ctx = createContext(
      [triggerCall(), finishTaskCall({table: 'window'})],
      TASK_SCOPE,
    );

    const events = await collect(taskAgent(duplicating), ctx);

    expect(JSON.stringify(events)).not.toContain('LATE_CHATTER');
  });

  it('reports a failed remote task and releases control', async () => {
    const failing = harnessYielding({
      kind: 'task',
      id: 'task-9',
      contextId: 'c-1',
      status: {
        state: 'failed',
        message: {
          kind: 'message',
          messageId: 'm-1',
          role: 'agent',
          parts: [{kind: 'text', text: 'the kitchen is closed'}],
        },
      },
    });
    const ctx = createContext([triggerCall()], TASK_SCOPE);

    const events = await collect(taskAgent(failing), ctx);

    const errorEvent = events.find((event) =>
      event.errorMessage?.startsWith('Remote A2A task failed'),
    );
    expect(errorEvent?.errorMessage).toContain('the kitchen is closed');
    expect(errorEvent?.customMetadata?.['a2a:task_id']).toBe('task-9');
    expect(errorEvent?.customMetadata?.['a2a:error']).toBeDefined();
    expect(errorEvent?.customMetadata?.['a2a:request']).toBeDefined();
    expect(
      events.some(
        (event) => finishTaskResult(event) === FINISH_TASK_ERROR_RESULT,
      ),
    ).toBe(true);
    expect(events.at(-1)?.actions.endOfAgent).toBe(true);
  });

  it('reports a cancelled remote task', async () => {
    const cancelled = harnessYielding({
      kind: 'task',
      id: 'task-9',
      contextId: 'c-1',
      status: {
        state: 'canceled',
        message: {
          kind: 'message',
          messageId: 'm-1',
          role: 'agent',
          parts: [{kind: 'text', text: 'ignored'}],
        },
      },
    });
    const ctx = createContext([triggerCall()], TASK_SCOPE);

    const events = await collect(taskAgent(cancelled), ctx);

    expect(
      events.find((event) =>
        event.errorMessage?.startsWith('Remote A2A task failed'),
      )?.errorMessage,
    ).toBe('Remote A2A task failed: Task canceled');
  });

  it('releases control when the remote agent cannot be reached', async () => {
    const broken = harnessYielding();
    vi.mocked(broken.client.sendMessageStream).mockImplementation(() => {
      throw new Error('connection reset');
    });
    const ctx = createContext([triggerCall()], TASK_SCOPE);

    const events = await collect(taskAgent(broken), ctx);

    expect(events[0].errorMessage).toBe('A2A request failed: connection reset');
    expect(
      events.some(
        (event) => finishTaskResult(event) === FINISH_TASK_ERROR_RESULT,
      ),
    ).toBe(true);
    expect(events.at(-1)?.actions.endOfAgent).toBe(true);
  });

  it('releases control when there is nothing to send', async () => {
    const ctx = createContext([triggerCall()], TASK_SCOPE);

    const events = await collect(
      taskAgent(harness, {genaiPartConverter: () => undefined}),
      ctx,
    );

    expect(events[0].content).toEqual({});
    expect(
      events.some(
        (event) => finishTaskResult(event) === FINISH_TASK_ERROR_RESULT,
      ),
    ).toBe(true);
    expect(events.at(-1)?.actions.endOfAgent).toBe(true);
  });

  it('sends only the events inside the task scope', async () => {
    const ctx = createContext(
      [
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'OUT_OF_SCOPE'}]},
        }),
        createEvent({
          author: 'coordinator',
          isolationScope: 'another-task',
          content: {role: 'model', parts: [{text: 'OTHER_TASK'}]},
        }),
        triggerCall(),
        createEvent({
          author: 'user',
          isolationScope: TASK_SCOPE,
          content: {role: 'user', parts: [{text: 'IN_SCOPE'}]},
        }),
      ],
      TASK_SCOPE,
    );

    await collect(taskAgent(harness), ctx);

    const dumped = JSON.stringify(harness.sent[0]);
    expect(dumped).toContain('IN_SCOPE');
    expect(dumped).toContain('book a table');
    expect(dumped).not.toContain('OUT_OF_SCOPE');
    expect(dumped).not.toContain('OTHER_TASK');
  });

  it('drops a call aimed at a tool outside this task', async () => {
    const ctx = createContext(
      [
        triggerCall(),
        createEvent({
          author: 'user',
          isolationScope: TASK_SCOPE,
          content: {
            role: 'user',
            parts: [
              {
                functionCall: {
                  id: 'sibling-call',
                  name: 'other_tool',
                  args: {value: 'SIBLING_ARGS'},
                },
              },
              {text: 'KEEP_THIS'},
            ],
          },
        }),
      ],
      TASK_SCOPE,
    );

    await collect(taskAgent(harness), ctx);

    const dumped = JSON.stringify(harness.sent[0]);
    expect(dumped).toContain('KEEP_THIS');
    expect(dumped).not.toContain('SIBLING_ARGS');
  });

  it('renders a foreign function response as text', async () => {
    const ctx = createContext(
      [
        triggerCall(),
        createEvent({
          author: 'user',
          isolationScope: TASK_SCOPE,
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'someone-elses-call',
                  name: 'lookup',
                  response: {seats: 4},
                },
              },
            ],
          },
        }),
      ],
      TASK_SCOPE,
    );

    await collect(taskAgent(harness), ctx);

    const dumped = JSON.stringify(harness.sent[0]);
    expect(dumped).toContain('Tool lookup returned:');
    expect(dumped).not.toContain('functionResponse');
  });

  it("keeps a function response answering the peer's own call", async () => {
    const ctx = createContext(
      [
        triggerCall(),
        createEvent({
          author: AGENT_NAME,
          isolationScope: TASK_SCOPE,
          content: {
            role: 'model',
            parts: [
              {functionCall: {id: 'peer-ask', name: 'ask_user', args: {}}},
            ],
          },
        }),
        createEvent({
          author: 'user',
          isolationScope: TASK_SCOPE,
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'peer-ask',
                  name: 'ask_user',
                  response: {answer: 'PEER_ANSWER'},
                },
              },
            ],
          },
        }),
      ],
      TASK_SCOPE,
    );

    await collect(taskAgent(harness), ctx);

    const dumped = JSON.stringify(harness.sent[0]);
    expect(dumped).toContain('PEER_ANSWER');
    expect(dumped).not.toContain('Tool ask_user returned:');
  });

  it('rejects an isolation scope no function call opened', async () => {
    const ctx = createContext(
      [
        createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'hi'}]},
        }),
      ],
      'workflow.path.0',
    );

    const events = await collect(taskAgent(harness), ctx);

    expect(events[0].errorMessage).toContain(
      'could not find the triggering function call',
    );
    expect(events.at(-1)?.actions.endOfAgent).toBe(true);
  });

  it("stops at the peer's own previous reply when it is stateful", async () => {
    const ctx = createContext(
      [
        triggerCall(),
        createEvent({
          author: 'user',
          isolationScope: TASK_SCOPE,
          content: {role: 'user', parts: [{text: 'ALREADY_SEEN'}]},
        }),
        createEvent({
          author: AGENT_NAME,
          isolationScope: TASK_SCOPE,
          customMetadata: {'a2a:context_id': 'ctx-7'},
        }),
        createEvent({
          author: 'user',
          isolationScope: TASK_SCOPE,
          content: {role: 'user', parts: [{text: 'BRAND_NEW'}]},
        }),
      ],
      TASK_SCOPE,
    );

    await collect(taskAgent(harness), ctx);

    const dumped = JSON.stringify(harness.sent[0]);
    expect(dumped).toContain('BRAND_NEW');
    expect(dumped).not.toContain('ALREADY_SEEN');
  });

  it('keeps going while the remote task is still working', async () => {
    const working = harnessYielding(
      {
        kind: 'task',
        id: 'task-9',
        contextId: 'c-1',
        status: {
          state: 'working',
          message: {
            kind: 'message',
            messageId: 'm-1',
            role: 'agent',
            parts: [{kind: 'text', text: 'STILL_WORKING'}],
          },
        },
      },
      finishTaskMessage(FINISH_TASK_SUCCESS_RESULT),
    );
    const ctx = createContext(
      [triggerCall(), finishTaskCall({table: 'window'})],
      TASK_SCOPE,
    );

    const events = await collect(taskAgent(working), ctx);

    expect(JSON.stringify(events)).toContain('STILL_WORKING');
    expect(events.find((event) => event.output !== undefined)?.output).toEqual({
      table: 'window',
    });
  });

  it('falls back to a stand-in when a failed task says nothing', async () => {
    const silent = harnessYielding({
      kind: 'task',
      id: 'task-9',
      contextId: 'c-1',
      status: {state: 'failed'},
      artifacts: [
        {artifactId: 'a-1', parts: [{kind: 'text', text: 'ignored'}]},
      ],
    });
    const ctx = createContext([triggerCall()], TASK_SCOPE);

    const events = await collect(taskAgent(silent), ctx);

    expect(
      events.find((event) =>
        event.errorMessage?.startsWith('Remote A2A task failed'),
      )?.errorMessage,
    ).toBe('Remote A2A task failed: Unknown error');
  });

  it("ignores the peer's own calls made under another task scope", async () => {
    const ctx = createContext(
      [
        triggerCall(),
        createEvent({
          author: AGENT_NAME,
          isolationScope: 'another-task',
          content: {
            role: 'model',
            parts: [
              {functionCall: {id: 'other-scope-call', name: 'ask', args: {}}},
            ],
          },
        }),
        createEvent({
          author: 'user',
          isolationScope: TASK_SCOPE,
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  id: 'other-scope-call',
                  name: 'ask',
                  response: {answer: 'FOREIGN_SCOPE'},
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'user',
          isolationScope: TASK_SCOPE,
          content: {role: 'user', parts: [{text: 'and then?'}]},
        }),
      ],
      TASK_SCOPE,
    );

    await collect(taskAgent(harness), ctx);

    // The call belongs to another scope, so the answer is relayed as text
    // rather than as a response the peer is expected to resume.
    expect(JSON.stringify(harness.sent[0])).toContain('Tool ask returned:');
  });

  it('leaves a plain transfer target alone', async () => {
    const ctx = createContext([
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      }),
    ]);

    const events = await collect(
      new RemoteA2AAgent({
        name: AGENT_NAME,
        agentCard: CARD,
        clientFactory: harness.clientFactory,
      }),
      ctx,
    );

    expect(events.some((event) => event.actions.endOfAgent)).toBe(false);
  });
});
