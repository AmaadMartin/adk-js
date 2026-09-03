/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentCard,
  Message,
  MessageSendParams,
  Task,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {
  Client,
  ClientFactory,
  DefaultAgentCardResolver,
} from '@a2a-js/sdk/client';
import {
  Event as AdkEvent,
  createEvent,
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
  RemoteA2AAgent,
  RemoteA2AAgentConfig,
  Session,
} from '@google/adk';
import {Type} from '@google/genai';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {toA2APart} from '../../src/a2a/part_converter_utils.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';

vi.mock('@a2a-js/sdk/client', () => {
  const DefaultAgentCardResolver = vi.fn().mockImplementation(() => ({
    resolve: vi.fn(),
  }));
  const Client = vi.fn().mockImplementation(() => ({
    sendMessageStream: vi.fn(),
    sendMessage: vi.fn(),
  }));
  const ClientFactory = vi.fn().mockImplementation(() => ({
    createFromAgentCard: vi.fn(),
  }));
  return {Client, ClientFactory, DefaultAgentCardResolver};
});

const CARD: AgentCard = {
  name: 'Remote',
  description: 'remote agent',
  protocolVersion: '1.0',
  defaultInputModes: [],
  defaultOutputModes: [],
  capabilities: {streaming: true},
  skills: [],
  url: 'https://remote.example.com/a2a',
  version: '1.0',
};

const SCOPE = 'trigger-fc-1';

/** The coordinator's call that started the delegated task. */
function triggerEvent(args: Record<string, unknown> = {topic: 'weather'}) {
  return createEvent({
    author: 'coordinator',
    content: {
      role: 'model',
      parts: [{functionCall: {id: SCOPE, name: 'remote_agent', args}}],
    },
  });
}

/** An event the remote task produced, inside the task's isolation scope. */
function scopedEvent(overrides: Partial<AdkEvent>): AdkEvent {
  return {
    ...createEvent({author: 'user'}),
    isolationScope: SCOPE,
    ...overrides,
  };
}

describe('RemoteA2AAgent task mode', () => {
  let mockClient: Client;
  let mockClientFactory: ClientFactory;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClient = {
      sendMessageStream: vi.fn().mockReturnValue((async function* () {})()),
      sendMessage: vi.fn(),
    } as unknown as Client;
    mockClientFactory = {
      createFromAgentCard: vi.fn().mockResolvedValue(mockClient),
    } as unknown as ClientFactory;
    vi.mocked(ClientFactory).mockImplementation(() => mockClientFactory);
    vi.mocked(DefaultAgentCardResolver).mockImplementation(
      () =>
        ({
          resolve: vi.fn().mockResolvedValue(CARD),
        }) as unknown as DefaultAgentCardResolver,
    );
  });

  const buildAgent = (overrides: Partial<RemoteA2AAgentConfig> = {}) =>
    new RemoteA2AAgent({
      name: 'remote_agent',
      agentCard: CARD,
      mode: 'task',
      client: mockClient,
      clientFactory: mockClientFactory,
      ...overrides,
    });

  const contextFor = (
    events: AdkEvent[],
    isolationScope: string | undefined = SCOPE,
  ): InvocationContext =>
    new InvocationContext({
      invocationId: 'inv-1',
      isolationScope,
      session: {
        id: 'session-1',
        appName: 'app',
        userId: 'user',
        state: {},
        events,
        lastUpdateTime: Date.now(),
      } as Session,
      pluginManager: new PluginManager(),
    });

  const run = async (
    agent: RemoteA2AAgent,
    context: InvocationContext,
  ): Promise<AdkEvent[]> => {
    const events: AdkEvent[] = [];
    for await (const event of agent.runAsync(context)) {
      events.push(event);
    }
    return events;
  };

  /** The parts the agent actually sent to the peer. */
  const sentParts = () => {
    const params = vi.mocked(mockClient.sendMessageStream).mock
      .calls[0]?.[0] as MessageSendParams | undefined;
    return params?.message.parts ?? [];
  };

  describe('history construction', () => {
    it('sends only the current task scope plus its trigger call', async () => {
      const otherTask = {
        ...createEvent({
          author: 'user',
          content: {role: 'user', parts: [{text: 'other task'}]},
        }),
        isolationScope: 'another-scope',
      };
      const inScope = scopedEvent({
        content: {role: 'user', parts: [{text: 'in scope'}]},
      });

      // The other task sits between the trigger and this task's own events, so
      // the backward walk has to step over it rather than stop at it.
      await run(buildAgent(), contextFor([triggerEvent(), otherTask, inScope]));

      const texts = sentParts().map((part) =>
        part.kind === 'text' ? part.text : undefined,
      );
      expect(texts).toContain('in scope');
      expect(texts.join(' ')).toContain('weather');
      expect(texts.join(' ')).not.toContain('other task');
    });

    it('skips a call meant for another tool', async () => {
      // A user-authored event is forwarded as-is, so its function calls reach
      // the scope filter rather than being flattened into context text first.
      const sibling = scopedEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionCall: {id: 'other-fc', name: 'other_tool', args: {b: 2}}},
            {text: 'and some text'},
          ],
        },
      });

      await run(buildAgent(), contextFor([triggerEvent(), sibling]));

      const dumped = JSON.stringify(sentParts());
      expect(dumped).toContain('and some text');
      expect(dumped).not.toContain('other_tool');
    });

    it('flattens a function response the peer never asked for', async () => {
      const foreign = scopedEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {
              functionResponse: {
                id: 'foreign-fc',
                name: 'lookup',
                response: {city: 'Paris'},
              },
            },
          ],
        },
      });

      await run(buildAgent(), contextFor([triggerEvent(), foreign]));

      const texts = sentParts().map((part) =>
        part.kind === 'text' ? part.text : '',
      );
      expect(texts).toContain('Tool lookup returned: {"city":"Paris"}');
    });

    it("keeps a function response answering the peer's own call", async () => {
      const peerCall = scopedEvent({
        author: 'remote_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id: 'peer-fc', name: 'ask', args: {}}}],
        },
      });
      const answer = scopedEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {id: 'peer-fc', name: 'ask', response: {a: 1}}},
          ],
        },
      });

      await run(buildAgent(), contextFor([triggerEvent(), peerCall, answer]));

      const dataParts = sentParts().filter((part) => part.kind === 'data');
      expect(JSON.stringify(dataParts)).toContain('peer-fc');
    });

    it("ignores the peer's calls from another task", async () => {
      const otherScopeCall = {
        ...createEvent({
          author: 'remote_agent',
          content: {
            role: 'model',
            parts: [{functionCall: {id: 'old-fc', name: 'ask', args: {}}}],
          },
        }),
        isolationScope: 'another-scope',
      };
      const answer = scopedEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [
            {functionResponse: {id: 'old-fc', name: 'ask', response: {a: 1}}},
          ],
        },
      });

      // A trailing turn keeps the answer off the end of the session, where the
      // resume short-circuit would forward it on its own.
      const trailing = scopedEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'carry on'}]},
      });

      await run(
        buildAgent(),
        contextFor([triggerEvent(), otherScopeCall, answer, trailing]),
      );

      // The call belongs to another task, so its answer is flattened to text
      // rather than forwarded as a resume the peer cannot match.
      const texts = sentParts().map((part) =>
        part.kind === 'text' ? part.text : '',
      );
      expect(texts).toContain('Tool ask returned: {"a":1}');
    });

    it('flattens a function response that carries no call id', async () => {
      const idless = scopedEvent({
        author: 'user',
        content: {
          role: 'user',
          parts: [{functionResponse: {name: 'lookup', response: {a: 1}}}],
        },
      });

      await run(buildAgent(), contextFor([triggerEvent(), idless]));

      const texts = sentParts().map((part) =>
        part.kind === 'text' ? part.text : '',
      );
      expect(texts).toContain('Tool lookup returned: {"a":1}');
    });

    it('marks user-authored parts as user input', async () => {
      const userTurn = scopedEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      });

      await run(buildAgent(), contextFor([triggerEvent(), userTurn]));

      const hello = sentParts().find(
        (part) => part.kind === 'text' && part.text === 'hello',
      );
      expect(hello?.metadata).toEqual({is_user_input: true});
    });

    it('reports a task scope whose trigger call is not in history', async () => {
      const orphan = scopedEvent({
        content: {role: 'user', parts: [{text: 'orphan'}]},
      });

      const events = await run(buildAgent(), contextFor([orphan]));

      expect(events[0].errorMessage).toContain(
        "could not find the triggering FunctionCall for isolation scope 'trigger-fc-1'",
      );
    });
  });

  describe('completion', () => {
    const finishCall = (args: Record<string, unknown>, id = 'finish-1') =>
      scopedEvent({
        author: 'remote_agent',
        content: {
          role: 'model',
          parts: [{functionCall: {id, name: FINISH_TASK_TOOL_NAME, args}}],
        },
      });

    const finishResponse = (id = 'finish-1'): Message => ({
      kind: 'message',
      messageId: 'm-1',
      role: 'agent',
      parts: [
        toA2APart({
          functionResponse: {
            id,
            name: FINISH_TASK_TOOL_NAME,
            response: {result: FINISH_TASK_SUCCESS_RESULT},
          },
        }),
      ],
    });

    it('promotes the finish_task arguments to the node output', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield finishResponse();
        })(),
      );
      const context = contextFor([
        triggerEvent(),
        finishCall({summary: 'sunny'}),
      ]);

      const events = await run(buildAgent(), context);

      const output = events.find((event) => event.output !== undefined);
      expect(output?.output).toEqual({summary: 'sunny'});
    });

    it('unwraps a primitive output schema', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield finishResponse();
        })(),
      );
      const context = contextFor([
        triggerEvent(),
        finishCall({result: 'sunny'}),
      ]);

      const events = await run(
        buildAgent({outputSchema: {type: Type.STRING}}),
        context,
      );

      const output = events.find((event) => event.output !== undefined);
      expect(output?.output).toBe('sunny');
    });

    it('picks the finish_task call whose id the response names', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield finishResponse('finish-2');
        })(),
      );
      const context = contextFor([
        triggerEvent(),
        finishCall({summary: 'stale'}, 'finish-1'),
        finishCall({summary: 'fresh'}, 'finish-2'),
      ]);

      const events = await run(buildAgent(), context);

      const output = events.find((event) => event.output !== undefined);
      expect(output?.output).toEqual({summary: 'fresh'});
    });

    it('leaves the output unset when no finish_task call is in history', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield finishResponse();
        })(),
      );

      const events = await run(buildAgent(), contextFor([triggerEvent()]));

      expect(events.every((event) => event.output === undefined)).toBe(true);
    });

    it('hands control back after a completed task', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield finishResponse();
        })(),
      );
      const context = contextFor([triggerEvent(), finishCall({a: 1})]);

      const events = await run(buildAgent(), context);

      const last = events[events.length - 1];
      expect(last.actions.endOfAgent).toBe(true);
      // A completed task is not a failure, so no error finish event is added.
      expect(events.some((event) => event.errorMessage)).toBe(false);
    });

    it('stops reading the stream after the task finishes', async () => {
      const after = vi.fn();
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield finishResponse();
          after();
          yield finishResponse();
        })(),
      );
      const context = contextFor([triggerEvent(), finishCall({a: 1})]);

      await run(buildAgent(), context);

      expect(after).not.toHaveBeenCalled();
    });
  });

  describe('failure', () => {
    const failedTask = (state: 'failed' | 'canceled'): Task => ({
      kind: 'task',
      id: 'task-1',
      contextId: 'ctx-1',
      status: {
        state,
        message: {
          kind: 'message',
          messageId: 'err-1',
          role: 'agent',
          parts: [{kind: 'text', text: 'disk on fire'}],
        },
      },
    });

    it('reports a failed remote task and releases control', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield failedTask('failed');
        })(),
      );

      const events = await run(buildAgent(), contextFor([triggerEvent()]));

      const error = events.find((event) =>
        event.errorMessage?.startsWith('Remote A2A task failed'),
      );
      expect(error?.errorMessage).toContain('disk on fire');
      expect(error?.customMetadata?.['a2a:task_id']).toBe('task-1');
      expect(events[events.length - 1].actions.endOfAgent).toBe(true);
      expect(
        events.some((event) =>
          event.content?.parts?.some(
            (part) =>
              part.functionResponse?.response?.['result'] ===
              FINISH_TASK_ERROR_RESULT,
          ),
        ),
      ).toBe(true);
    });

    /** The terminal frame a running task actually reports its end with. */
    const statusUpdate = (
      state: 'failed' | 'canceled',
      message?: string,
    ): TaskStatusUpdateEvent => ({
      kind: 'status-update',
      taskId: 'task-1',
      contextId: 'ctx-1',
      final: true,
      status: {
        state,
        ...(message
          ? {
              message: {
                kind: 'message',
                messageId: 'err-1',
                role: 'agent',
                parts: [{kind: 'text', text: message}],
              },
            }
          : {}),
      },
    });

    it('reports a task that failed after it started', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield statusUpdate('failed', 'disk on fire');
        })(),
      );

      const events = await run(buildAgent(), contextFor([triggerEvent()]));

      const error = events.find((event) =>
        event.errorMessage?.startsWith('Remote A2A task failed'),
      );
      expect(error?.errorMessage).toContain('disk on fire');
      expect(error?.customMetadata?.['a2a:task_id']).toBe('task-1');
      expect(events[events.length - 1].actions.endOfAgent).toBe(true);
    });

    it('reports a cancellation that carries no message', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield statusUpdate('canceled');
        })(),
      );

      const events = await run(buildAgent(), contextFor([triggerEvent()]));

      expect(
        events.find((event) => event.errorMessage)?.errorMessage,
      ).toContain('Task canceled');
      expect(events[events.length - 1].actions.endOfAgent).toBe(true);
    });

    it('reports a failure with no reason as an unknown error', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield statusUpdate('failed');
        })(),
      );

      const events = await run(buildAgent(), contextFor([triggerEvent()]));

      expect(
        events.find((event) => event.errorMessage)?.errorMessage,
      ).toContain('Unknown error');
    });

    it('keeps going on a non-terminal status update', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield {
            kind: 'status-update',
            taskId: 'task-1',
            contextId: 'ctx-1',
            final: false,
            status: {state: 'working'},
          } as TaskStatusUpdateEvent;
        })(),
      );

      const events = await run(buildAgent(), contextFor([triggerEvent()]));

      expect(events.some((event) => event.errorMessage)).toBe(false);
      expect(events[events.length - 1]?.actions.endOfAgent).toBeUndefined();
    });

    it('reports a canceled remote task', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield failedTask('canceled');
        })(),
      );

      const events = await run(buildAgent(), contextFor([triggerEvent()]));

      expect(
        events.find((event) => event.errorMessage)?.errorMessage,
      ).toContain('Task canceled');
    });

    it('keeps going while the remote task is still working', async () => {
      vi.mocked(mockClient.sendMessageStream).mockReturnValue(
        (async function* () {
          yield {
            kind: 'task',
            id: 'task-1',
            contextId: 'ctx-1',
            status: {state: 'working'},
            artifacts: [
              {artifactId: 'a-1', parts: [{kind: 'text', text: 'thinking'}]},
            ],
          } as Task;
        })(),
      );

      const events = await run(buildAgent(), contextFor([triggerEvent()]));

      expect(events.some((event) => event.errorMessage)).toBe(false);
      expect(events[events.length - 1].actions.endOfAgent).toBeUndefined();
    });

    it('releases control when the send fails', async () => {
      vi.mocked(mockClient.sendMessageStream).mockImplementation(() => {
        throw new Error('connection reset');
      });

      const events = await run(buildAgent(), contextFor([triggerEvent()]));

      expect(events[0].errorMessage).toContain('A2A request failed');
      expect(events[events.length - 1].actions.endOfAgent).toBe(true);
    });

    it('releases control when there is nothing to send', async () => {
      const agent = buildAgent({genaiPartConverter: () => undefined});

      const events = await run(agent, contextFor([triggerEvent()]));

      expect(events[events.length - 1].actions.endOfAgent).toBe(true);
      expect(mockClient.sendMessageStream).not.toHaveBeenCalled();
    });

    it('keeps control while it waits for a credential', async () => {
      const agent = buildAgent({
        authScheme: {type: 'apiKey', name: 'X-Api-Key', in: 'header'},
      });

      const events = await run(agent, contextFor([triggerEvent()]));

      expect(events).toHaveLength(1);
      expect(events[0].actions.endOfAgent).toBeUndefined();
    });
  });

  describe('outside task mode', () => {
    it('does not emit an end-of-agent event', async () => {
      const agent = new RemoteA2AAgent({
        name: 'remote_agent',
        agentCard: CARD,
        client: mockClient,
      });

      const events = await run(
        agent,
        contextFor(
          [
            createEvent({
              author: 'user',
              content: {role: 'user', parts: [{text: 'hi'}]},
            }),
          ],
          undefined,
        ),
      );

      expect(events).toEqual([]);
    });
  });
});
