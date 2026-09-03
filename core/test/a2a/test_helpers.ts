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
  TaskArtifactUpdateEvent,
  TaskPushNotificationConfig,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {Client, RequestOptions, Transport} from '@a2a-js/sdk/client';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {createEvent, Event} from '../../src/events/event.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession, Session} from '../../src/sessions/session.js';

/** A single chunk an A2A peer can answer with. */
export type A2AChunk =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

/** One recorded call to the fake transport. */
export interface RecordedSend {
  params: MessageSendParams;
  options?: RequestOptions;
}

/** The A2A card of a peer served over `https://peer.example.com`. */
export function peerAgentCard(overrides: Partial<AgentCard> = {}): AgentCard {
  return {
    name: 'peer',
    description: 'a peer',
    protocolVersion: '0.3.0',
    version: '1.0.0',
    url: 'https://peer.example.com/a2a',
    capabilities: {streaming: true},
    defaultInputModes: ['text'],
    defaultOutputModes: ['text'],
    skills: [],
    ...overrides,
  };
}

/**
 * A {@link Transport} that answers `sendMessage`/`sendMessageStream` from a
 * fixed script and records what it was called with.
 *
 * Only the two message methods are meaningful; the rest satisfy the interface
 * and reject, so a test that reaches one fails loudly instead of silently
 * passing.
 */
export class FakeTransport implements Transport {
  readonly sends: RecordedSend[] = [];

  constructor(
    private readonly chunks: A2AChunk[] = [],
    private readonly failure?: Error,
    /** When set, the stream answers nothing and ends only on abort. */
    private readonly hang = false,
  ) {}

  /** A peer that never answers, so only a timeout or a close ends the call. */
  static hanging(): FakeTransport {
    return new FakeTransport([], undefined, true);
  }

  private unsupported(method: string): never {
    throw new Error(`FakeTransport does not implement ${method}`);
  }

  async sendMessage(
    params: MessageSendParams,
    options?: RequestOptions,
  ): Promise<Message | Task> {
    this.sends.push({params, options});
    if (this.failure) {
      throw this.failure;
    }
    const [first] = this.chunks;
    if (!first || (first.kind !== 'message' && first.kind !== 'task')) {
      throw new Error('FakeTransport has no non-streaming response scripted');
    }
    return first;
  }

  async *sendMessageStream(
    params: MessageSendParams,
    options?: RequestOptions,
  ): AsyncGenerator<A2AChunk, void, undefined> {
    this.sends.push({params, options});
    if (this.failure) {
      throw this.failure;
    }
    if (this.hang) {
      yield* await chunksOnAbort(options?.signal);
      return;
    }
    for (const chunk of this.chunks) {
      options?.signal?.throwIfAborted();
      yield chunk;
    }
  }

  async getExtendedAgentCard(): Promise<AgentCard> {
    return this.unsupported('getExtendedAgentCard');
  }
  async setTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    return this.unsupported('setTaskPushNotificationConfig');
  }
  async getTaskPushNotificationConfig(): Promise<TaskPushNotificationConfig> {
    return this.unsupported('getTaskPushNotificationConfig');
  }
  async listTaskPushNotificationConfig(): Promise<
    TaskPushNotificationConfig[]
  > {
    return this.unsupported('listTaskPushNotificationConfig');
  }
  async deleteTaskPushNotificationConfig(): Promise<void> {
    return this.unsupported('deleteTaskPushNotificationConfig');
  }
  async getTask(): Promise<Task> {
    return this.unsupported('getTask');
  }
  async cancelTask(): Promise<Task> {
    return this.unsupported('cancelTask');
  }
  resubscribeTask(): AsyncGenerator<A2AChunk, void, undefined> {
    return this.unsupported('resubscribeTask');
  }
}

/** Settles only when the call is aborted, and then throws. */
async function chunksOnAbort(signal?: AbortSignal): Promise<A2AChunk[]> {
  await new Promise<void>((resolve) => {
    signal?.addEventListener('abort', () => resolve());
  });
  signal?.throwIfAborted();
  return [];
}

/** A real A2A {@link Client} wired to a {@link FakeTransport}. */
export function fakeClient(
  transport: FakeTransport,
  card: AgentCard = peerAgentCard(),
): Client {
  return new Client(transport, card);
}

/** Records every card fetch and answers each with `card`. */
export function recordingCardFetch(card: AgentCard = peerAgentCard()): {
  fetchImpl: typeof fetch;
  headers: Array<Record<string, string>>;
} {
  const headers: Array<Record<string, string>> = [];
  const fetchImpl: typeof fetch = async (_input, init) => {
    const sent: Record<string, string> = {};
    // `Headers` is only iterable under `DOM.Iterable`, which the root tsconfig
    // does not include; `forEach` is in plain `DOM`.
    new Headers(init?.headers).forEach((value, key) => {
      sent[key] = value;
    });
    headers.push(sent);
    return new Response(JSON.stringify(card), {
      status: 200,
      headers: {'content-type': 'application/json'},
    });
  };
  return {fetchImpl, headers};
}

/** An invocation context over a real session holding `events`. */
export function invocationContext(options: {
  agent: InvocationContext['agent'];
  events?: Event[];
  state?: Record<string, unknown>;
  isolationScope?: string;
}): InvocationContext {
  const session: Session = createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    state: options.state ?? {},
    events: options.events ?? [
      createEvent({
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      }),
    ],
  });
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: options.agent,
    session,
    pluginManager: new PluginManager([]),
    isolationScope: options.isolationScope,
  });
}
