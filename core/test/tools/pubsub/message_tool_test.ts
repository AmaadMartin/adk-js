/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ports adk-python `tests/unittests/tools/pubsub/test_pubsub_message_tool.py`.
 * The `it` titles of the ported cases keep the Python test names so the two
 * suites stay greppable.
 */

import {PubSubToolConfig, PubSubToolset} from '@google/adk/tools/pubsub';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {cleanupClients} from '../../../src/tools/pubsub/client.js';
import {logger} from '../../../src/utils/logger.js';
import {version} from '../../../src/version.js';
import {
  errorOf,
  FakeReceivedMessage,
  pubsubFake,
  resultOf,
  runTool,
  testCredentialsConfig,
} from './pubsub_test_utils.js';

vi.mock('@google-cloud/pubsub', async () => {
  const {fakePubSubModule} = await import('./pubsub_test_utils.js');
  return fakePubSubModule;
});

const TOPIC = 'projects/my_project_id/topics/my_topic';
const SUBSCRIPTION = 'projects/my_project_id/subscriptions/my_sub';

/** A toolset that authenticates as one identity for every end user. */
function makeToolset(
  pubsubToolConfig: PubSubToolConfig = {projectId: 'my_project_id'},
): PubSubToolset {
  return new PubSubToolset({
    credentialsConfig: testCredentialsConfig(),
    pubsubToolConfig,
  });
}

/** One message the fake subscription hands back. */
function fakeMessage(
  overrides: Partial<FakeReceivedMessage['message']> = {},
  ackId = 'ack_123',
): FakeReceivedMessage {
  return {
    ackId,
    message: {
      messageId: '123',
      data: new TextEncoder().encode('Hello'),
      attributes: {key: 'value'},
      orderingKey: 'ABC',
      publishTime: {seconds: 1672531200, nanos: 0},
      ...overrides,
    },
  };
}

/** The failures the tools logged, kept out of the test runner's output. */
let loggedErrors: string[];

beforeEach(() => {
  pubsubFake.reset();
  loggedErrors = [];
  vi.spyOn(logger, 'error').mockImplementation((...args: unknown[]) => {
    loggedErrors.push(args.join(' '));
  });
});

afterEach(async () => {
  await cleanupClients();
  vi.restoreAllMocks();
});

describe('publish_message', () => {
  it('test_publish_message', async () => {
    const result = await runTool(makeToolset(), 'publish_message', {
      topic_name: TOPIC,
      message: 'Hello World',
    });

    expect(resultOf(result)).toEqual({message_id: 'message_id'});
    expect(pubsubFake.lastTopic()).toEqual({
      name: TOPIC,
      batching: {maxMessages: 1},
      messageOrdering: false,
    });
    expect(pubsubFake.lastPublish().data).toEqual(
      Buffer.from('Hello World', 'utf-8'),
    );
  });

  it('test_publish_message_with_ordering_key', async () => {
    const result = await runTool(makeToolset(), 'publish_message', {
      topic_name: TOPIC,
      message: 'Hello World',
      ordering_key: 'key1',
    });

    expect(resultOf(result)).toEqual({message_id: 'message_id'});
    expect(pubsubFake.lastTopic().messageOrdering).toBe(true);
    expect(pubsubFake.lastPublish().orderingKey).toBe('key1');
  });

  it('test_publish_message_with_attributes', async () => {
    await runTool(makeToolset(), 'publish_message', {
      topic_name: TOPIC,
      message: 'Hello World',
      attributes: {key1: 'value1', key2: 'value2'},
    });

    expect(pubsubFake.lastPublish().attributes).toEqual({
      key1: 'value1',
      key2: 'value2',
    });
  });

  it('test_publish_message_exception', async () => {
    pubsubFake.failures.publish = new Error('Publish failed');

    const result = await runTool(makeToolset(), 'publish_message', {
      topic_name: TOPIC,
      message: 'Hello World',
    });

    expect(errorOf(result)).toBe(
      `Failed to publish message to topic '${TOPIC}': Publish failed`,
    );
    expect(loggedErrors).toEqual([
      `Failed to publish message to topic '${TOPIC}': Publish failed`,
    ]);
  });
});

describe('pull_messages', () => {
  it('test_pull_messages', async () => {
    pubsubFake.receivedMessages = [fakeMessage()];

    const result = await runTool(makeToolset(), 'pull_messages', {
      subscription_name: SUBSCRIPTION,
    });

    expect(resultOf(result)).toEqual({
      messages: [
        {
          message_id: '123',
          data: 'Hello',
          attributes: {key: 'value'},
          ordering_key: 'ABC',
          publish_time: '2023-01-01T00:00:00Z',
          ack_id: 'ack_123',
        },
      ],
    });
    expect(pubsubFake.pulls).toEqual([
      {subscription: SUBSCRIPTION, maxMessages: 1},
    ]);
    expect(pubsubFake.acknowledgements).toEqual([]);
  });

  it('test_pull_messages_auto_ack', async () => {
    pubsubFake.receivedMessages = [fakeMessage({attributes: {}})];

    const result = await runTool(makeToolset(), 'pull_messages', {
      subscription_name: SUBSCRIPTION,
      max_messages: 5,
      auto_ack: true,
    });

    expect(resultOf(result)['messages']).toHaveLength(1);
    expect(pubsubFake.pulls).toEqual([
      {subscription: SUBSCRIPTION, maxMessages: 5},
    ]);
    expect(pubsubFake.acknowledgements).toEqual([
      {subscription: SUBSCRIPTION, ackIds: ['ack_123']},
    ]);
  });

  it('test_pull_messages_exception', async () => {
    pubsubFake.failures.pull = new Error('Pull failed');

    const result = await runTool(makeToolset(), 'pull_messages', {
      subscription_name: SUBSCRIPTION,
    });

    expect(errorOf(result)).toBe(
      `Failed to pull messages from subscription '${SUBSCRIPTION}': Pull failed`,
    );
  });
});

describe('acknowledge_messages', () => {
  it('test_acknowledge_messages', async () => {
    const result = await runTool(makeToolset(), 'acknowledge_messages', {
      subscription_name: SUBSCRIPTION,
      ack_ids: ['ack1', 'ack2'],
    });

    expect(resultOf(result)).toEqual({status: 'SUCCESS'});
    expect(pubsubFake.acknowledgements).toEqual([
      {subscription: SUBSCRIPTION, ackIds: ['ack1', 'ack2']},
    ]);
  });

  it('test_acknowledge_messages_exception', async () => {
    pubsubFake.failures.acknowledge = new Error('Ack failed');

    const result = await runTool(makeToolset(), 'acknowledge_messages', {
      subscription_name: SUBSCRIPTION,
      ack_ids: ['ack1'],
    });

    expect(errorOf(result)).toBe(
      'Failed to acknowledge messages on subscription' +
        ` '${SUBSCRIPTION}': Ack failed`,
    );
  });
});

describe('beyond the adk-python suite', () => {
  it('does not acknowledge when auto_ack pulled nothing', async () => {
    pubsubFake.receivedMessages = [];

    const result = await runTool(makeToolset(), 'pull_messages', {
      subscription_name: SUBSCRIPTION,
      auto_ack: true,
    });

    expect(resultOf(result)).toEqual({messages: []});
    expect(pubsubFake.acknowledgements).toEqual([]);
  });

  it('reports no messages when the response omits the field', async () => {
    pubsubFake.receivedMessages = undefined;

    const result = await runTool(makeToolset(), 'pull_messages', {
      subscription_name: SUBSCRIPTION,
    });

    expect(resultOf(result)).toEqual({messages: []});
  });

  it('does not acknowledge a pulled message that carries no ack id', async () => {
    pubsubFake.receivedMessages = [fakeMessage({}, '')];

    await runTool(makeToolset(), 'pull_messages', {
      subscription_name: SUBSCRIPTION,
      auto_ack: true,
    });

    expect(pubsubFake.acknowledgements).toEqual([]);
  });

  it('sends the project id and the ADK attribution to the client', async () => {
    await runTool(makeToolset(), 'publish_message', {
      topic_name: TOPIC,
      message: 'Hello World',
    });

    expect(pubsubFake.publisherOptions[0]).toEqual({
      projectId: 'my_project_id',
      authClient: expect.anything(),
      libName: 'adk-pubsub-tool google-adk',
      libVersion: version,
    });
  });

  it('leaves the project id unset when the config names none', async () => {
    await runTool(makeToolset({}), 'publish_message', {
      topic_name: TOPIC,
      message: 'Hello World',
    });

    expect(pubsubFake.publisherOptions[0]['projectId']).toBeUndefined();
  });

  it('gives each operation its own client', async () => {
    const toolset = makeToolset();

    await runTool(toolset, 'pull_messages', {subscription_name: SUBSCRIPTION});
    await runTool(toolset, 'acknowledge_messages', {
      subscription_name: SUBSCRIPTION,
      ack_ids: ['ack1'],
    });

    expect(pubsubFake.subscriberOptions).toHaveLength(2);
  });

  it.each([
    {
      tool: 'publish_message',
      args: {topic_name: TOPIC, message: 'Hello World'},
      expected: `Failed to publish message to topic '${TOPIC}'`,
    },
    {
      tool: 'pull_messages',
      args: {subscription_name: SUBSCRIPTION},
      expected: `Failed to pull messages from subscription '${SUBSCRIPTION}'`,
    },
    {
      tool: 'acknowledge_messages',
      args: {subscription_name: SUBSCRIPTION, ack_ids: ['ack1']},
      expected: `Failed to acknowledge messages on subscription '${SUBSCRIPTION}'`,
    },
  ])(
    '$tool reports that the user has not authorized yet',
    async ({tool, args, expected}) => {
      const toolset = new PubSubToolset({
        credentialsConfig: {clientId: 'abc', clientSecret: 'def'},
      });

      const result = await runTool(toolset, tool, args);

      expect(errorOf(result)).toBe(
        `${expected}: User authorization is required to access Google` +
          ` services for ${tool}. Please complete the authorization flow.`,
      );
    },
  );

  it('rejects a max_messages the schema does not allow', async () => {
    await expect(
      runTool(makeToolset(), 'pull_messages', {
        subscription_name: SUBSCRIPTION,
        max_messages: 0,
      }),
    ).rejects.toThrow(/Error in tool 'pull_messages'/);
    expect(pubsubFake.pulls).toEqual([]);
  });
});
