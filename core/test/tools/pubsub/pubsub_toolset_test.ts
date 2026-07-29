/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {protos} from '@google-cloud/pubsub';
import {
  BaseAgent,
  BaseTool,
  Context,
  createSession,
  InvocationContext,
  PluginManager,
  PubSubToolset,
  PulledMessage,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * The promise-returning overloads of the gax methods under test.
 *
 * `v1.PublisherClient['publish']` and its siblings are overloaded, and both
 * `vi.fn<T>()` and `vi.mocked()` resolve an overloaded type to its *last*
 * overload — the callback form, which returns `void`. Naming the
 * promise-returning signatures (built entirely from the SDK's own `protos`
 * types) keeps the mocks and their fixtures checked against the wire schema
 * rather than widened.
 */
type PublishFn = (
  request?: protos.google.pubsub.v1.IPublishRequest,
) => Promise<[protos.google.pubsub.v1.IPublishResponse, unknown, unknown]>;

type PullFn = (
  request?: protos.google.pubsub.v1.IPullRequest,
) => Promise<[protos.google.pubsub.v1.IPullResponse, unknown, unknown]>;

type AcknowledgeFn = (
  request?: protos.google.pubsub.v1.IAcknowledgeRequest,
) => Promise<[protos.google.protobuf.IEmpty, unknown, unknown]>;

type CloseFn = () => Promise<void>;

const {publisherClient, subscriberClient} = vi.hoisted(() => ({
  publisherClient: {
    publish: vi.fn<PublishFn>(),
    close: vi.fn<CloseFn>(),
  },
  subscriberClient: {
    pull: vi.fn<PullFn>(),
    acknowledge: vi.fn<AcknowledgeFn>(),
    close: vi.fn<CloseFn>(),
  },
}));

vi.mock('@google-cloud/pubsub', () => ({
  v1: {
    PublisherClient: vi.fn(() => publisherClient),
    SubscriberClient: vi.fn(() => subscriberClient),
  },
}));

/** An empty gax response tuple, for calls whose payload is irrelevant. */
const EMPTY_ACK_RESPONSE: [
  protos.google.protobuf.IEmpty,
  undefined,
  undefined,
] = [{}, undefined, undefined];

function pullResponse(
  ...receivedMessages: protos.google.pubsub.v1.IReceivedMessage[]
): [protos.google.pubsub.v1.IPullResponse, undefined, undefined] {
  return [{receivedMessages}, undefined, undefined];
}

function createToolContext(): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      agent: {name: 'test_agent'} as BaseAgent,
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
    }),
  });
}

describe('PubSubToolset', () => {
  let toolset: PubSubToolset;
  let toolContext: Context;

  /** Resolves a tool by name, failing the test if the toolset omits it. */
  async function getTool(name: string): Promise<BaseTool> {
    const tools = await toolset.getTools();
    const tool = tools.find((candidate) => candidate.name === name);
    expect(tool, `toolset should expose a '${name}' tool`).toBeDefined();
    return tool!;
  }

  beforeEach(() => {
    // Clear mock histories to ensure tests don't overlap singleton logic counts
    vi.clearAllMocks();

    toolset = new PubSubToolset({
      credentialsConfig: {projectId: 'test-project-auth'},
    });
    toolContext = createToolContext();
  });

  afterEach(async () => {
    await toolset.close();
  });

  it('should return publish, pull, and acknowledge tools', async () => {
    const tools = await toolset.getTools();
    expect(tools.map((tool) => tool.name)).toEqual([
      'publish_message',
      'pull_messages',
      'acknowledge_messages',
    ]);
  });

  it('should apply a string toolFilter', async () => {
    const filtered = new PubSubToolset({toolFilter: ['pull_messages']});
    const tools = await filtered.getTools();
    expect(tools.map((tool) => tool.name)).toEqual(['pull_messages']);
    await filtered.close();
  });

  it('should not construct a client until a tool is invoked', async () => {
    await toolset.getTools();
    expect(publisherClient.publish).not.toHaveBeenCalled();
    expect(subscriberClient.pull).not.toHaveBeenCalled();
  });

  describe('publishMessage tool', () => {
    it('should successfully publish a message', async () => {
      const publishTool = await getTool('publish_message');
      publisherClient.publish.mockResolvedValue([
        {messageIds: ['msg-123']},
        undefined,
        undefined,
      ]);

      const result = await publishTool.runAsync({
        args: {topicName: 'test-topic', message: 'hello world'},
        toolContext,
      });

      expect(result).toEqual({messageId: 'msg-123'});
      expect(publisherClient.publish).toHaveBeenCalledWith(
        expect.objectContaining({topic: 'test-topic'}),
      );
    });

    it('should forward attributes and orderingKey', async () => {
      const publishTool = await getTool('publish_message');
      publisherClient.publish.mockResolvedValue([
        {messageIds: ['msg-123']},
        undefined,
        undefined,
      ]);

      await publishTool.runAsync({
        args: {
          topicName: 'test-topic',
          message: 'hello world',
          attributes: {key: 'val'},
          orderingKey: 'order-1',
        },
        toolContext,
      });

      expect(publisherClient.publish).toHaveBeenCalledWith({
        topic: 'test-topic',
        messages: [
          {
            data: Buffer.from('hello world', 'utf8'),
            attributes: {key: 'val'},
            orderingKey: 'order-1',
          },
        ],
      });
    });

    it('should reject arguments that do not match the schema', async () => {
      const publishTool = await getTool('publish_message');

      await expect(
        publishTool.runAsync({args: {topicName: 'test-topic'}, toolContext}),
      ).rejects.toThrow("Error in tool 'publish_message'");
      expect(publisherClient.publish).not.toHaveBeenCalled();
    });

    it('should return ERROR status when publish fails', async () => {
      const publishTool = await getTool('publish_message');
      publisherClient.publish.mockRejectedValue(new Error('Publish timeout'));

      const result = (await publishTool.runAsync({
        args: {topicName: 'test-topic', message: 'hello world'},
        toolContext,
      })) as {status?: string; error_details?: string};

      expect(result.status).toEqual('ERROR');
      expect(result.error_details).toContain('Publish timeout');
    });
  });

  describe('pullMessages tool', () => {
    it('should successfully pull messages', async () => {
      const pullTool = await getTool('pull_messages');
      subscriberClient.pull.mockResolvedValue(
        pullResponse({
          ackId: 'ack-123',
          message: {
            messageId: 'msg-123',
            data: Buffer.from('hello from sub', 'utf8'),
            attributes: {key: 'val'},
            publishTime: {seconds: 1672531200, nanos: 0},
          },
        }),
      );

      const result = (await pullTool.runAsync({
        args: {subscriptionName: 'test-sub', maxMessages: 5, autoAck: false},
        toolContext,
      })) as {messages?: PulledMessage[]};

      expect(result.messages).toEqual([
        {
          messageId: 'msg-123',
          data: 'hello from sub',
          attributes: {key: 'val'},
          orderingKey: '',
          publishTime: '2023-01-01T00:00:00.000Z',
          ackId: 'ack-123',
        },
      ]);
    });

    it('should omit publishTime when the server did not supply one', async () => {
      const pullTool = await getTool('pull_messages');
      subscriberClient.pull.mockResolvedValue(
        pullResponse({
          ackId: 'ack-123',
          message: {messageId: 'msg-123', data: Buffer.from('hi', 'utf8')},
        }),
      );

      const result = (await pullTool.runAsync({
        args: {subscriptionName: 'test-sub'},
        toolContext,
      })) as {messages?: PulledMessage[]};

      expect(result.messages?.[0].publishTime).toBeUndefined();
    });

    it('should convert a string-encoded publishTime', async () => {
      const pullTool = await getTool('pull_messages');
      // `ITimestamp.seconds` is `number | Long | string`; gax hands back the
      // string form for 64-bit fields.
      subscriberClient.pull.mockResolvedValue(
        pullResponse({
          ackId: 'ack-123',
          message: {
            messageId: 'msg-123',
            data: Buffer.from('hi', 'utf8'),
            publishTime: {seconds: '1672531200', nanos: 500_000_000},
          },
        }),
      );

      const result = (await pullTool.runAsync({
        args: {subscriptionName: 'test-sub'},
        toolContext,
      })) as {messages?: PulledMessage[]};

      expect(result.messages?.[0].publishTime).toEqual(
        '2023-01-01T00:00:00.500Z',
      );
    });

    it('should omit publishTime when seconds is not representable', async () => {
      const pullTool = await getTool('pull_messages');
      subscriberClient.pull.mockResolvedValue(
        pullResponse({
          ackId: 'ack-123',
          message: {
            messageId: 'msg-123',
            data: Buffer.from('hi', 'utf8'),
            publishTime: {seconds: 'not-a-timestamp'},
          },
        }),
      );

      const result = (await pullTool.runAsync({
        args: {subscriptionName: 'test-sub'},
        toolContext,
      })) as {messages?: PulledMessage[]; status?: string};

      // Previously this reached `new Date(NaN).toISOString()`, which throws
      // `RangeError` and surfaced as a generic ERROR result.
      expect(result.status).toBeUndefined();
      expect(result.messages?.[0].publishTime).toBeUndefined();
    });

    it('should keep a publishTime of epoch zero', async () => {
      const pullTool = await getTool('pull_messages');
      subscriberClient.pull.mockResolvedValue(
        pullResponse({
          ackId: 'ack-123',
          message: {
            messageId: 'msg-123',
            data: Buffer.from('hi', 'utf8'),
            publishTime: {seconds: 0, nanos: 0},
          },
        }),
      );

      const result = (await pullTool.runAsync({
        args: {subscriptionName: 'test-sub'},
        toolContext,
      })) as {messages?: PulledMessage[]};

      expect(result.messages?.[0].publishTime).toEqual(
        '1970-01-01T00:00:00.000Z',
      );
    });

    it('should autoAck messages if autoAck is true', async () => {
      const pullTool = await getTool('pull_messages');
      subscriberClient.pull.mockResolvedValue(
        pullResponse({
          ackId: 'ack-123',
          message: {messageId: 'msg-123', data: Buffer.from('hello', 'utf8')},
        }),
      );
      subscriberClient.acknowledge.mockResolvedValue(EMPTY_ACK_RESPONSE);

      await pullTool.runAsync({
        args: {subscriptionName: 'test-sub', maxMessages: 1, autoAck: true},
        toolContext,
      });

      expect(subscriberClient.acknowledge).toHaveBeenCalledWith({
        subscription: 'test-sub',
        ackIds: ['ack-123'],
      });
    });

    it('should reject a non-numeric maxMessages', async () => {
      const pullTool = await getTool('pull_messages');

      await expect(
        pullTool.runAsync({
          args: {subscriptionName: 'test-sub', maxMessages: 'five'},
          toolContext,
        }),
      ).rejects.toThrow("Error in tool 'pull_messages'");
      expect(subscriberClient.pull).not.toHaveBeenCalled();
    });

    it('should return ERROR status when pull fails', async () => {
      const pullTool = await getTool('pull_messages');
      subscriberClient.pull.mockRejectedValue(new Error('Pull timeout'));

      const result = (await pullTool.runAsync({
        args: {subscriptionName: 'test-sub'},
        toolContext,
      })) as {status?: string; error_details?: string};

      expect(result.status).toEqual('ERROR');
      expect(result.error_details).toContain('Pull timeout');
    });
  });

  describe('acknowledgeMessages tool', () => {
    it('should successfully acknowledge messages', async () => {
      const ackTool = await getTool('acknowledge_messages');
      subscriberClient.acknowledge.mockResolvedValue(EMPTY_ACK_RESPONSE);

      const result = (await ackTool.runAsync({
        args: {subscriptionName: 'test-sub', ackIds: ['ack-1', 'ack-2']},
        toolContext,
      })) as {status?: string};

      expect(result.status).toEqual('SUCCESS');
      expect(subscriberClient.acknowledge).toHaveBeenCalledWith({
        subscription: 'test-sub',
        ackIds: ['ack-1', 'ack-2'],
      });
    });

    it('should reject a string ackIds instead of coercing it', async () => {
      const ackTool = await getTool('acknowledge_messages');

      await expect(
        ackTool.runAsync({
          args: {subscriptionName: 'test-sub', ackIds: 'ack-1'},
          toolContext,
        }),
      ).rejects.toThrow("Error in tool 'acknowledge_messages'");
      expect(subscriberClient.acknowledge).not.toHaveBeenCalled();
    });

    it('should return ERROR status when acknowledge fails', async () => {
      const ackTool = await getTool('acknowledge_messages');
      subscriberClient.acknowledge.mockRejectedValue(new Error('Ack timeout'));

      const result = (await ackTool.runAsync({
        args: {subscriptionName: 'test-sub', ackIds: ['ack-1']},
        toolContext,
      })) as {status?: string; error_details?: string};

      expect(result.status).toEqual('ERROR');
      expect(result.error_details).toContain('Ack timeout');
    });
  });
});
