/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A double for `@google-cloud/pubsub`, shared by the Pub/Sub tool tests.
 * Install it with:
 *
 * ```ts
 * vi.mock('@google-cloud/pubsub', async () => {
 *   const {fakePubSubModule} = await import('./pubsub_test_utils.js');
 *   return fakePubSubModule;
 * });
 * ```
 *
 * The mock factory and the test share this module, so a test reads what the
 * tools did from {@link pubsubFake}.
 */

import {
  BaseToolset,
  Context,
  createSession,
  InvocationContext,
  LlmAgent,
  PluginManager,
} from '@google/adk';
import {PubSubCredentialsConfig} from '@google/adk/tools/pubsub';
import {expect} from 'vitest';
import {ResolvedPubSubCredentials} from '../../../src/tools/pubsub/pubsub_credentials.js';

/** A message body, in every shape the wire can carry it. */
export type FakeMessageData = Uint8Array | string | null;

/** A protobuf timestamp, as the pull response carries it. */
export interface FakeTimestamp {
  seconds?: number | string;
  nanos?: number;
}

/** One message a pull answers with. */
export interface FakeReceivedMessage {
  ackId?: string | null;
  message?: {
    messageId?: string | null;
    data?: FakeMessageData;
    attributes?: Record<string, string> | null;
    orderingKey?: string | null;
    publishTime?: FakeTimestamp | null;
  } | null;
}

/** One message the tools published. */
export interface RecordedPublish {
  topic: string;
  data?: FakeMessageData;
  attributes?: Record<string, string>;
  orderingKey?: string;
}

/** One pull the tools performed. */
export interface RecordedPull {
  subscription?: string | null;
  maxMessages?: number | null;
}

/** One acknowledgement the tools sent. */
export interface RecordedAcknowledge {
  subscription?: string | null;
  ackIds?: string[] | null;
}

/** Failures a test asks the fake to raise. */
export interface FakeFailures {
  publish?: Error;
  pull?: Error;
  acknowledge?: Error;
  closePublisher?: Error;
  closeSubscriber?: Error;
}

/** What the tools did, and how the fake answers them. */
export class FakePubSubState {
  readonly publisherOptions: Array<Record<string, unknown>> = [];
  readonly subscriberOptions: Array<Record<string, unknown>> = [];
  readonly publishes: RecordedPublish[] = [];
  readonly pulls: RecordedPull[] = [];
  readonly acknowledgements: RecordedAcknowledge[] = [];

  messageIds: string[] | undefined = ['message_id'];
  /** `undefined` reproduces a pull response that omits the field. */
  receivedMessages: FakeReceivedMessage[] | undefined = [];
  failures: FakeFailures = {};
  closedPublishers = 0;
  closedSubscribers = 0;

  reset(): void {
    this.publisherOptions.length = 0;
    this.subscriberOptions.length = 0;
    this.publishes.length = 0;
    this.pulls.length = 0;
    this.acknowledgements.length = 0;
    this.messageIds = ['message_id'];
    this.receivedMessages = [];
    this.failures = {};
    this.closedPublishers = 0;
    this.closedSubscribers = 0;
  }

  /** The last message the tools published. */
  lastPublish(): RecordedPublish {
    const publish = this.publishes.at(-1);
    if (!publish) {
      return expect.fail('no message was published');
    }
    return publish;
  }
}

/** The fake every mocked Pub/Sub client in a test file drives. */
export const pubsubFake = new FakePubSubState();

/** The request `v1.PublisherClient.publish` receives. */
interface FakePublishRequest {
  topic: string;
  messages: Array<{
    data?: FakeMessageData;
    attributes?: Record<string, string>;
    orderingKey?: string;
  }>;
}

class FakePublisherClient {
  constructor(options: Record<string, unknown>) {
    pubsubFake.publisherOptions.push(options);
  }

  async publish(
    request: FakePublishRequest,
  ): Promise<[{messageIds: string[] | undefined}]> {
    for (const message of request.messages) {
      pubsubFake.publishes.push({topic: request.topic, ...message});
    }
    if (pubsubFake.failures.publish) {
      throw pubsubFake.failures.publish;
    }
    return [{messageIds: pubsubFake.messageIds}];
  }

  async close(): Promise<void> {
    pubsubFake.closedPublishers += 1;
    if (pubsubFake.failures.closePublisher) {
      throw pubsubFake.failures.closePublisher;
    }
  }
}

class FakeSubscriberClient {
  constructor(options: Record<string, unknown>) {
    pubsubFake.subscriberOptions.push(options);
  }

  async pull(
    request: RecordedPull,
  ): Promise<[{receivedMessages: FakeReceivedMessage[] | undefined}]> {
    pubsubFake.pulls.push(request);
    if (pubsubFake.failures.pull) {
      throw pubsubFake.failures.pull;
    }
    return [{receivedMessages: pubsubFake.receivedMessages}];
  }

  async acknowledge(request: RecordedAcknowledge): Promise<void> {
    pubsubFake.acknowledgements.push(request);
    if (pubsubFake.failures.acknowledge) {
      throw pubsubFake.failures.acknowledge;
    }
  }

  async close(): Promise<void> {
    pubsubFake.closedSubscribers += 1;
    if (pubsubFake.failures.closeSubscriber) {
      throw pubsubFake.failures.closeSubscriber;
    }
  }
}

/** The module shape `vi.mock('@google-cloud/pubsub', ...)` returns. */
export const fakePubSubModule = {
  v1: {
    PublisherClient: FakePublisherClient,
    SubscriberClient: FakeSubscriberClient,
  },
};

/** Id of the function call every tool context below answers for. */
export const FUNCTION_CALL_ID = 'fc-1';

/** A tool context backed by an empty session. */
export function makeToolContext(): Context {
  const invocationContext = new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'a', model: 'gemini-2.5-flash'}),
    session: createSession({id: 's1', appName: 'app', userId: 'u1'}),
    pluginManager: new PluginManager([]),
  });
  return new Context({invocationContext, functionCallId: FUNCTION_CALL_ID});
}

/** A service-account key, as the SDK reads it. */
export function testServiceAccount(id = 'agent'): {
  client_email: string;
  private_key: string;
} {
  return {
    client_email: `${id}@example.test.iam.gserviceaccount.com`,
    private_key: `private-key-${id}`,
  };
}

/** A service-account credentials config: one identity for every user. */
export function testCredentialsConfig(id = 'agent'): PubSubCredentialsConfig {
  return {credentials: testServiceAccount(id)};
}

/** Credentials as the client layer receives them, distinct per `id`. */
export function testResolvedCredentials(
  id = 'agent',
): ResolvedPubSubCredentials {
  return {
    credentials: testServiceAccount(id),
    scopes: ['https://www.googleapis.com/auth/pubsub'],
  };
}

/**
 * Calls one tool of a toolset by name.
 *
 * @param toolset The toolset to take the tool from.
 * @param name The tool name.
 * @param args The arguments a model would send.
 * @param context The tool context, defaulting to an empty session.
 * @return Whatever the tool answered.
 */
export async function runTool(
  toolset: BaseToolset,
  name: string,
  args: Record<string, unknown> = {},
  context: Context = makeToolContext(),
): Promise<unknown> {
  const tool = (await toolset.getTools()).find((each) => each.name === name);
  if (!tool) {
    return expect.fail(`the toolset exposes no tool named ${name}`);
  }
  return tool.runAsync({args, toolContext: context});
}

/** Narrows an arbitrary value to an indexable record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Reads a tool result that must have succeeded. */
export function resultOf(result: unknown): Record<string, unknown> {
  if (!isRecord(result)) {
    return expect.fail(`expected a tool result, got ${String(result)}`);
  }
  expect(result['status']).not.toBe('ERROR');
  return result;
}

/** Reads the message of a tool result that must have failed. */
export function errorOf(result: unknown): string {
  if (!isRecord(result)) {
    return expect.fail(`expected a tool result, got ${String(result)}`);
  }
  expect(result['status']).toBe('ERROR');
  const details = result['error_details'];
  if (typeof details !== 'string') {
    return expect.fail(`expected error_details, got ${String(details)}`);
  }
  return details;
}
