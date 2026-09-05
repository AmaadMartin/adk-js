/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A real `@a2a-js/sdk` {@link Client} driven by a transport that records what
 * it was asked to send. The client is genuine, so a test that asserts on the
 * recorded {@link RequestOptions} proves the options survived the SDK, not just
 * the agent.
 */

import {
  AgentCard,
  DeleteTaskPushNotificationConfigParams,
  GetTaskPushNotificationConfigParams,
  ListTaskPushNotificationConfigParams,
  Message,
  MessageSendParams,
  Task,
  TaskIdParams,
  TaskPushNotificationConfig,
  TaskQueryParams,
} from '@a2a-js/sdk';
import {
  Client,
  ClientFactory,
  RequestOptions,
  Transport,
} from '@a2a-js/sdk/client';
import {A2AStreamEventData} from '@google/adk';

/** Thrown by the transport methods this fake does not implement. */
const UNSUPPORTED = 'RecordingTransport does not implement this method';

/** Builds an agent card that passes the SDK's normalization. */
export function createTestAgentCard(
  overrides: Partial<AgentCard> = {},
): AgentCard {
  return {
    name: 'remote-agent',
    description: 'a remote agent',
    protocolVersion: '0.3.0',
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    capabilities: {streaming: true},
    skills: [],
    url: 'https://example.com',
    version: '1.0',
    ...overrides,
  };
}

/** A {@link Transport} that replays canned frames and records every send. */
export class RecordingTransport implements Transport {
  readonly sentParams: MessageSendParams[] = [];
  readonly sentOptions: Array<RequestOptions | undefined> = [];

  constructor(
    private readonly frames: A2AStreamEventData[] = [],
    private readonly result: Message | Task = {
      kind: 'message',
      messageId: 'fake-response',
      role: 'agent',
      parts: [],
    },
  ) {}

  async *sendMessageStream(
    params: MessageSendParams,
    options?: RequestOptions,
  ): AsyncGenerator<A2AStreamEventData, void, undefined> {
    this.sentParams.push(params);
    this.sentOptions.push(options);
    for (const frame of this.frames) {
      yield frame;
    }
  }

  async sendMessage(
    params: MessageSendParams,
    options?: RequestOptions,
  ): Promise<Message | Task> {
    this.sentParams.push(params);
    this.sentOptions.push(options);
    return this.result;
  }

  getExtendedAgentCard(): Promise<AgentCard> {
    return Promise.reject(new Error(UNSUPPORTED));
  }

  setTaskPushNotificationConfig(
    _params: TaskPushNotificationConfig,
  ): Promise<TaskPushNotificationConfig> {
    return Promise.reject(new Error(UNSUPPORTED));
  }

  getTaskPushNotificationConfig(
    _params: GetTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig> {
    return Promise.reject(new Error(UNSUPPORTED));
  }

  listTaskPushNotificationConfig(
    _params: ListTaskPushNotificationConfigParams,
  ): Promise<TaskPushNotificationConfig[]> {
    return Promise.reject(new Error(UNSUPPORTED));
  }

  deleteTaskPushNotificationConfig(
    _params: DeleteTaskPushNotificationConfigParams,
  ): Promise<void> {
    return Promise.reject(new Error(UNSUPPORTED));
  }

  getTask(_params: TaskQueryParams): Promise<Task> {
    return Promise.reject(new Error(UNSUPPORTED));
  }

  cancelTask(_params: TaskIdParams): Promise<Task> {
    return Promise.reject(new Error(UNSUPPORTED));
  }

  resubscribeTask(
    _params: TaskIdParams,
  ): AsyncGenerator<A2AStreamEventData, void, undefined> {
    throw new Error(UNSUPPORTED);
  }
}

/** A real client wired to a {@link RecordingTransport}. */
export function createRecordingClient(
  transport: RecordingTransport,
  card: AgentCard = createTestAgentCard(),
): Client {
  return new Client(transport, card);
}

/** A factory that hands out a fixed client instead of dialling the remote. */
export class StubClientFactory extends ClientFactory {
  /** The card each `createFromAgentCard` call was given, in order. */
  readonly createdFor: AgentCard[] = [];

  constructor(private readonly client: Client) {
    super();
  }

  override async createFromAgentCard(agentCard: AgentCard): Promise<Client> {
    this.createdFor.push(agentCard);
    return this.client;
  }
}
